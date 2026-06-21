import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import {
  classifyDeploySafety,
  formatDeploySafetyReport,
} from "../dist/run-control/inspection.js";
import { runReleaseDeployCommand, runReleaseRollbackCommand } from "../dist/release-deploy.js";
import { runReleaseDeployTransition } from "../dist/release-transition.js";

function config() {
  const value = defaultConfig();
  value.runControl.enabled = true;
  value.runControl.leaseTtlMs = 60_000;
  return value;
}

function snapshot(overrides = {}) {
  return {
    checkedAt: "2026-06-20T00:00:00.000Z",
    activeRuns: [],
    pendingJobs: { pendingCount: 0, consumers: [] },
    workers: [],
    deadLetteredRuns: [],
    reconcileIssues: [],
    ...overrides,
  };
}

function activeRun(overrides = {}) {
  return {
    logicalThreadId: "thread-1",
    runId: "run-1",
    status: "running",
    workerId: "worker-1",
    leaseTtlMs: 30_000,
    ...overrides,
  };
}

test("deploy safety is safe when preflight and postflight are idle", () => {
  const report = classifyDeploySafety({
    config: config(),
    before: snapshot(),
    after: snapshot(),
    elapsedMs: 0,
  });

  assert.equal(report.status, "safe");
  assert.deepEqual(report.reasons.map((reason) => reason.code), ["idle-postflight"]);
  assert.match(formatDeploySafetyReport(report), /deploy safety: safe/);
});

test("deploy safety waits for preserved active work with expired lease inside the reclaim window", () => {
  const report = classifyDeploySafety({
    config: config(),
    before: snapshot({ activeRuns: [activeRun({ leaseTtlMs: 10_000 })] }),
    after: snapshot({ activeRuns: [activeRun({ leaseTtlMs: -2 })] }),
    elapsedMs: 5_000,
  });

  assert.equal(report.status, "waiting");
  assert.deepEqual(report.reasons.map((reason) => reason.code), ["active-run-awaiting-reclaim"]);
  assert.match(formatDeploySafetyReport(report), /active-run-awaiting-reclaim/);
});

test("deploy safety becomes unknown when an expired active lease outlives the reclaim window", () => {
  const report = classifyDeploySafety({
    config: config(),
    before: snapshot({ activeRuns: [activeRun({ leaseTtlMs: 10_000 })] }),
    after: snapshot({ activeRuns: [activeRun({ leaseTtlMs: -2 })] }),
    elapsedMs: 61_000,
  });

  assert.equal(report.status, "unknown");
  assert.deepEqual(report.reasons.map((reason) => reason.code), ["active-run-lease-still-expired"]);
});

test("deploy safety is unsafe when a preflight active run disappears", () => {
  const report = classifyDeploySafety({
    config: config(),
    before: snapshot({ activeRuns: [activeRun()] }),
    after: snapshot(),
    elapsedMs: 61_000,
  });

  assert.equal(report.status, "unsafe");
  assert.deepEqual(report.reasons.map((reason) => reason.code), ["preflight-run-missing-postflight"]);
});

test("deploy safety is unsafe when a new dead-letter appears after restart", () => {
  const report = classifyDeploySafety({
    config: config(),
    before: snapshot(),
    after: snapshot({ deadLetteredRuns: [{ runId: "dead-1", status: "interrupted", deadLetteredAt: "2026-06-20T00:00:01.000Z" }] }),
    elapsedMs: 61_000,
  });

  assert.equal(report.status, "unsafe");
  assert.deepEqual(report.reasons.map((reason) => reason.code), ["new-dead-lettered-run"]);
});

