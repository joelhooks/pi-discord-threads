import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFromRunControlReadModel } from "../dist/run-control/inspection.js";
import { loadRunControlReadModel } from "../dist/run-control/read-model.js";

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

test("run-control read model re-reads active pointer runs that appear between Redis scans", async () => {
  const freshRun = createRun("fresh", "running", { logicalThreadId: "thread-fresh", workerId: "worker-1" });
  const calls = [];
  const store = {
    async listRuns() {
      calls.push("listRuns");
      return [];
    },
    async listActivePointers() {
      calls.push("listActivePointers");
      return [{ logicalThreadId: freshRun.logicalThreadId, runId: freshRun.runId }];
    },
    async getRun(runId) {
      calls.push(`getRun:${runId}`);
      return runId === freshRun.runId ? freshRun : undefined;
    },
    async getRunLeaseTtl(runId) {
      calls.push(`getRunLeaseTtl:${runId}`);
      return 1234;
    },
    async getJobQueueSummary() {
      calls.push("getJobQueueSummary");
      return { pendingCount: 0, consumers: [] };
    },
    async listWorkers() {
      calls.push("listWorkers");
      return [];
    },
  };

  const model = await loadRunControlReadModel(store, { checkedAt: "2026-06-21T00:00:00.000Z" });

  assert.equal(model.checkedAt, "2026-06-21T00:00:00.000Z");
  assert.deepEqual(model.runs.map((run) => run.runId), ["fresh"]);
  assert.deepEqual(model.activeRuns, [{
    logicalThreadId: "thread-fresh",
    runId: "fresh",
    status: "running",
    workerId: "worker-1",
    leaseTtlMs: 1234,
    retryLaterCount: undefined,
    deadLetteredAt: undefined,
  }]);
  assert.equal(calls.filter((call) => call === "listRuns").length, 1);
  assert.equal(calls.filter((call) => call === "listActivePointers").length, 1);
  assert.equal(calls.includes("getRun:fresh"), true);
});

test("run-control read model exposes queue, workers, outbox, and dead-letter projections", async () => {
  const runningRun = createRun("active", "running", { logicalThreadId: "thread-active", workerId: "worker-1" });
  const outboxRun = createRun("outbox", "succeeded", {
    finalDiscordOutboxStartedAt: "2026-01-01T00:00:00.000Z",
    finalDiscordChunkCount: 2,
    finalDiscordMessageIds: ["m1", "m2"],
    finalDiscordReservedAt: "2026-01-01T00:00:01.000Z",
    finalDiscordPostedAt: "2026-01-01T00:00:02.000Z",
  });
  const deadRun = createRun("dead", "interrupted", {
    retryLaterCount: 12,
    deadLetteredAt: "2026-01-01T00:00:04.000Z",
    deadLetterReason: "too many retries",
  });
  const runs = [runningRun, outboxRun, deadRun];
  const store = {
    async listRuns() {
      return runs;
    },
    async listActivePointers() {
      return [{ logicalThreadId: "thread-active", runId: "active" }];
    },
    async getRun(runId) {
      return runs.find((run) => run.runId === runId);
    },
    async getRunLeaseTtl() {
      return 456;
    },
    async getJobQueueSummary() {
      return { pendingCount: 1, firstPendingId: "1-0", lastPendingId: "1-0", consumers: [{ name: "worker-1", pending: 1 }] };
    },
    async listWorkers() {
      return [{ workerId: "worker-1", status: "running", runId: "active", updatedAt: "2026-01-01T00:00:06.000Z", ttlMs: 1000 }];
    },
  };

  const model = await loadRunControlReadModel(store);

  assert.equal(model.pendingJobs.pendingCount, 1);
  assert.deepEqual(model.workers.map((worker) => worker.workerId), ["worker-1"]);
  assert.deepEqual(model.outboxRuns, [{
    runId: "outbox",
    status: "succeeded",
    chunkCount: 2,
    messageIds: ["m1", "m2"],
    startedAt: "2026-01-01T00:00:00.000Z",
    reservedAt: "2026-01-01T00:00:01.000Z",
    postedAt: "2026-01-01T00:00:02.000Z",
  }]);
  assert.deepEqual(model.deadLetteredRuns, [{
    runId: "dead",
    status: "interrupted",
    retryLaterCount: 12,
    deadLetteredAt: "2026-01-01T00:00:04.000Z",
    deadLetterReason: "too many retries",
  }]);

  const snapshot = snapshotFromRunControlReadModel(model, [{
    code: "example",
    severity: "warn",
    message: "reconcile warning",
  }]);
  assert.deepEqual(snapshot.activeRuns, model.activeRuns);
  assert.deepEqual(snapshot.pendingJobs, model.pendingJobs);
  assert.deepEqual(snapshot.workers, model.workers);
  assert.deepEqual(snapshot.deadLetteredRuns, model.deadLetteredRuns);
  assert.deepEqual(snapshot.reconcileIssues.map((issue) => issue.code), ["example"]);
});
