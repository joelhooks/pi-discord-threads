import assert from "node:assert/strict";
import test from "node:test";
import { createActor, waitFor } from "xstate";
import { defaultConfig } from "../dist/config.js";
import { RunControlWorker } from "../dist/run-control/worker.js";
import { runControlLeasedRunMachine } from "../dist/run-control/leased-run-machine.js";
import { runControlWorkerLaneMachine } from "../dist/run-control/worker-lane-machine.js";
import { runControlWorkerJobMachine } from "../dist/run-control/worker-machine.js";

const run = {
  runId: "run-1",
  logicalThreadId: "thread-1",
  threadId: "thread-1",
  kind: "discord-thread",
  status: "running",
  sourceDiscordMessageId: "source-1",
  placeholderDiscordMessageId: "placeholder-1",
  prompt: "hello",
  promptPreview: "hello",
  cwd: process.cwd(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function createConfig() {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.maxConcurrentRuns = 1;
  config.runControl.heartbeatMs = 1_000;
  return config;
}

function createAdapter() {
  return {
    executeRun: async () => ({ text: "done", sessionFile: undefined }),
    finalizeRun: async () => undefined,
    failRun: async () => undefined,
    applyInput: async () => ({ queued: false }),
  };
}

function createStore(overrides = {}) {
  let firstDequeue = true;
  return {
    ensureConsumerGroup: async () => undefined,
    dequeueJob: async () => {
      if (firstDequeue) {
        firstDequeue = false;
        return { streamId: "1-0", runId: run.runId };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return undefined;
    },
    recordWorkerIdle: async () => undefined,
    getRun: async () => run,
    getActiveRunId: async () => run.runId,
    acknowledgeJob: async () => undefined,
    appendRunEvent: async () => "event-1",
    claimRunLease: async () => true,
    heartbeatRunLease: async () => true,
    releaseRunLease: async () => true,
    readInputsSince: async () => [],
    patchRun: async () => run,
    acquireFinalize: async () => "acquired",
    completeFinalize: async () => true,
    markTerminal: async () => ({ ...run, status: "succeeded" }),
    clearActiveIfMatches: async () => true,
    getRunLeaseTtl: async () => 1_000,
    close: async () => undefined,
    ...overrides,
  };
}

test("busy live lease leaves a claimed stream job pending instead of ACKing it", async () => {
  let ackCount = 0;
  let sawBusy;
  const busySeen = new Promise((resolve) => { sawBusy = resolve; });
  const store = createStore({
    claimRunLease: async () => false,
    acknowledgeJob: async () => { ackCount++; },
    appendRunEvent: async (_runId, type) => {
      if (type === "lease_claim_busy") sawBusy();
      return "event-1";
    },
  });
  const worker = new RunControlWorker(store, createAdapter(), createConfig(), "worker-1");

  worker.start();
  await busySeen;
  await worker.stop();

  assert.equal(ackCount, 0);
});

test("uncertain finalization retry fails safe instead of posting duplicate final reply", async () => {
  const finalizingRun = {
    ...run,
    status: "finalizing",
    resultText: "final answer",
    finalizeAttemptedAt: new Date(1).toISOString(),
  };
  let ackCount = 0;
  let finalizeCount = 0;
  let failCount = 0;
  let terminalStatus;
  const calls = [];
  let resolveTerminal;
  const terminalSeen = new Promise((resolve) => { resolveTerminal = resolve; });
  const store = createStore({
    getRun: async () => finalizingRun,
    acknowledgeJob: async () => { ackCount++; },
    markTerminal: async (_runId, status) => {
      calls.push("markTerminal");
      terminalStatus = status;
      resolveTerminal();
      return { ...finalizingRun, status };
    },
    completeFinalize: async () => {
      calls.push("completeFinalize");
      return true;
    },
  });
  const adapter = {
    ...createAdapter(),
    finalizeRun: async () => { finalizeCount++; },
    failRun: async () => { failCount++; },
  };
  const worker = new RunControlWorker(store, adapter, createConfig(), "worker-1");

  worker.start();
  await terminalSeen;
  await worker.stop();

  assert.equal(finalizeCount, 0);
  assert.equal(failCount, 1);
  assert.equal(terminalStatus, "failed");
  assert.deepEqual(calls, ["markTerminal", "completeFinalize"]);
  assert.equal(ackCount, 1);
});

test("stale job for non-active run is skipped and ACKed", async () => {
  let ackCount = 0;
  let claimCount = 0;
  let sawStale;
  const staleSeen = new Promise((resolve) => { sawStale = resolve; });
  const store = createStore({
    getActiveRunId: async () => "run-newer",
    claimRunLease: async () => { claimCount++; return true; },
    acknowledgeJob: async () => { ackCount++; },
    appendRunEvent: async (_runId, type) => {
      if (type === "stale_job_skipped") sawStale();
      return "event-1";
    },
  });
  const worker = new RunControlWorker(store, createAdapter(), createConfig(), "worker-1");

  worker.start();
  await staleSeen;
  await worker.stop();

  assert.equal(claimCount, 0);
  assert.equal(ackCount, 1);
});

test("busy finalization leaves the stream job pending without logging an outside-handler failure", async () => {
  let ackCount = 0;
  let releaseCount = 0;
  let sawRelease;
  const releaseSeen = new Promise((resolve) => { sawRelease = resolve; });
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  const store = createStore({
    acquireFinalize: async () => "busy",
    acknowledgeJob: async () => { ackCount++; },
    releaseRunLease: async () => {
      releaseCount++;
      sawRelease();
      return true;
    },
  });
  const worker = new RunControlWorker(store, createAdapter(), createConfig(), "worker-1");

  try {
    worker.start();
    await releaseSeen;
    await worker.stop();
  } finally {
    console.error = originalError;
  }

  assert.equal(releaseCount, 1);
  assert.equal(ackCount, 0);
  assert.deepEqual(errors, []);
});

test("RunControlLeasedRunMachine exposes execution and finalization as machine state", async () => {
  const states = [];
  const calls = [];
  const store = createStore({
    readInputsSince: async () => [],
    patchRun: async (_runId, patch) => {
      calls.push(patch.status === "finalizing" ? "patch:finalizing" : "patch:finalizeAttemptedAt");
      return { ...run, ...patch };
    },
    acquireFinalize: async () => {
      calls.push("acquireFinalize");
      return "acquired";
    },
    completeFinalize: async () => {
      calls.push("completeFinalize");
      return true;
    },
    markTerminal: async (_runId, status) => {
      calls.push(`markTerminal:${status}`);
      return { ...run, status };
    },
    clearActiveIfMatches: async () => {
      calls.push("clearActive");
      return true;
    },
  });
  const adapter = {
    ...createAdapter(),
    executeRun: async () => {
      calls.push("executeRun");
      return { text: "done", sessionFile: "session.jsonl", userEntryId: "u1", assistantEntryId: "a1" };
    },
    finalizeRun: async () => {
      calls.push("finalizeRun");
    },
  };
  const actor = createActor(runControlLeasedRunMachine, {
    input: {
      store,
      adapter,
      config: createConfig(),
      run,
      leaseToken: "lease-1",
      workerId: "worker-1",
      createFinalizeToken: () => "finalize-1",
      warn: () => undefined,
    },
  });
  actor.subscribe((snapshot) => states.push(JSON.stringify(snapshot.value)));

  actor.start();
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done", { timeout: 1_000 });
  actor.stop();

  assert.equal(done.context.outcome.kind, "completed");
  assert.deepEqual(calls, [
    "executeRun",
    "patch:finalizing",
    "acquireFinalize",
    "patch:finalizeAttemptedAt",
    "finalizeRun",
    "completeFinalize",
    "markTerminal:succeeded",
    "clearActive",
  ]);
  assert.equal(states.some((state) => state.includes("freshExecution")), true);
  assert.equal(states.some((state) => state.includes("patchingRunFinalizing")), true);
  assert.equal(states.some((state) => state.includes("postingSuccessDiscord")), true);
});

test("RunControlWorkerLaneMachine exposes ensure/dequeue/idle/stop lifecycle as machine state", async () => {
  const states = [];
  const warnings = [];
  let ensureAttempts = 0;
  let resolveIdle;
  const idleSeen = new Promise((resolve) => { resolveIdle = resolve; });
  const store = createStore({
    ensureConsumerGroup: async () => {
      ensureAttempts++;
      if (ensureAttempts === 1) throw new Error("redis down");
    },
    dequeueJob: async () => undefined,
    recordWorkerIdle: async () => {
      resolveIdle();
    },
  });
  const actor = createActor(runControlWorkerLaneMachine, {
    input: {
      store,
      workerId: "worker-1",
      blockMs: 1,
      initialEnsureRetryDelayMs: 1,
      maxEnsureRetryDelayMs: 2,
      createLeaseToken: () => "lease-1",
      executeWithLease: async () => undefined,
      shouldLeavePending: () => false,
      log: () => undefined,
      warn: (message) => warnings.push(message),
      error: () => undefined,
    },
  });
  actor.subscribe((snapshot) => states.push(snapshot.value));

  actor.start();
  await idleSeen;
  actor.send({ type: "STOP" });
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done", { timeout: 1_000 });
  actor.stop();

  assert.equal(done.context.stopRequested, true);
  assert.equal(ensureAttempts, 2);
  assert.equal(warnings.some((message) => message.includes("redis down")), true);
  assert.equal(states.includes("retryingConsumerGroup"), true);
  assert.equal(states.includes("dequeuing"), true);
  assert.equal(states.includes("recordingIdle"), true);
});

test("RunControlWorkerLaneMachine backs off and re-ensures after dequeue failures", async () => {
  const states = [];
  const warnings = [];
  let ensureAttempts = 0;
  let dequeueAttempts = 0;
  let resolveIdle;
  const idleSeen = new Promise((resolve) => { resolveIdle = resolve; });
  const store = createStore({
    ensureConsumerGroup: async () => {
      ensureAttempts++;
    },
    dequeueJob: async () => {
      dequeueAttempts++;
      if (dequeueAttempts === 1) throw new Error("NOGROUP No such key");
      return undefined;
    },
    recordWorkerIdle: async () => {
      resolveIdle();
    },
  });
  const actor = createActor(runControlWorkerLaneMachine, {
    input: {
      store,
      workerId: "worker-1",
      blockMs: 1,
      initialEnsureRetryDelayMs: 1,
      maxEnsureRetryDelayMs: 2,
      createLeaseToken: () => "lease-1",
      executeWithLease: async () => undefined,
      shouldLeavePending: () => false,
      log: () => undefined,
      warn: (message) => warnings.push(message),
      error: () => undefined,
    },
  });
  actor.subscribe((snapshot) => states.push(snapshot.value));

  actor.start();
  await idleSeen;
  actor.send({ type: "STOP" });
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done", { timeout: 1_000 });
  actor.stop();

  assert.equal(done.context.stopRequested, true);
  assert.equal(ensureAttempts, 2);
  assert.equal(dequeueAttempts, 2);
  assert.equal(warnings.some((message) => message.includes("NOGROUP")), true);
  assert.equal(states.includes("retryingConsumerGroup"), true);
  assert.equal(states.includes("ensuringConsumerGroup"), true);
  assert.equal(states.includes("recordingIdle"), true);
});

test("RunControlWorkerJobMachine exposes claim-to-execute lifecycle as machine state", async () => {
  const states = [];
  const store = createStore({
    getActiveRunId: async () => "run-newer",
  });
  const actor = createActor(runControlWorkerJobMachine, {
    input: {
      store,
      job: { streamId: "1-0", runId: run.runId },
      workerId: "worker-1",
      createLeaseToken: () => "lease-1",
      executeWithLease: async () => undefined,
      shouldLeavePending: () => false,
    },
  });
  actor.subscribe((snapshot) => states.push(snapshot.value));

  actor.start();
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done", { timeout: 1_000 });
  actor.stop();

  assert.equal(done.context.outcome.kind, "acked");
  assert.equal(done.context.outcome.reason, "stale-job");
  assert.equal(states.includes("loadingActiveRunId"), true);
  assert.equal(states.includes("skippingStaleJob"), true);
});