test("release deploy transition is guard-first before canary, activation, plist write, and restart", async () => {
  const calls = [];
  const before = snapshot();
  const after = snapshot({ checkedAt: "2026-06-20T00:00:05.000Z" });
  const result = await runReleaseDeployTransition({
    config: config(),
    configPath: "/tmp/pi-discord-config.json",
    target: "release-1",
    roles: ["bot", "worker"],
    force: false,
    adapters: {
      release: {
        async canary(input) {
          calls.push(`canary:${input.target}`);
          return { releaseId: input.target, summary: "canary ok" };
        },
        async activate(input) {
          calls.push(`activate:${input.target}`);
          return { releaseId: input.target, previousReleaseId: "release-0" };
        },
      },
      launchAgent: {
        async assertOutsideDaemon() {
          calls.push("assertOutsideDaemon");
          return { checkedAt: "2026-06-20T00:00:01.000Z" };
        },
        async writePlist(input) {
          calls.push(`writePlist:${input.roles.join(",")}:${input.guard.checkedAt}`);
          return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
        },
        async restart(input) {
          calls.push(`restart:${String(input.force)}:${input.guard.checkedAt}`);
          return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
        },
      },
      runtime: {
        async inspect(input) {
          calls.push(`inspect:${input.phase}`);
          return input.phase === "preflight" ? before : after;
        },
        classify(input) {
          calls.push("classify");
          return classifyDeploySafety(input);
        },
      },
    },
  });

  assert.equal(result.outcome, "safe");
  assert.equal(result.safety.status, "safe");
  assert.deepEqual(calls, [
    "inspect:preflight",
    "assertOutsideDaemon",
    "canary:release-1",
    "activate:release-1",
    "writePlist:bot,worker:2026-06-20T00:00:01.000Z",
    "restart:false:2026-06-20T00:00:01.000Z",
    "inspect:postflight",
    "classify",
  ]);
});

test("release deploy transition stops before mutation when the daemon guard fails", async () => {
  const calls = [];
  await assert.rejects(
    () => runReleaseDeployTransition({
      config: config(),
      configPath: "/tmp/pi-discord-config.json",
      target: "release-1",
      adapters: {
        release: {
          async canary() {
            calls.push("canary");
            return { releaseId: "release-1" };
          },
          async activate() {
            calls.push("activate");
            return { releaseId: "release-1" };
          },
        },
        launchAgent: {
          async assertOutsideDaemon() {
            calls.push("assertOutsideDaemon");
            throw new Error("inside active daemon");
          },
          async writePlist() {
            calls.push("writePlist");
            return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
          },
          async restart() {
            calls.push("restart");
            return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
          },
        },
        runtime: {
          async inspect(input) {
            calls.push(`inspect:${input.phase}`);
            return snapshot();
          },
          classify(input) {
            return classifyDeploySafety(input);
          },
        },
      },
    }),
    /inside active daemon/,
  );

  assert.deepEqual(calls, ["inspect:preflight", "assertOutsideDaemon"]);
});

test("release deploy transition rolls back when postflight is unsafe and a previous release exists", async () => {
  const calls = [];
  const unsafeAfter = snapshot({ deadLetteredRuns: [{ runId: "run-1", status: "interrupted", deadLetteredAt: "2026-06-20T00:00:01.000Z" }] });
  const result = await runReleaseDeployTransition({
    config: config(),
    configPath: "/tmp/pi-discord-config.json",
    target: "release-1",
    adapters: {
      release: {
        async canary(input) {
          calls.push(`canary:${input.target}`);
          return { releaseId: input.target };
        },
        async activate(input) {
          calls.push(`activate:${input.target}`);
          return { releaseId: input.target, previousReleaseId: "release-0" };
        },
        async rollback(input) {
          calls.push(`rollback:${input.target}:${input.reason.status}`);
          return {
            releaseId: input.target,
            safety: classifyDeploySafety({ config: config(), before: snapshot(), after: snapshot(), elapsedMs: 0 }),
            summary: "rolled back",
          };
        },
      },
      launchAgent: {
        async assertOutsideDaemon() {
          calls.push("assertOutsideDaemon");
          return { checkedAt: "2026-06-20T00:00:01.000Z" };
        },
        async writePlist() {
          calls.push("writePlist");
          return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
        },
        async restart() {
          calls.push("restart");
          return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
        },
      },
      runtime: {
        async inspect(input) {
          calls.push(`inspect:${input.phase}`);
          return input.phase === "preflight" ? snapshot() : unsafeAfter;
        },
        classify(input) {
          calls.push("classify");
          return classifyDeploySafety(input);
        },
      },
    },
  });

  assert.equal(result.outcome, "rolled-back");
  assert.equal(result.safety.status, "unsafe");
  assert.equal(result.rollback?.releaseId, "release-0");
  assert.deepEqual(calls, [
    "inspect:preflight",
    "assertOutsideDaemon",
    "canary:release-1",
    "activate:release-1",
    "writePlist",
    "restart",
    "inspect:postflight",
    "classify",
    "rollback:release-0:unsafe",
  ]);
});

