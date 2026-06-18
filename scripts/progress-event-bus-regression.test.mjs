import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { createProgressEventBus } from "../dist/progress-events.js";
import { runRunControlLeasedRun } from "../dist/run-control/leased-run-machine.js";

test("ProgressEventBus fans out progress events to subscribers", async () => {
  const seen = [];
  const bus = createProgressEventBus(
    (progress) => seen.push(["discord", progress.title]),
    async (progress) => seen.push(["run-event", progress.phase]),
  );

  await bus.publish({ phase: "thinking", title: "Agent running" });

  assert.deepEqual(seen, [
    ["discord", "Agent running"],
    ["run-event", "thinking"],
  ]);
});

test("ProgressEventBus isolates subscriber failures", async () => {
  const seen = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const bus = createProgressEventBus(
      () => {
        throw new Error("discord edit failed");
      },
      (progress) => seen.push(progress.title),
    );

    await bus.publish({ phase: "tool", title: "Reading file" });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(seen, ["Reading file"]);
  assert.match(warnings[0], /progress subscriber failed: discord edit failed/);
});

test("ProgressEventBus subscriptions can be removed", async () => {
  const seen = [];
  const bus = createProgressEventBus();
  const unsubscribe = bus.subscribe((progress) => seen.push(progress.title));

  await bus.publish({ phase: "starting", title: "one" });
  unsubscribe();
  await bus.publish({ phase: "done", title: "two" });

  assert.deepEqual(seen, ["one"]);
});

test("RunControlWorker wires progress bus to run-event appenders and adapter subscribers", async () => {
  const appendedRunEvents = [];
  const adapterEvents = [];
  const run = {
    runId: "run-progress-1",
    logicalThreadId: "thread-progress-1",
    threadId: "thread-progress-1",
    kind: "discord-thread",
    status: "running",
    sourceDiscordMessageId: "source-progress-1",
    placeholderDiscordMessageId: "placeholder-progress-1",
    prompt: "show progress",
    promptPreview: "show progress",
    cwd: process.cwd(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const store = {
    readInputsSince: async () => [],
    appendRunEvent: async (runId, type, fields) => {
      appendedRunEvents.push({ runId, type, fields });
      return `event-${appendedRunEvents.length}`;
    },
    patchRun: async () => run,
    heartbeatRunLease: async () => true,
    acquireFinalize: async () => "acquired",
    completeFinalize: async () => true,
    markTerminal: async (_runId, status, patch) => ({ ...run, status, ...patch }),
    clearActiveIfMatches: async () => true,
  };
  const adapter = {
    executeRun: async (_run, progressEvents) => {
      progressEvents.subscribe((progress) => adapterEvents.push(progress.title));
      await progressEvents.publish({
        phase: "thinking",
        title: "Agent running",
        feedEvent: { type: "agent_start", title: "Agent running" },
      });
      return { text: "done", sessionFile: "session.jsonl" };
    },
    finalizeRun: async () => undefined,
    failRun: async () => undefined,
    applyInput: async () => ({ queued: true }),
  };

  await runRunControlLeasedRun({
    store,
    adapter,
    config: defaultConfig(),
    run,
    leaseToken: "lease-progress-1",
    workerId: "worker-progress-test",
    createFinalizeToken: () => "finalize-progress-1",
    warn: () => undefined,
  });

  assert.deepEqual(adapterEvents, ["Agent running"]);
  assert.deepEqual(appendedRunEvents, [{
    runId: "run-progress-1",
    type: "agent_start",
    fields: {
      title: "Agent running",
      detail: undefined,
      toolName: undefined,
      isError: undefined,
      sessionFile: undefined,
    },
  }]);
});
