import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { PiRuntimeManager } from "../dist/pi-runtime.js";

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