test("release deploy transition rolls back when restart fails after activation", async () => {
  const calls = [];
  await assert.rejects(
    () => runReleaseDeployTransition({
      config: config(),
      configPath: "/tmp/pi-discord-config.json",
      target: "release-1",
      now: () => new Date("2026-06-20T00:00:04.000Z"),
      adapters: {
        release: {
          async canary(input) {
            calls.push(`canary:${input.target}`);
            return { releaseId: input.target };
          },
          async activate(input) {
            calls.push(`activate:${input.target}`);
            return { releaseId: input.target, previousReleaseId: "release-0" };
          },
          async rollback(input) {
            calls.push(`rollback:${input.target}:${input.reason.status}:${input.reason.reasons[0]?.code}`);
            return {
              releaseId: input.target,
              safety: classifyDeploySafety({ config: config(), before: snapshot(), after: snapshot(), elapsedMs: 0 }),
              summary: "rolled back",
            };
          },
        },
        launchAgent: {
          async assertOutsideDaemon() {
            calls.push("assertOutsideDaemon");
            return { checkedAt: "2026-06-20T00:00:01.000Z" };
          },
          async writePlist() {
            calls.push("writePlist");
            return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
          },
          async restart() {
            calls.push("restart");
            throw new Error("restart failed");
          },
        },
        runtime: {
          async inspect(input) {
            calls.push(`inspect:${input.phase}`);
            return snapshot();
          },
          classify(input) {
            return classifyDeploySafety(input);
          },
        },
      },
    }),
    /restart failed; automatic rollback to release-0 completed/,
  );

  assert.deepEqual(calls, [
    "inspect:preflight",
    "assertOutsideDaemon",
    "canary:release-1",
    "activate:release-1",
    "writePlist",
    "restart",
    "rollback:release-0:unknown:transition-failed-after-activation",
  ]);
});

test("release deploy transition derives elapsed time from preflight and postflight inspections", async () => {
  const calls = [];
  const before = snapshot({
    checkedAt: "2026-06-20T00:00:00.000Z",
    activeRuns: [activeRun({ leaseTtlMs: 10_000 })],
  });
  const after = snapshot({
    checkedAt: "2026-06-20T00:01:01.000Z",
    activeRuns: [activeRun({ leaseTtlMs: -2 })],
  });
  const result = await runReleaseDeployTransition({
    config: config(),
    configPath: "/tmp/pi-discord-config.json",
    target: "release-1",
    adapters: {
      release: {
        async canary(input) {
          calls.push(`canary:${input.target}`);
          return { releaseId: input.target };
        },
        async activate(input) {
          calls.push(`activate:${input.target}`);
          return { releaseId: input.target, previousReleaseId: "release-0" };
        },
        async rollback(input) {
          calls.push(`rollback:${input.target}:${input.reason.status}:${input.reason.reasons[0]?.code}`);
          return {
            releaseId: input.target,
            safety: classifyDeploySafety({ config: config(), before: snapshot(), after: snapshot(), elapsedMs: 0 }),
          };
        },
      },
      launchAgent: {
        async assertOutsideDaemon() {
          calls.push("assertOutsideDaemon");
          return { checkedAt: "2026-06-20T00:00:01.000Z" };
        },
        async writePlist() {
          calls.push("writePlist");
          return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
        },
        async restart() {
          calls.push("restart");
          return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
        },
      },
      runtime: {
        async inspect(input) {
          return input.phase === "preflight" ? before : after;
        },
        classify(input) {
          calls.push(`classify:${input.elapsedMs}`);
          return classifyDeploySafety(input);
        },
      },
    },
  });

  assert.equal(result.outcome, "rolled-back");
  assert.equal(result.safety.status, "unknown");
  assert.deepEqual(calls, [
    "assertOutsideDaemon",
    "canary:release-1",
    "activate:release-1",
    "writePlist",
    "restart",
    "classify:61000",
    "rollback:release-0:unknown:active-run-lease-still-expired",
  ]);
});

