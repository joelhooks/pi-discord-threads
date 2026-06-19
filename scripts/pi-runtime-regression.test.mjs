import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { buildRuntimeRegistrationPatch, PiRuntimeManager } from "../dist/pi-runtime.js";

const fakeRegistry = {
  getThread() { return undefined; },
  patchThread() { return Promise.resolve(undefined); },
};

function createManager() {
  return new PiRuntimeManager(defaultConfig(), fakeRegistry);
}

async function collectUnhandledRejectionsDuring(fn) {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", handler);
  }
  return seen;
}

test("rejected per-thread operations do not create an unhandled cleanup rejection", async () => {
  const manager = createManager();
  const failure = new Error("prompt blew up");

  const unhandled = await collectUnhandledRejectionsDuring(async () => {
    await assert.rejects(
      () => manager.enqueueOperation("thread-1", async () => {
        throw failure;
      }),
      /prompt blew up/,
    );
  });

  assert.deepEqual(unhandled, []);
});

test("assistant-leaf recovery aborts stale streaming state before retrying", async () => {
  const manager = createManager();
  let promptCalls = 0;
  let abortCalls = 0;
  let branchedTo;
  let streaming = false;
  const rebuiltMessages = [{ role: "user", content: [{ type: "text", text: "stable parent" }] }];

  const session = {
    sessionFile: "session.jsonl",
    get isStreaming() {
      return streaming;
    },
    async prompt(text) {
      promptCalls += 1;
      assert.equal(text, "continue safely");
      if (promptCalls === 1) {
        streaming = true;
        throw new Error("Cannot continue from message role: assistant");
      }
      assert.equal(streaming, false, "retry should not call prompt while Pi still reports streaming");
    },
    async abort() {
      abortCalls += 1;
      streaming = false;
    },
    sessionManager: {
      getLeafEntry() {
        return {
          type: "message",
          parentId: "parent-entry",
          message: { role: "assistant", stopReason: "error" },
        };
      },
      branch(id) {
        branchedTo = id;
      },
      buildSessionContext() {
        return { messages: rebuiltMessages };
      },
    },
    agent: { state: { messages: [{ role: "assistant", stopReason: "error" }] } },
  };

  await manager.promptWithAssistantLeafRecovery(session, "continue safely", [], () => undefined);

  assert.equal(promptCalls, 2);
  assert.equal(abortCalls, 1);
  assert.equal(branchedTo, "parent-entry");
  assert.equal(session.agent.state.messages, rebuiltMessages);
});

