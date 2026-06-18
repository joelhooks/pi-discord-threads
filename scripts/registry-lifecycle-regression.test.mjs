import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Registry } from "../dist/registry.js";

const activeRun = {
  sourceDiscordMessageId: "source-1",
  placeholderDiscordMessageId: "placeholder-1",
  prompt: "continue",
  promptPreview: "continue",
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

test("idle thread records cannot retain stale activeRun metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-registry-lifecycle-"));
  try {
    const registry = new Registry(join(dir, "registry.json"));
    await registry.load();
    await registry.upsertThread({
      threadId: "thread-1",
      cwd: dir,
      status: "running",
      activeRun,
    });

    const idle = await registry.patchThread("thread-1", { status: "idle" });
    assert.equal(idle.activeRun, undefined);

    const upsertedIdle = await registry.upsertThread({
      threadId: "thread-1",
      cwd: dir,
      status: "idle",
    });
    assert.equal(upsertedIdle.activeRun, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued thread records keep activeRun metadata without pretending to run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-registry-lifecycle-"));
  try {
    const registry = new Registry(join(dir, "registry.json"));
    await registry.load();
    const queued = await registry.upsertThread({
      threadId: "thread-2",
      cwd: dir,
      status: "queued",
      activeRun,
    });
    assert.equal(queued.status, "queued");
    assert.equal(queued.activeRun?.placeholderDiscordMessageId, activeRun.placeholderDiscordMessageId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted thread records keep activeRun recovery metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-registry-lifecycle-"));
  try {
    const registry = new Registry(join(dir, "registry.json"));
    await registry.load();
    const interrupted = await registry.upsertThread({
      threadId: "thread-3",
      cwd: dir,
      status: "interrupted",
      activeRun,
    });
    assert.equal(interrupted.activeRun?.placeholderDiscordMessageId, activeRun.placeholderDiscordMessageId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
