import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";
import { decideRuntimePromptDisposition, threadRunMachine } from "../dist/thread-run-state.js";

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

test("runtime streaming is the hard queue signal", () => {
  assert.deepEqual(decideRuntimePromptDisposition({ runtimeStreaming: true, requestedMode: "followUp" }), {
    kind: "queue",
    mode: "followUp",
    reason: "runtime-streaming",
  });
});

test("idle runtime starts even when registry has no active run", () => {
  assert.deepEqual(decideRuntimePromptDisposition({ registryStatus: "idle", hasRegistryActiveRun: false, runtimeStreaming: false }), {
    kind: "start",
  });
});
