import assert from "node:assert/strict";
import test from "node:test";
import {
  clipTitleEvidence,
  recordCompletedTitleTurn,
  shouldApplyThreadTitleProposal,
  shouldEvaluateThreadTitle,
  shouldRenameThread,
} from "../dist/discord/thread-title.js";

const titleConfig = {
  enabled: true,
  model: "openai-codex/gpt-5.5",
  firstEvaluationTurn: 3,
  evaluationIntervalTurns: 2,
  minRenameIntervalMs: 60_000,
};

test("prompt rename only replaces bridge-owned placeholder titles", () => {
  assert.equal(shouldRenameThread("pi session", "🧵 Discord HUD Refactor"), true);
  assert.equal(shouldRenameThread("π resume old run", "🧵 Discord HUD Refactor"), true);
  assert.equal(shouldRenameThread("🧵 Human Named Thread", "🧵 Discord HUD Refactor"), false);
  assert.equal(shouldRenameThread("pi session", ""), false);
});

test("title evaluation cadence waits for enough completed turns", () => {
  assert.equal(shouldEvaluateThreadTitle({ turnCount: 2, recentTurns: [] }, titleConfig), false);
  assert.equal(shouldEvaluateThreadTitle({ turnCount: 3, recentTurns: [] }, titleConfig), true);
  assert.equal(shouldEvaluateThreadTitle({ turnCount: 4, lastEvaluatedTurn: 3, recentTurns: [] }, titleConfig), false);
  assert.equal(shouldEvaluateThreadTitle({ turnCount: 5, lastEvaluatedTurn: 3, recentTurns: [] }, titleConfig), true);
});

test("title proposal application protects human titles and recent renames", () => {
  const state = { turnCount: 5, recentTurns: [] };
  assert.equal(shouldApplyThreadTitleProposal("π Session", "🧵 Discord HUD Refactor", state, titleConfig, 0.9), true);
  assert.equal(shouldApplyThreadTitleProposal("Human Named Thread", "🧵 Discord HUD Refactor", state, titleConfig, 0.9), false);
  assert.equal(shouldApplyThreadTitleProposal("π Session", "🧵 Discord HUD Refactor", state, titleConfig, 0.5), false);
  assert.equal(shouldApplyThreadTitleProposal("π Session", "🧵 Discord HUD Refactor", {
    ...state,
    lastRenamedAt: new Date().toISOString(),
  }, titleConfig, 0.9), false);
});

test("completed title turns keep compact bounded evidence", async () => {
  let current = { threadId: "thread-title-1", cwd: process.cwd(), status: "idle" };
  const registry = {
    getThread: () => current,
    patchThread: async (_threadId, patch) => {
      current = { ...current, ...patch };
      return current;
    },
  };

  for (let i = 0; i < 14; i++) {
    await recordCompletedTitleTurn(registry, current, `user ${i}`, `assistant ${i}`);
  }

  assert.equal(current.titleState.turnCount, 14);
  assert.equal(current.titleState.recentTurns.length, 12);
  assert.equal(current.titleState.recentTurns[0].user, "user 2");

  const clipped = clipTitleEvidence(`  ${"word ".repeat(400)}  `);
  assert.equal(clipped.length <= 1_520, true);
  assert.match(clipped, /truncated/);
});
