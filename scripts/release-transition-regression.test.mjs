import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import {
  classifyDeploySafety,
  formatDeploySafetyReport,
} from "../dist/run-control/inspection.js";
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