test("public deploy command guards before build or snapshot", async () => {
  const calls = [];
  await assert.rejects(
    () => runReleaseDeployCommand({
      config: config(),
      configPath: "/tmp/pi-discord-config.json",
      projectRoot: "/tmp/project",
    }, {
      async assertDeployAuthority() {
        calls.push("prebuildGuard");
        throw new Error("inside active daemon");
      },
      async build(input) {
        calls.push(`build:${input.projectRoot}`);
        return { command: "npm run build", cwd: input.projectRoot };
      },
      async createSnapshot() {
        calls.push("snapshot");
        throw new Error("should not snapshot");
      },
    }),
    /inside active daemon/,
  );

  assert.deepEqual(calls, ["prebuildGuard"]);
});

test("public deploy command builds, snapshots, and runs the transition through fake adapters", async () => {
  const calls = [];
  const result = await runReleaseDeployCommand({
    config: config(),
    configPath: "/tmp/pi-discord-config.json",
    projectRoot: "/tmp/project",
  }, {
    async assertDeployAuthority(input) {
      calls.push(`prebuildGuard:${input.roles.join(",")}`);
    },
    async build(input) {
      calls.push(`build:${input.projectRoot}`);
      return { command: "npm run build", cwd: input.projectRoot };
    },
    async createSnapshot(input) {
      calls.push(`snapshot:${input.allowDirty}:${input.projectRoot}`);
      return {
        releaseId: "release-1",
        releasePath: "/tmp/releases/release-1",
        manifestPath: "/tmp/releases/release-1/manifest.json",
        ledgerPath: "/tmp/releases/ledger.jsonl",
        manifest: { releaseId: "release-1", distSha256: "a".repeat(64), shortCommit: "abcdef1" },
      };
    },
    transitionAdapters: {
      release: {
        async canary(input) {
          calls.push(`canary:${input.target}`);
          return { releaseId: input.target };
        },
        async activate(input) {
          calls.push(`activate:${input.target}`);
          return { releaseId: input.target, previousReleaseId: "release-0" };
        },
      },
      launchAgent: {
        async assertOutsideDaemon() {
          calls.push("guard");
          return { checkedAt: "2026-06-20T00:00:01.000Z" };
        },
        async writePlist() {
          calls.push("writePlist");
          return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
        },
        async restart() {
          calls.push("restart");
          return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
        },
      },
      runtime: {
        async inspect(input) {
          calls.push(`inspect:${input.phase}`);
          return snapshot({ checkedAt: input.phase === "preflight" ? "2026-06-20T00:00:00.000Z" : "2026-06-20T00:00:03.000Z" });
        },
        classify(input) {
          calls.push(`classify:${input.elapsedMs}`);
          return classifyDeploySafety(input);
        },
      },
    },
    async recordDeploy(input) {
      calls.push(`recordDeploy:${input.releaseId}:${input.outcome}:${input.safety.status}`);
    },
  });

  assert.equal(result.releaseId, "release-1");
  assert.equal(result.transition.outcome, "safe");
  assert.deepEqual(calls, [
    "prebuildGuard:bot,worker,reconcile",
    "build:/tmp/project",
    "snapshot:false:/tmp/project",
    "inspect:preflight",
    "guard",
    "canary:release-1",
    "activate:release-1",
    "writePlist",
    "restart",
    "inspect:postflight",
    "classify:3000",
    "recordDeploy:release-1:safe:safe",
  ]);
});

