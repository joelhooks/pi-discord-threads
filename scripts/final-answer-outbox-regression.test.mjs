import assert from "node:assert/strict";
import test from "node:test";
import { deliverFinalAnswerOutbox, finalAnswerOutboxNonce } from "../dist/discord/final-answer-outbox.js";

const record = {
  threadId: "thread-1",
  kind: "discord-thread",
  cwd: process.cwd(),
  status: "running",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const run = {
  runId: "run-outbox-1",
  logicalThreadId: "thread-1",
  threadId: "thread-1",
  kind: "discord-thread",
  status: "finalizing",
  sourceDiscordMessageId: "source-1",
  placeholderDiscordMessageId: "placeholder-1",
  prompt: "hello",
  promptPreview: "hello",
  cwd: process.cwd(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

class FakeMessage {
  constructor(id, content, nonce, events) {
    this.id = id;
    this.content = content;
    this.nonce = nonce;
    this.events = events;
  }

  async edit(options) {
    this.content = typeof options === "string" ? options : options.content;
    this.events.push(`edit:${this.id}:${this.content}`);
    return this;
  }
}

class FakeChannel {
  constructor(events) {
    this.events = events;
    this.created = 0;
    this.byId = new Map();
    this.fetchErrors = new Map();
    this.messages = {
      fetch: async (messageId) => {
        const fetchError = this.fetchErrors.get(messageId);
        if (fetchError) throw fetchError;
        const message = this.byId.get(messageId);
        if (!message) {
          const error = new Error(`Unknown Message ${messageId}`);
          error.code = 10008;
          error.status = 404;
          throw error;
        }
        return message;
      },
    };
  }

  add(message) {
    this.byId.set(message.id, message);
  }

  async send(options) {
    const existing = [...this.byId.values()].find((message) => options.enforceNonce && message.nonce === options.nonce);
    this.events.push(`send:${options.nonce}`);
    if (existing) return existing;
    const message = new FakeMessage(`message-${++this.created}`, options.content, options.nonce, this.events);
    this.add(message);
    return message;
  }
}

function createStore(initialRun = run, events = []) {
  let currentRun = { ...initialRun };
  return {
    get currentRun() { return currentRun; },
    getRun: async () => currentRun,
    patchRun: async (_runId, patch) => {
      currentRun = { ...currentRun, ...patch };
      if (patch.finalDiscordMessageIds) events.push(`patch:ids:${patch.finalDiscordMessageIds.join(",")}`);
      if (patch.finalDiscordPostedAt) events.push("patch:posted");
      return currentRun;
    },
    appendRunEvent: async (_runId, type) => {
      events.push(`event:${type}`);
      return `event-${events.length}`;
    },
  };
}

function createRegistry(events = []) {
  return {
    recordMessage: async (message) => {
      events.push(`registry:message:${message.discordMessageId}`);
    },
    recordMessageEntry: async (messageId, entryId) => {
      events.push(`registry:entry:${messageId}:${entryId}`);
    },
  };
}

test("final answer outbox persists reserved message ids before editing final content", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  const store = createStore(run, events);
  const registry = createRegistry(events);

  await deliverFinalAnswerOutbox({
    channel,
    record,
    registry,
    store,
    run,
    chunks: ["first chunk", "second chunk"],
    assistantEntryId: "assistant-1",
  });

  assert.deepEqual(store.currentRun.finalDiscordMessageIds, ["message-1", "message-2"]);
  assert.equal(channel.byId.get("message-1").content, "first chunk");
  assert.equal(channel.byId.get("message-2").content, "second chunk");
  assert.ok(events.indexOf("patch:ids:message-1") < events.indexOf("edit:message-1:first chunk"));
  assert.ok(events.indexOf("patch:ids:message-1,message-2") < events.indexOf("edit:message-2:second chunk"));
  assert.ok(events.includes("registry:entry:message-1:assistant-1"));
});

test("final answer outbox retry edits existing reserved messages without sending new ones", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  channel.add(new FakeMessage("message-1", "reserved 1", finalAnswerOutboxNonce(run.runId, 0), events));
  channel.add(new FakeMessage("message-2", "reserved 2", finalAnswerOutboxNonce(run.runId, 1), events));
  const store = createStore({ ...run, finalDiscordMessageIds: ["message-1", "message-2"] }, events);
  const registry = createRegistry(events);

  await deliverFinalAnswerOutbox({
    channel,
    record,
    registry,
    store,
    run: store.currentRun,
    chunks: ["retry first", "retry second"],
    assistantEntryId: "assistant-2",
  });

  assert.equal(events.some((event) => event.startsWith("send:")), false);
  assert.equal(channel.byId.get("message-1").content, "retry first");
  assert.equal(channel.byId.get("message-2").content, "retry second");
  assert.ok(events.includes("registry:entry:message-1:assistant-2"));
});

test("final answer outbox does not send a replacement when persisted id fetch fails transiently", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  const error = new Error("network reset");
  error.code = "ECONNRESET";
  channel.fetchErrors.set("message-1", error);
  const store = createStore({ ...run, finalDiscordMessageIds: ["message-1"] }, events);
  const registry = createRegistry(events);

  await assert.rejects(
    deliverFinalAnswerOutbox({
      channel,
      record,
      registry,
      store,
      run: store.currentRun,
      chunks: ["should retry later"],
      assistantEntryId: "assistant-transient",
    }),
    /network reset/,
  );

  assert.equal(events.some((event) => event.startsWith("send:")), false);
});

test("final answer outbox replaces a persisted id only when Discord proves the old message is gone", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  const store = createStore({ ...run, finalDiscordMessageIds: ["message-missing"] }, events);
  const registry = createRegistry(events);

  await deliverFinalAnswerOutbox({
    channel,
    record,
    registry,
    store,
    run: store.currentRun,
    chunks: ["replacement final"],
    assistantEntryId: "assistant-replacement",
  });

  assert.deepEqual(store.currentRun.finalDiscordMessageIds, ["message-1"]);
  assert.equal(channel.byId.get("message-1").content, "replacement final");
  assert.equal(events.some((event) => event.startsWith("send:")), true);
});

test("final answer outbox refuses to blind-send missing chunks after nonce window", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  channel.add(new FakeMessage("message-1", "first final", finalAnswerOutboxNonce(run.runId, 0), events));
  const store = createStore({
    ...run,
    finalDiscordOutboxStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    finalDiscordMessageIds: ["message-1"],
    finalDiscordChunkCount: 2,
  }, events);
  const registry = createRegistry(events);

  await assert.rejects(
    deliverFinalAnswerOutbox({
      channel,
      record,
      registry,
      store,
      run: store.currentRun,
      chunks: ["first final", "missing second"],
      assistantEntryId: "assistant-partial",
    }),
    /refusing blind send/,
  );

  assert.equal(events.some((event) => event.startsWith("send:")), false);
});

test("final answer outbox nonce recovers a reservation sent before Redis persisted the id", async () => {
  const events = [];
  const channel = new FakeChannel(events);
  const preexisting = new FakeMessage("message-existing", "reservation survived crash", finalAnswerOutboxNonce(run.runId, 0), events);
  channel.add(preexisting);
  const store = createStore(run, events);
  const registry = createRegistry(events);

  await deliverFinalAnswerOutbox({
    channel,
    record,
    registry,
    store,
    run,
    chunks: ["filled after retry"],
    assistantEntryId: "assistant-3",
  });

  assert.deepEqual(store.currentRun.finalDiscordMessageIds, ["message-existing"]);
  assert.equal(channel.created, 0);
  assert.equal(preexisting.content, "filled after retry");
});