test("runtime registration preserves visible active run state", () => {
  const thread = {
    threadId: "thread-active-runtime",
    kind: "discord-thread",
    cwd: process.cwd(),
    status: "running",
    activeRun: {
      runId: "run-1",
      sourceDiscordMessageId: "source-1",
      placeholderDiscordMessageId: "placeholder-1",
      prompt: "hello",
      promptPreview: "hello",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  const patch = buildRuntimeRegistrationPatch(thread, "session-active.jsonl", "Active Runtime", thread);

  assert.equal(patch.status, "running");
  assert.equal(patch.activeRun.runId, "run-1");
  assert.equal(patch.activeRun.sessionFile, "session-active.jsonl");
});

test("prompt recovery stops before retry when the abort signal fires during reset", async () => {
  const manager = createManager();
  const controller = new AbortController();
  let promptCalls = 0;
  let abortCalls = 0;
  let streaming = true;

  const session = {
    sessionFile: "session.jsonl",
    get isStreaming() {
      return streaming;
    },
    async prompt() {
      promptCalls += 1;
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    },
    async abort() {
      abortCalls += 1;
      streaming = false;
      controller.abort();
    },
    sessionManager: {
      getLeafEntry() { return undefined; },
      buildSessionContext() { return { messages: [] }; },
    },
    agent: { state: { messages: [] } },
  };

  await assert.rejects(
    () => manager.promptWithAssistantLeafRecovery(session, "fresh prompt", [], () => undefined, controller.signal),
    /run-control lease loss/,
  );

  assert.equal(promptCalls, 1);
  assert.equal(abortCalls, 1);
});

test("run-control managed prompt completion does not clear registry active run", async () => {
  const patches = [];
  const thread = {
    threadId: "thread-deferred-completion",
    kind: "discord-thread",
    cwd: process.cwd(),
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const registry = {
    getThread() { return thread; },
    patchThread(_threadId, patch) {
      patches.push(patch);
      return Promise.resolve({ ...thread, ...patch });
    },
  };
  const manager = new PiRuntimeManager(defaultConfig(), registry);
  manager.reloadRuntimeAuth = async () => undefined;
  manager.scheduleDispose = () => undefined;
  manager.getOrCreateRuntime = async () => ({
    runtime: {
      dispose: async () => undefined,
      session: {
        sessionFile: "session-deferred.jsonl",
        isStreaming: false,
        messages: [],
        subscribe() { return () => undefined; },
        async prompt() {},
        async abort() {},
        getLastAssistantText() { return "done without registry completion"; },
        sessionManager: {
          getLeafEntry() { return undefined; },
          getEntries() { return []; },
          getSessionName() { return "Deferred Completion"; },
          buildSessionContext() { return { messages: [] }; },
        },
        agent: { state: { messages: [] } },
      },
    },
  });

  const result = await manager.enqueuePrompt(thread, "complete under run-control", [], undefined, {
    deferRegistryCompletion: true,
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.text, "done without registry completion");
  assert.equal(patches.some((patch) => patch.status === "idle" && patch.activeRun === undefined), false);
});

test("OAuth retry preserves run-control prompt options", async () => {
  const thread = {
    threadId: "thread-oauth-retry",
    kind: "discord-thread",
    cwd: process.cwd(),
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const registry = {
    getThread() { return thread; },
    patchThread(_threadId, patch) { return Promise.resolve({ ...thread, ...patch }); },
  };
  const manager = new PiRuntimeManager(defaultConfig(), registry);
  manager.reloadRuntimeAuth = async () => undefined;
  manager.scheduleDispose = () => undefined;
  let authSnapshotCalls = 0;
  manager.getAuthFileSnapshot = async () => (++authSnapshotCalls === 1 ? "before" : "after");

  const session = {
    sessionFile: "session-oauth.jsonl",
    isStreaming: false,
    messages: [],
    subscribe() { return () => undefined; },
    async prompt() {
      session.messages = [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "authentication token has been invalidated by a global logout",
        content: [],
      }];
    },
    async abort() {},
    getLastAssistantText() { return "unused"; },
    sessionManager: {
      getLeafEntry() { return undefined; },
      getEntries() { return []; },
      getSessionName() { return "OAuth Retry"; },
      buildSessionContext() { return { messages: [] }; },
    },
    agent: { state: { messages: [] } },
  };
  manager.getOrCreateRuntime = async () => ({ runtime: { session, dispose: async () => undefined } });

  const controller = new AbortController();
  const originalPrompt = manager.prompt.bind(manager);
  let promptCalls = 0;
  let retryOptions;
  manager.prompt = async (...args) => {
    promptCalls += 1;
    if (promptCalls === 1) return originalPrompt(...args);
    retryOptions = args[4];
    return { kind: "completed", text: "retried", sessionFile: "session-oauth.jsonl" };
  };

  const result = await manager.enqueuePrompt(thread, "retry with same options", [], undefined, {
    signal: controller.signal,
    deferRegistryCompletion: true,
  });

  assert.equal(result.kind, "completed");
  assert.equal(promptCalls, 2);
  assert.equal(retryOptions.signal, controller.signal);
  assert.equal(retryOptions.deferRegistryCompletion, true);
});

test("aborted prompt signals abort the Pi session and do not clear registry active run", async () => {
  const patches = [];
  const thread = {
    threadId: "thread-abort",
    kind: "discord-thread",
    cwd: process.cwd(),
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const registry = {
    getThread() { return thread; },
    patchThread(_threadId, patch) {
      patches.push(patch);
      return Promise.resolve({ ...thread, ...patch });
    },
  };
  const manager = new PiRuntimeManager(defaultConfig(), registry);
  manager.reloadRuntimeAuth = async () => undefined;
  manager.scheduleDispose = () => undefined;

  let abortCalls = 0;
  let resolvePrompt;
  let resolvePromptStarted;
  const promptStarted = new Promise((resolve) => { resolvePromptStarted = resolve; });
  const controller = new AbortController();
  const session = {
    sessionFile: "session-abort.jsonl",
    isStreaming: false,
    messages: [],
    subscribe() { return () => undefined; },
    async prompt(text) {
      assert.equal(text, "work until aborted");
      resolvePromptStarted();
      await new Promise((resolve) => { resolvePrompt = resolve; });
    },
    async abort() {
      abortCalls += 1;
      resolvePrompt?.();
    },
    getLastAssistantText() { return "should not be returned"; },
    sessionManager: {
      getLeafEntry() { return undefined; },
      getEntries() { return []; },
      getSessionName() { return "Abort Test"; },
      buildSessionContext() { return { messages: [] }; },
    },
    agent: { state: { messages: [] } },
  };

  manager.getOrCreateRuntime = async () => ({ runtime: { session, dispose: async () => undefined } });

  const result = manager.enqueuePrompt(thread, "work until aborted", [], undefined, { signal: controller.signal });
  await promptStarted;
  controller.abort();

  await assert.rejects(result, /run-control lease loss/);
  assert.equal(abortCalls, 1);
  assert.equal(patches.some((patch) => patch.status === "idle" && patch.activeRun === undefined), false);
});

test("already-processing recovery aborts stale streaming state before retrying", async () => {
  const manager = createManager();
  let promptCalls = 0;
  let abortCalls = 0;
  let streaming = true;

  const session = {
    sessionFile: "session.jsonl",
    get isStreaming() {
      return streaming;
    },
    async prompt(text) {
      promptCalls += 1;
      assert.equal(text, "fresh prompt");
      if (promptCalls === 1) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      assert.equal(streaming, false, "already-processing retry should abort stale streaming first");
    },
    async abort() {
      abortCalls += 1;
      streaming = false;
    },
    sessionManager: {
      getLeafEntry() {
        return undefined;
      },
      buildSessionContext() {
        return { messages: [] };
      },
    },
    agent: { state: { messages: [] } },
  };

  await manager.promptWithAssistantLeafRecovery(session, "fresh prompt", [], () => undefined);

  assert.equal(promptCalls, 2);
  assert.equal(abortCalls, 1);
});
