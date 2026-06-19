import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import { defaultConfig } from "../dist/config.js";
import { PiRuntimeManager } from "../dist/pi-runtime.js";
import {
  createPiSessionRuntimeClient,
  createPiSessionRuntimeClientFromManager,
  makePiSessionService,
  PiSessionAlreadyProcessing,
  PiSessionAssistantLeafContinueFailed,
  PiSessionOperationFailed,
  PiSessionService,
} from "../dist/engine/index.js";

const thread = {
  threadId: "thread-pi-session-1",
  kind: "discord-thread",
  status: "idle",
  cwd: process.cwd(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const fakeRegistry = {
  getThread() { return undefined; },
  patchThread(_threadId, patch) { return Promise.resolve({ ...thread, ...patch }); },
};

const createManager = (overrides = {}) => ({
  enqueuePrompt: async () => ({ kind: "completed", text: "ok", sessionFile: "session.jsonl" }),
  queueMessageDuringActive: async () => ({ queued: false }),
  queueMessageForThreadIfActive: async () => ({ queued: false }),
  enqueueReload: async () => undefined,
  enqueueCompact: async () => ({
    summary: "compact",
    firstKeptEntryId: "entry-1",
    tokensBefore: 123,
    sessionFile: "session.jsonl",
  }),
  isActive: () => false,
  abort: async () => undefined,
  disposeAll: async () => undefined,
  ...overrides,
});

test("PiSessionService wrapper delegates Pi runtime operations", async () => {
  const calls = [];
  const service = makePiSessionService(createManager({
    enqueuePrompt: async (inputThread, text, images, onProgress) => {
      calls.push(["enqueuePrompt", inputThread.threadId, text, images?.length ?? 0, Boolean(onProgress)]);
      await onProgress?.({ phase: "thinking", title: "fake progress" });
      return { kind: "completed", text: "done", sessionFile: "session.jsonl" };
    },
    abort: async (threadId) => {
      calls.push(["abort", threadId]);
    },
  }));
  const progress = [];

  const result = await Effect.runPromise(service.enqueuePrompt(thread, "hello", [{ mediaType: "image/png", data: "abc" }], (event) => {
    progress.push(event.title);
  }));
  await Effect.runPromise(service.abort(thread.threadId));

  assert.deepEqual(result, { kind: "completed", text: "done", sessionFile: "session.jsonl" });
  assert.deepEqual(progress, ["fake progress"]);
  assert.deepEqual(calls, [
    ["enqueuePrompt", "thread-pi-session-1", "hello", 1, true],
    ["abort", "thread-pi-session-1"],
  ]);
});

test("PiSessionService maps known Pi prompt failures to typed errors", async () => {
  const alreadyProcessing = makePiSessionService(createManager({
    enqueuePrompt: async () => {
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    },
  }));
  const assistantLeaf = makePiSessionService(createManager({
    enqueuePrompt: async () => {
      throw new Error("Cannot continue from message role: assistant");
    },
  }));
  const generic = makePiSessionService(createManager({
    enqueueReload: async () => {
      throw new Error("session exploded");
    },
  }));

  const alreadyProcessingError = await Effect.runPromise(Effect.flip(alreadyProcessing.enqueuePrompt(thread, "hello")));
  const assistantLeafError = await Effect.runPromise(Effect.flip(assistantLeaf.enqueuePrompt(thread, "hello")));
  const genericError = await Effect.runPromise(Effect.flip(generic.enqueueReload(thread)));

  assert.equal(alreadyProcessingError._tag, "PiSessionAlreadyProcessing");
  assert.equal(alreadyProcessingError.operation, "enqueuePrompt");
  assert.ok(alreadyProcessingError instanceof PiSessionAlreadyProcessing);
  assert.equal(assistantLeafError._tag, "PiSessionAssistantLeafContinueFailed");
  assert.ok(assistantLeafError instanceof PiSessionAssistantLeafContinueFailed);
  assert.equal(genericError._tag, "PiSessionOperationFailed");
  assert.equal(genericError.operation, "enqueueReload");
  assert.ok(genericError instanceof PiSessionOperationFailed);
});

test("PiSession runtime client routes calls through the Effect service and preserves public errors", async () => {
  const calls = [];
  const publicError = new Error("human readable prompt failure");
  const client = createPiSessionRuntimeClientFromManager(createManager({
    enqueuePrompt: async (_thread, text) => {
      calls.push(["enqueuePrompt", text]);
      return { kind: "completed", text: "runtime done", sessionFile: "session.jsonl" };
    },
    enqueueReload: async () => {
      throw publicError;
    },
    disposeAll: async () => {
      calls.push(["disposeAll"]);
    },
  }));

  try {
    await client.warmup();
    const result = await client.enqueuePrompt(thread, "through runtime");
    assert.deepEqual(result, { kind: "completed", text: "runtime done", sessionFile: "session.jsonl" });
    try {
      await client.enqueueReload(thread);
      assert.fail("expected enqueueReload to reject");
    } catch (error) {
      assert.equal(error, publicError);
    }
  } finally {
    await client.disposeAll();
  }

  assert.deepEqual(calls, [
    ["enqueuePrompt", "through runtime"],
    ["disposeAll"],
  ]);
});

test("PiSession runtime client close disposes manager resources once and stays idempotent", async () => {
  const calls = [];
  const client = createPiSessionRuntimeClientFromManager(createManager({
    disposeAll: async () => {
      calls.push(["disposeAll"]);
    },
  }));

  await client.warmup();
  await client.close();
  await client.disposeAll();
  await client.close();

  assert.deepEqual(calls, [["disposeAll"]]);
});

test("PiSession runtime client close before warmup disposes injected manager once", async () => {
  const calls = [];
  const client = createPiSessionRuntimeClientFromManager(createManager({
    disposeAll: async () => {
      calls.push(["disposeAll"]);
    },
  }));

  await client.close();
  await client.disposeAll();

  assert.deepEqual(calls, [["disposeAll"]]);
});

test("PiSession runtime client close before warmup preserves dispose failures", async () => {
  let calls = 0;
  const disposeError = new Error("dispose exploded before warmup");
  const client = createPiSessionRuntimeClientFromManager(createManager({
    disposeAll: async () => {
      calls += 1;
      throw disposeError;
    },
  }));

  await assert.rejects(
    () => client.close(),
    (error) => error === disposeError,
  );
  await client.close();

  assert.equal(calls, 1);
});

test("PiSession runtime client close preserves scoped dispose failures", async () => {
  const disposeError = new Error("dispose exploded");
  const client = createPiSessionRuntimeClientFromManager(createManager({
    disposeAll: async () => {
      throw disposeError;
    },
  }));

  await client.warmup();

  await assert.rejects(
    () => client.close(),
    (error) => error === disposeError,
  );
});

test("manager-created PiSession runtime clients dispose the PiRuntimeManager from the scoped layer", async () => {
  const calls = [];
  const originalDisposeAll = PiRuntimeManager.prototype.disposeAll;
  PiRuntimeManager.prototype.disposeAll = async function disposeAllForTest() {
    calls.push(this);
  };

  try {
    const client = createPiSessionRuntimeClient(defaultConfig(), fakeRegistry);

    assert.equal(client.isActive(thread.threadId), false);
    await client.warmup();
    await client.close();
    await client.disposeAll();

    assert.equal(calls.length, 1);
  } finally {
    PiRuntimeManager.prototype.disposeAll = originalDisposeAll;
  }
});

test("PiSessionService can be swapped with a fake layer", async () => {
  const fakeLayer = Layer.mock(PiSessionService, {
    enqueuePrompt: () => Effect.succeed({ kind: "completed", text: "fake", sessionFile: "fake.jsonl" }),
    isActive: () => true,
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* PiSessionService;
      const prompt = yield* session.enqueuePrompt(thread, "hello");
      return { prompt, active: session.isActive(thread.threadId) };
    }).pipe(Effect.provide(fakeLayer)),
  );

  assert.deepEqual(result, {
    prompt: { kind: "completed", text: "fake", sessionFile: "fake.jsonl" },
    active: true,
  });
});
