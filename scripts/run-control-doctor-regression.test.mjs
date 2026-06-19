import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { buildRunControlDoctorReport, formatRunControlDoctorReport, loadRunControlDoctorRegistry } from "../dist/run-control/doctor.js";

function createRun(id, status = "running", extra = {}) {
  const now = new Date(0).toISOString();
  return {
    runId: id,
    logicalThreadId: `thread-${id}`,
    threadId: `thread-${id}`,
    kind: "discord-thread",
    status,
    sourceDiscordMessageId: `source-${id}`,
    placeholderDiscordMessageId: `placeholder-${id}`,
    prompt: `prompt ${id}`,
    promptPreview: `prompt ${id}`,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

test("run-control doctor registry loader is read-only", async () => {
  const missingDir = await mkdtemp(join(tmpdir(), "pi-discord-doctor-missing-"));
  const missingConfig = defaultConfig();
  missingConfig.dataDir = missingDir;

  const missingRegistry = await loadRunControlDoctorRegistry(missingConfig);

  assert.deepEqual(missingRegistry.listThreads(), []);
  assert.equal(existsSync(join(missingDir, "registry.json")), false);

  const existingDir = await mkdtemp(join(tmpdir(), "pi-discord-doctor-existing-"));
  const registryPath = join(existingDir, "registry.json");
  const registryJson = `${JSON.stringify({
    version: 1,
    threads: {
      "thread-1": {
        threadId: "thread-1",
        kind: "discord-thread",
        cwd: process.cwd(),
        status: "running",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    },
    messages: {},
    linkIngests: {},
  }, null, 2)}\n`;
  await writeFile(registryPath, registryJson, "utf8");
  const existingConfig = defaultConfig();
  existingConfig.dataDir = existingDir;

  const existingRegistry = await loadRunControlDoctorRegistry(existingConfig);

  assert.equal(existingRegistry.getThread("thread-1")?.status, "running");
  assert.equal(await readFile(registryPath, "utf8"), registryJson);
});

test("run-control doctor bounds daemon stderr tail reads", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-doctor-stderr-"));
  const stderrPath = join(dataDir, "daemon.err.log");
  const lines = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
  await writeFile(stderrPath, `${lines.join("\n")}\n`, "utf8");
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.dataDir = dataDir;
  const store = {
    listRuns: async () => [],
    listActivePointers: async () => [],
    getRun: async () => undefined,
    getRunLeaseTtl: async () => -2,
    getJobQueueSummary: async () => ({ pendingCount: 0, consumers: [] }),
    listWorkers: async () => [],
    clearActiveIfMatches: async () => false,
    markTerminal: async () => undefined,
    patchRun: async () => undefined,
  };
  const registry = { getThread: () => undefined, listThreads: () => [] };

  const report = await buildRunControlDoctorReport({ store, registry, config, stderrPath, stderrTailLines: 3 });
  const text = formatRunControlDoctorReport(report);

  assert.equal(report.daemonStderr.truncated, true);
  assert.deepEqual(report.daemonStderr.tail, ["line-9997", "line-9998", "line-9999"]);
  assert.match(text, /tailBytes=65536/);
  assert.doesNotMatch(text, /line-0/);
});

test("run-control doctor report includes active pointers, pending jobs, workers, outbox, dead letters, reconcile, and stderr", async () => {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.dataDir = process.cwd();
  const activeRun = createRun("active", "running", { logicalThreadId: "thread-active", threadId: "thread-active", workerId: "worker-1" });
  const outboxRun = createRun("outbox", "succeeded", {
    logicalThreadId: "thread-outbox",
    threadId: "thread-outbox",
    finalDiscordOutboxStartedAt: "2026-01-01T00:00:00.000Z",
    finalDiscordChunkCount: 2,
    finalDiscordMessageIds: ["m1", "m2"],
    finalDiscordReservedAt: "2026-01-01T00:00:01.000Z",
    finalDiscordPostedAt: "2026-01-01T00:00:02.000Z",
    placeholderRetiredAt: "2026-01-01T00:00:03.000Z",
  });
  const deadRun = createRun("dead", "interrupted", {
    logicalThreadId: "thread-dead",
    threadId: "thread-dead",
    retryLaterCount: 12,
    deadLetteredAt: "2026-01-01T00:00:04.000Z",
    deadLetterReason: "too many retries",
    placeholderRetiredAt: "2026-01-01T00:00:05.000Z",
  });
  const runs = [activeRun, outboxRun, deadRun];
  const store = {
    listRuns: async () => runs,
    listActivePointers: async () => [{ logicalThreadId: "thread-active", runId: "active" }],
    getRun: async (runId) => runs.find((run) => run.runId === runId),
    getRunLeaseTtl: async () => 1234,
    getJobQueueSummary: async () => ({
      pendingCount: 1,
      firstPendingId: "1-0",
      lastPendingId: "1-0",
      consumers: [{ name: "worker-1", pending: 1 }],
    }),
    listWorkers: async () => [
      { workerId: "worker-1", status: "running", runId: "active", updatedAt: "2026-01-01T00:00:06.000Z", ttlMs: 1000 },
      { workerId: "worker-2", status: "idle", runId: "stale-run", updatedAt: "2026-01-01T00:00:07.000Z", ttlMs: 1000 },
    ],
    clearActiveIfMatches: async () => false,
    markTerminal: async () => undefined,
    patchRun: async () => undefined,
  };
  const registry = {
    getThread: (threadId) => ({ threadId, status: threadId === "thread-active" ? "running" : "idle", activeRun: threadId === "thread-active" ? { runId: "active" } : undefined }),
    listThreads: () => [{ threadId: "thread-active", status: "running", activeRun: { runId: "active" } }],
  };

  const report = await buildRunControlDoctorReport({
    store,
    registry,
    config,
    stderrPath: "/definitely/missing/daemon.err.log",
    stderrTailLines: 5,
  });
  const text = formatRunControlDoctorReport(report);

  assert.match(text, /activePointers: 1/);
  assert.match(text, /thread-active -> active status=running worker=worker-1 leaseTtlMs=1234/);
  assert.match(text, /pendingJobs: 1 first=1-0 last=1-0/);
  assert.match(text, /consumer worker-1 pending=1/);
  assert.match(text, /workers: 2/);
  assert.match(text, /worker-1 status=running run=active/);
  assert.match(text, /worker-2 status=idle run=none staleRun=stale-run/);
  assert.match(text, /outboxRuns: 1/);
  assert.match(text, /outbox status=succeeded chunks=2 ids=2/);
  assert.match(text, /deadLetteredRuns: 1/);
  assert.match(text, /dead status=interrupted retryLater=12/);
  assert.match(text, /reconcileIssues: 0/);
  assert.match(text, /daemonStderr: .*daemon\.err\.log lines=0 error=/);
});
