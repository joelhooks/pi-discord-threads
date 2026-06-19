import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import { defaultConfig } from "../dist/config.js";
import { RedisCommandTimeoutError } from "../dist/run-control/redis-client.js";
import {
  RunQueueConnectFailed,
  RunQueueEngineLive,
  createRunQueueRuntimeClient,
  makeRunQueueService,
  RunQueueOperationFailed,
  RunQueueService,
  RunQueueTimeout,
} from "../dist/engine/index.js";

const runRecord = {
  runId: "run-1",
  logicalThreadId: "logical-1",
  threadId: "thread-1",
  kind: "discord-thread",
  status: "queued",
  sourceDiscordMessageId: "message-source-1",
  placeholderDiscordMessageId: "message-placeholder-1",
  prompt: "hello",
  promptPreview: "hello",
  cwd: process.cwd(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const createStore = (overrides = {}) => ({
  ensureConsumerGroup: async () => undefined,
  tryEnqueueRun: async (run) => ({ enqueued: true, run }),
  appendInput: async () => "input-1",
  getInputStreamLength: async () => 0,
  countInputsForRun: async () => 0,
  readInputsSince: async () => [],
  dequeueJob: async () => undefined,
  claimStaleJob: async () => undefined,
  acknowledgeJob: async () => undefined,
  getRun: async () => undefined,
  patchRun: async () => undefined,
  markTerminal: async () => undefined,
  getActiveRunId: async () => undefined,
  getQueueableActiveRunId: async () => undefined,
  clearActiveIfMatches: async () => false,
  claimRunLease: async () => true,
  heartbeatRunLease: async () => true,
  verifyRunOwnership: async () => true,
  releaseRunLease: async () => true,
  acquireFinalize: async () => "acquired",
  completeFinalize: async () => true,
  getRunLeaseTtl: async () => -1,
  appendRunEvent: async () => "event-1",
  recordWorkerIdle: async () => undefined,
  listRuns: async () => [],
  listActivePointers: async () => [],
  ...overrides,
});

test("RunQueueService wrapper delegates queue operations", async () => {
  const calls = [];
  const service = makeRunQueueService(createStore({
    tryEnqueueRun: async (run) => {
      calls.push(["tryEnqueueRun", run.runId]);
      return { enqueued: true, run };
    },
    appendInput: async (input) => {
      calls.push(["appendInput", input.text]);
      return "input-42";
    },
  }), 123);

  const enqueued = await Effect.runPromise(service.tryEnqueueRun(runRecord));
  const inputId = await Effect.runPromise(service.appendInput({
    runId: runRecord.runId,
    logicalThreadId: runRecord.logicalThreadId,
    mode: "followUp",
    text: "extra context",
    createdAt: new Date(0).toISOString(),
  }));

  assert.deepEqual(enqueued, { enqueued: true, run: runRecord });
  assert.equal(inputId, "input-42");
  assert.deepEqual(calls, [["tryEnqueueRun", "run-1"], ["appendInput", "extra context"]]);
});

test("RunQueueService maps Redis timeouts to typed Effect errors", async () => {
  const service = makeRunQueueService(createStore({
    appendInput: async () => {
      throw new RedisCommandTimeoutError("XADD", 123);
    },
  }), 123);

  const error = await Effect.runPromise(Effect.flip(service.appendInput({
    runId: runRecord.runId,
    logicalThreadId: runRecord.logicalThreadId,
    mode: "steer",
    text: "please stop",
    createdAt: new Date(0).toISOString(),
  })));

  assert.equal(error._tag, "RunQueueTimeout");
  assert.equal(error.operation, "appendInput");
  assert.equal(error.timeoutMs, 123);
  assert.ok(error instanceof RunQueueTimeout);
});

test("RunQueueService maps generic store failures to typed operation errors", async () => {
  const service = makeRunQueueService(createStore({
    getRun: async () => {
      throw new Error("redis is not having a good day");
    },
  }), 5000);

  const error = await Effect.runPromise(Effect.flip(service.getRun(runRecord.runId)));

  assert.equal(error._tag, "RunQueueOperationFailed");
  assert.equal(error.operation, "getRun");
  assert.ok(error instanceof RunQueueOperationFailed);
});

test("RunQueueEngineLive maps missing Redis URL to a typed connect error", async () => {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.redisUrl = undefined;
  config.runControl.redisUrlEnv = "PI_DISCORD_THREADS_TEST_MISSING_REDIS_URL";
  delete process.env.PI_DISCORD_THREADS_TEST_MISSING_REDIS_URL;

  const error = await Effect.runPromise(Effect.flip(
    Effect.gen(function* () {
      return yield* RunQueueService;
    }).pipe(Effect.provide(RunQueueEngineLive(config))),
  ));

  assert.equal(error._tag, "RunQueueConnectFailed");
  assert.ok(error instanceof RunQueueConnectFailed);
});

test("RunQueue runtime client exposes typed layer failures to Promise callers", async () => {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.redisUrl = undefined;
  config.runControl.redisUrlEnv = "PI_DISCORD_THREADS_TEST_MISSING_RUNTIME_REDIS_URL";
  delete process.env.PI_DISCORD_THREADS_TEST_MISSING_RUNTIME_REDIS_URL;

  const client = createRunQueueRuntimeClient(config);
  try {
    await assert.rejects(() => client.warmup(), (error) => {
      assert.equal(error._tag, "RunQueueConnectFailed");
      assert.ok(error instanceof RunQueueConnectFailed);
      return true;
    });
  } finally {
    await client.close();
  }
});

test("RunQueueService can be swapped with a fake layer", async () => {
  const fakeLayer = Layer.mock(RunQueueService, {
    getRun: () => Effect.succeed({ ...runRecord, status: "running" }),
    appendInput: () => Effect.succeed("fake-input-1"),
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* RunQueueService;
      const run = yield* queue.getRun(runRecord.runId);
      const inputId = yield* queue.appendInput({
        runId: runRecord.runId,
        logicalThreadId: runRecord.logicalThreadId,
        mode: "followUp",
        text: "fake",
        createdAt: new Date(0).toISOString(),
      });
      return { run, inputId };
    }).pipe(Effect.provide(fakeLayer)),
  );

  assert.equal(result.run.status, "running");
  assert.equal(result.inputId, "fake-input-1");
});
