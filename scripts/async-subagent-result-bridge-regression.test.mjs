import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findThreadForAsyncSubagentResult,
  formatAsyncSubagentResultMessage,
  processAsyncSubagentResultFile,
} from "../dist/discord/async-subagent-result-bridge.js";

function registry(records) {
  return { listThreads: () => records };
}

function record(id, patch = {}) {
  return {
    threadId: id,
    cwd: process.cwd(),
    status: "idle",
    ...patch,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-async-bridge-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("async subagent result matching checks persisted and active session files", () => {
  const idle = record("thread-idle", { sessionFile: "idle-session.jsonl" });
  const active = record("thread-active", {
    sessionFile: "old-session.jsonl",
    activeRun: { sessionFile: "active-session.jsonl" },
  });

  assert.equal(findThreadForAsyncSubagentResult(registry([idle, active]), { sessionId: "idle-session.jsonl" })?.threadId, "thread-idle");
  assert.equal(findThreadForAsyncSubagentResult(registry([idle, active]), { sessionFile: "active-session.jsonl" })?.threadId, "thread-active");
});

test("async subagent result matching prefers running thread when ambiguous", () => {
  const first = record("thread-first", { sessionFile: "same-session.jsonl", status: "idle" });
  const running = record("thread-running", { sessionFile: "same-session.jsonl", status: "running" });

  assert.equal(findThreadForAsyncSubagentResult(registry([first, running]), { sessionId: "same-session.jsonl" })?.threadId, "thread-running");
});

test("async subagent result formatting preserves status and child summaries", () => {
  assert.match(formatAsyncSubagentResultMessage({ agent: "reviewer", summary: "clean", durationMs: 65_000 }, "run-1"), /✅ Background subagent completed: \*\*reviewer\*\*[\s\S]*1m 5s/);
  assert.match(formatAsyncSubagentResultMessage({ agent: "reviewer", summary: "clean", durationMs: 60_000 }, "run-1b"), /1m$/m);
  assert.match(formatAsyncSubagentResultMessage({ state: "paused", success: false, results: [{ agent: "worker", output: "needs input" }] }, "run-2"), /^⏸️ Background subagent paused: \*\*worker\*\*/);
  assert.match(formatAsyncSubagentResultMessage({ success: false, results: [{ agent: "worker", success: false, error: "boom", output: "trace" }] }, "run-3"), /❌ Background subagent failed:[\s\S]*boom\n\ntrace/);
  assert.match(formatAsyncSubagentResultMessage({ mode: "parallel", results: [{ agent: "a" }, { agent: "b" }] }, "run-4"), /\*\*parallel:a\+b\*\*/);
  assert.match(formatAsyncSubagentResultMessage({ mode: "chain", results: [{ agent: "a" }, { agent: "b" }] }, "run-5"), /\*\*chain:a->b\*\*/);
});

test("processing a matching result publishes chunks then deletes the file", async () => {
  await withTempDir(async (dir) => {
    const file = "result.json";
    const resultPath = join(dir, file);
    await writeFile(resultPath, JSON.stringify({ runId: "run-ok", sessionId: "session.jsonl", summary: "done" }));

    const published = [];
    await processAsyncSubagentResultFile({
      registry: registry([record("thread-1", { sessionFile: "session.jsonl" })]),
      maxDiscordChars: 30,
      resultsDir: dir,
      publish: async (matchedRecord, chunks) => {
        published.push({ matchedRecord, chunks });
      },
      warn: () => undefined,
    }, file);

    assert.equal(published.length, 1);
    assert.equal(published[0].matchedRecord.threadId, "thread-1");
    assert.equal(published[0].chunks.length > 1, true);
    assert.equal(await exists(resultPath), false);
  });
});

test("publish failure leaves result file and removes seen key for retry", async () => {
  await withTempDir(async (dir) => {
    const file = "retry.json";
    const resultPath = join(dir, file);
    await writeFile(resultPath, JSON.stringify({ runId: "run-retry", timestamp: 1, sessionId: "session.jsonl", summary: "done" }));

    const seen = new Set();
    let attempts = 0;
    const options = {
      registry: registry([record("thread-1", { sessionFile: "session.jsonl" })]),
      maxDiscordChars: 2_000,
      resultsDir: dir,
      publish: async () => {
        attempts++;
        throw new Error("discord down");
      },
      warn: () => undefined,
    };

    await processAsyncSubagentResultFile(options, file, seen);
    await processAsyncSubagentResultFile(options, file, seen);

    assert.equal(attempts, 2);
    assert.equal(await exists(resultPath), true);
    assert.equal(JSON.parse(await readFile(resultPath, "utf8")).runId, "run-retry");
  });
});

test("unknown or invalid result files are left for later inspection", async () => {
  await withTempDir(async (dir) => {
    const unknownFile = "unknown.json";
    const invalidFile = "invalid.json";
    await writeFile(join(dir, unknownFile), JSON.stringify({ runId: "run-missing", sessionId: "missing.jsonl" }));
    await writeFile(join(dir, invalidFile), "not-json");

    const warnings = [];
    await processAsyncSubagentResultFile({
      registry: registry([]),
      maxDiscordChars: 2_000,
      resultsDir: dir,
      publish: async () => {
        throw new Error("must not publish");
      },
      warn: (message) => warnings.push(message),
    }, unknownFile);
    await processAsyncSubagentResultFile({
      registry: registry([]),
      maxDiscordChars: 2_000,
      resultsDir: dir,
      publish: async () => {
        throw new Error("must not publish");
      },
      warn: (message) => warnings.push(message),
    }, invalidFile);

    assert.equal(await exists(join(dir, unknownFile)), true);
    assert.equal(await exists(join(dir, invalidFile)), true);
    assert.match(warnings.join("\n"), /failed to read async subagent result/);
  });
});
