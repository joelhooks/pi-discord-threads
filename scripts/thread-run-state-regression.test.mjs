import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import { decideRuntimePromptDisposition, hasVisibleActiveRun, isAlreadyProcessingError, isAssistantLeafContinueError, threadRunMachine } from "../dist/thread-run-state.js";

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

test("assistant leaf continuation guard is recognized for one-shot prompt retry", () => {
  assert.equal(isAssistantLeafContinueError(new Error("Cannot continue from message role: assistant")), true);
  assert.equal(isAssistantLeafContinueError(new Error("Agent is already processing")), false);
});

test("already-processing guard is recognized for stale runtime retry", () => {
  assert.equal(isAlreadyProcessingError(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")), true);
  assert.equal(isAlreadyProcessingError(new Error("Agent is already processing something unrelated")), false);
});
