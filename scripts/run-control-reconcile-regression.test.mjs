import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { reconcileRunControl } from "../dist/run-control/reconcile.js";

function createRun(id, status = "running") {
  const now = new Date(0).toISOString();
  return {
    runId: id,
    logicalThreadId: "thread-1",
    threadId: "thread-1",
    kind: "discord-thread",
    status,
    sourceDiscordMessageId: `source-${id}`,
    placeholderDiscordMessageId: `placeholder-${id}`,
    prompt: `prompt ${id}`,
    promptPreview: `prompt ${id}`,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
  };
}

function createHarness({ activeRunId, runStatus = "running" } = {}) {
  const runs = new Map([["run-stale", createRun("run-stale", runStatus)]]);
  const activePointers = activeRunId ? [{ logicalThreadId: "thread-1", runId: activeRunId }] : [];
  const terminalMarks = [];
  const store = {
    async listRuns() {
      return [...runs.values()];
    },
    async listActivePointers() {
      return activePointers;
    },
    async getRun(runId) {
      return runs.get(runId);
    },
    async getRunLeaseTtl() {
      return -2;
    },
    async clearActiveIfMatches() {
      return true;
    },
    async patchRun(runId, patch) {
      const current = runs.get(runId);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      runs.set(runId, next);
      return next;
    },
    async markTerminal(runId, status, patch = {}) {
      const current = runs.get(runId);
      if (!current) return undefined;
      const next = { ...current, ...patch, status, finalizedAt: patch.finalizedAt ?? new Date(0).toISOString() };
      runs.set(runId, next);
      terminalMarks.push({ runId, status, patch });
      return next;
    },
  };
  const registry = {
    getThread() {
      return { threadId: "thread-1", status: "interrupted" };
    },
    listThreads() {
      return [];
    },
    async patchThread() {},
    async save() {},
  };
  return { store, registry, terminalMarks, runs };
}

test("reconcile reports non-terminal Redis runs that have no active pointer", async () => {
  const harness = createHarness();

  const report = await reconcileRunControl({
    store: harness.store,
    registry: harness.registry,
    config: defaultConfig(),
    apply: false,
  });

  assert.equal(report.issues.some((issue) => issue.code === "nonterminal-run-without-active-pointer"), true);
  assert.equal(harness.terminalMarks.length, 0);
});

test("reconcile apply interrupts non-terminal Redis runs that have no active pointer", async () => {
  const harness = createHarness();

  const report = await reconcileRunControl({
    store: harness.store,
    registry: harness.registry,
    config: defaultConfig(),
    apply: true,
  });

  assert.equal(report.applied.includes("marked non-active run run-stale interrupted"), true);
  assert.deepEqual(harness.terminalMarks.map((mark) => [mark.runId, mark.status]), [["run-stale", "interrupted"]]);
  assert.equal(harness.runs.get("run-stale").status, "interrupted");
  assert.match(harness.runs.get("run-stale").error, /no active pointer/);
  assert.equal(typeof harness.runs.get("run-stale").placeholderRetiredAt, "string");
});

test("reconcile reports non-terminal Redis runs superseded by a different active pointer", async () => {
  const harness = createHarness({ activeRunId: "run-newer" });

  const report = await reconcileRunControl({
    store: harness.store,
    registry: harness.registry,
    config: defaultConfig(),
    apply: false,
  });

  const issue = report.issues.find((candidate) => candidate.code === "nonterminal-run-not-active");
  assert.ok(issue);
  assert.match(issue.message, /run-newer/);
});
