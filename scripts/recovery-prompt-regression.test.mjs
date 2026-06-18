import assert from "node:assert/strict";
import test from "node:test";
import { isBridgeRecoveryPrompt, recoverableInterruptedPrompt } from "../dist/recovery-prompt.js";

const nestedRecoveryPrompt = `The previous Discord/Pi turn in this thread was interrupted by a bridge daemon restart before Discord received a final assistant answer.
Interrupted at: 2026-06-18T00:00:00.000Z

Interrupted request to recover:
The previous Discord/Pi turn in this thread was interrupted by a bridge daemon restart before Discord received a final assistant answer.`;

test("detects bridge recovery prompts", () => {
  assert.equal(isBridgeRecoveryPrompt(nestedRecoveryPrompt), true);
  assert.equal(isBridgeRecoveryPrompt("build the thing"), false);
});

test("does not treat bridge recovery prompt as recoverable user input", () => {
  assert.equal(recoverableInterruptedPrompt(nestedRecoveryPrompt), undefined);
  assert.equal(recoverableInterruptedPrompt("build the thing"), "build the thing");
});
