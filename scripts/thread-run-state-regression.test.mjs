import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import {
  ACTIVE_RUN_PROMPT_LIMIT,
  buildActiveRunRecord,
  decideRuntimePromptDisposition,
  hasVisibleActiveRun,
  isAlreadyProcessingError,
  isAssistantLeafContinueError,
  parseQueueIntent,
  summarizeActiveRunPrompt,
  threadRunMachine,
} from "../dist/thread-run-state.js";

test("running thread prompt queues follow-up instead of starting duplicate run", () => {
  const actor = createActor(threadRunMachine).start();
  actor.send({ type: "PROMPT_REQUESTED" });
  actor.send({ type: "PLACEHOLDER_RENDERED" });
  assert.equal(actor.getSnapshot().value, "running");

  actor.send({ type: "PROMPT_REQUESTED" });
  assert.equal(actor.getSnapshot().value, "queuedFollowUp");
});

test("startup reconcile makes interrupted runs visible without auto-resume", () => {
  const actor = createActor(threadRunMachine).start();
  actor.send({ type: "BRIDGE_RESTART" });
  assert.equal(actor.getSnapshot().value, "interrupted");

  actor.send({ type: "STARTUP_RECONCILE" });
  assert.equal(actor.getSnapshot().value, "interruptedVisible");
});

test("runtime streaming queues only when Discord has a visible active run", () => {
  assert.deepEqual(decideRuntimePromptDisposition({ registryStatus: "running", hasRegistryActiveRun: true, runtimeStreaming: true, requestedMode: "followUp" }), {
    kind: "queue",
    mode: "followUp",
    reason: "runtime-streaming",
  });
});

test("untracked streaming runtime does not swallow fresh input", () => {
  assert.deepEqual(decideRuntimePromptDisposition({ registryStatus: "idle", hasRegistryActiveRun: false, runtimeStreaming: true, requestedMode: "followUp" }), {
    kind: "start",
  });
});

test("visible active run requires running status and activeRun metadata", () => {
  assert.equal(hasVisibleActiveRun({ registryStatus: "running", hasRegistryActiveRun: true }), true);
  assert.equal(hasVisibleActiveRun({ registryStatus: "idle", hasRegistryActiveRun: true }), false);
  assert.equal(hasVisibleActiveRun({ registryStatus: "interrupted", hasRegistryActiveRun: true }), false);
});

test("queue intent parses explicit follow-up aliases without changing normal steering text", () => {
  assert.deepEqual(parseQueueIntent("follow-up: check the logs"), { mode: "followUp", text: "check the logs" });
  assert.deepEqual(parseQueueIntent("follow up please"), { mode: "followUp", text: "please" });
  assert.deepEqual(parseQueueIntent("after run the tests"), { mode: "followUp", text: "run the tests" });
  assert.deepEqual(parseQueueIntent("later： summarize"), { mode: "followUp", text: "summarize" });
  assert.deepEqual(parseQueueIntent("follow-up"), { mode: "steer", text: "follow-up" });
  assert.deepEqual(parseQueueIntent("  ordinary steering  "), { mode: "steer", text: "  ordinary steering  " });
});

test("active run prompt summaries normalize whitespace and cap preview length", () => {
  const summary = summarizeActiveRunPrompt(`  ${"word\n".repeat(200)}`);
  assert.equal(summary.length, 500);
  assert.doesNotMatch(summary, /\n/);
  assert.equal(summarizeActiveRunPrompt("  short\nmessage  "), "short message");
});

test("active run records are deterministic and truncate recovery metadata", () => {
  const prompt = `${"x".repeat(ACTIVE_RUN_PROMPT_LIMIT + 10)}\nwith suffix`;
  const record = buildActiveRunRecord("source-1", "placeholder-1", prompt, "/tmp/session.jsonl", "run-1", {
    now: new Date("2026-06-21T00:00:00.000Z"),
  });

  assert.equal(record.runId, "run-1");
  assert.equal(record.sourceDiscordMessageId, "source-1");
  assert.equal(record.placeholderDiscordMessageId, "placeholder-1");
  assert.equal(record.sessionFile, "/tmp/session.jsonl");
  assert.equal(record.startedAt, "2026-06-21T00:00:00.000Z");
  assert.equal(record.updatedAt, "2026-06-21T00:00:00.000Z");
  assert.equal(record.prompt.length, ACTIVE_RUN_PROMPT_LIMIT + "\n\n[truncated by pi-discord-threads active-run recovery metadata]".length);
  assert.match(record.prompt, /\[truncated by pi-discord-threads active-run recovery metadata\]$/);
  assert.equal(record.promptPreview.length, 500);
});

test("assistant leaf continuation guard is recognized for one-shot prompt retry", () => {
  assert.equal(isAssistantLeafContinueError(new Error("Cannot continue from message role: assistant")), true);
  assert.equal(isAssistantLeafContinueError(new Error("Agent is already processing")), false);
});

test("already-processing guard is recognized for stale runtime retry", () => {
  assert.equal(isAlreadyProcessingError(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")), true);
  assert.equal(isAlreadyProcessingError(new Error("Agent is already processing something unrelated")), false);
});