test("public deploy command records a redacted failed deploy event when transition throws", async () => {
  const calls = [];
  await assert.rejects(
    () => runReleaseDeployCommand({
      config: config(),
      configPath: "/tmp/pi-discord-config.json",
      projectRoot: "/tmp/project",
    }, {
      async assertDeployAuthority() {
        calls.push("prebuildGuard");
      },
      async build(input) {
        calls.push(`build:${input.projectRoot}`);
        return { command: "npm run build", cwd: input.projectRoot };
      },
      async createSnapshot() {
        calls.push("snapshot");
        return {
          releaseId: "release-1",
          releasePath: "/tmp/releases/release-1",
          manifestPath: "/tmp/releases/release-1/manifest.json",
          ledgerPath: "/tmp/releases/ledger.jsonl",
          manifest: { releaseId: "release-1", distSha256: "a".repeat(64), shortCommit: "abcdef1" },
        };
      },
      transitionAdapters: {
        release: {
          async canary(input) {
            calls.push(`canary:${input.target}`);
            return { releaseId: input.target };
          },
          async activate(input) {
            calls.push(`activate:${input.target}`);
            return { releaseId: input.target, previousReleaseId: "release-0" };
          },
        },
        launchAgent: {
          async assertOutsideDaemon() {
            calls.push("guard");
            return { checkedAt: "2026-06-20T00:00:01.000Z" };
          },
          async writePlist() {
            calls.push("writePlist");
            return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
          },
          async restart() {
            calls.push("restart");
            throw new Error("restart failed");
          },
        },
        runtime: {
          async inspect(input) {
            calls.push(`inspect:${input.phase}`);
            return snapshot();
          },
          classify(input) {
            return classifyDeploySafety(input);
          },
        },
      },
      async recordDeploy(input) {
        calls.push(`recordDeploy:${input.releaseId}:${input.outcome}:${input.errorCode}`);
      },
    }),
    /restart failed/,
  );

  assert.deepEqual(calls, [
    "prebuildGuard",
    "build:/tmp/project",
    "snapshot",
    "inspect:preflight",
    "guard",
    "canary:release-1",
    "activate:release-1",
    "writePlist",
    "restart",
    "recordDeploy:release-1:failed:transition-error",
  ]);
});

test("public rollback command guards before config restore, current flip, plist write, and restart", async () => {
  const calls = [];
  const currentConfig = config();
  currentConfig.runControl.roles = ["bot"];
  const restoredConfig = config();
  restoredConfig.runControl.roles = ["worker"];
  const result = await runReleaseRollbackCommand({
    config: currentConfig,
    configPath: "/tmp/pi-discord-config.json",
    target: "release-0",
  }, {
    release: {
      async canary(input) {
        calls.push(`canary:${input.target}`);
        return { releaseId: input.target };
      },
      async restoreConfig(input) {
        calls.push(`restoreConfig:${input.target}`);
        return { backupPath: "/tmp/config.backup", releaseId: input.target };
      },
      async activate(input) {
        calls.push(`activate:${input.target}`);
        return { releaseId: input.target, previousReleaseId: "release-1" };
      },
    },
    launchAgent: {
      async assertOutsideDaemon() {
        calls.push("guard");
        return { checkedAt: "2026-06-20T00:00:01.000Z" };
      },
      async writePlist(input) {
        calls.push(`writePlist:${input.roles.join(",")}:${input.guard.checkedAt}`);
        return { plistPath: "/tmp/agent.plist", entryPath: "/tmp/current/dist/index.js" };
      },
      async restart(input) {
        calls.push(`restart:${input.guard.checkedAt}`);
        return { serviceTarget: "gui/501/com.joelhooks.pi-discord-threads" };
      },
    },
    runtime: {
      async inspect(input) {
        calls.push(`inspect:${input.phase}`);
        return snapshot({ checkedAt: input.phase === "preflight" ? "2026-06-20T00:00:00.000Z" : "2026-06-20T00:00:02.000Z" });
      },
      classify(input) {
        calls.push(`classify:${input.elapsedMs}`);
        return classifyDeploySafety(input);
      },
    },
    async loadConfig() {
      calls.push("loadConfig");
      return restoredConfig;
    },
    async recordRollback(input) {
      calls.push(`recordRollback:${input.releaseId}:${input.result.safety.status}`);
    },
  });

  assert.equal(result.releaseId, "release-0");
  assert.equal(result.safety.status, "safe");
  assert.deepEqual(calls, [
    "inspect:preflight",
    "guard",
    "canary:release-0",
    "restoreConfig:release-0",
    "loadConfig",
    "activate:release-0",
    "writePlist:worker:2026-06-20T00:00:01.000Z",
    "restart:2026-06-20T00:00:01.000Z",
    "inspect:postflight",
    "classify:2000",
    "recordRollback:release-0:safe",
  ]);
});
