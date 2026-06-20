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

test("link ingest needs_human status survives registry reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-registry-lifecycle-"));
  try {
    const filePath = join(dir, "registry.json");
    const registry = new Registry(filePath);
    await registry.load();
    await registry.upsertLinkIngest({
      sourceId: "source-1",
      mentionId: "discord:guild:channel:message",
      eventId: "link-ingest:discord:guild:channel:message",
      eventName: "link/ingest.requested",
      url: "https://example.com/",
      normalizedUrl: "https://example.com/",
      threadId: "thread-1",
      channelId: "channel-1",
      discordMessageId: "message-1",
      status: "needs_human",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    await registry.recordLinkIngestStatusUpdate({
      statusKey: "pi/workflow.needs_human:discord:guild:channel:message",
      eventName: "pi/workflow.needs_human",
      sourceId: "source-1",
      mentionId: "discord:guild:channel:message",
      status: "needs_human",
      discordMessageId: "assistant-1",
      postedAt: new Date(1).toISOString(),
    });

    const reloaded = new Registry(filePath);
    await reloaded.load();
    const record = reloaded.getLinkIngest("discord:guild:channel:message");
    assert.equal(record?.status, "needs_human");
    assert.equal(record?.statusUpdates?.["pi/workflow.needs_human:discord:guild:channel:message"]?.status, "needs_human");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link ingest progress updates can be recorded without Discord process cards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-registry-lifecycle-"));
  try {
    const registry = new Registry(join(dir, "registry.json"));
    await registry.load();
    await registry.upsertLinkIngest({
      sourceId: "source-1",
      mentionId: "discord:guild:channel:message",
      eventId: "link-ingest:discord:guild:channel:message",
      eventName: "link/ingest.requested",
      url: "https://example.com/",
      normalizedUrl: "https://example.com/",
      threadId: "thread-1",
      channelId: "channel-1",
      discordMessageId: "message-1",
      status: "accepted",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    await registry.recordLinkIngestStatusUpdate({
      statusKey: "source/archive.completed:discord:guild:channel:message",
      eventName: "source/archive.completed",
      sourceId: "source-1",
      mentionId: "discord:guild:channel:message",
      status: "archived",
      discordPostSkippedReason: "progress-event-recorded-only",
      postedAt: new Date(1).toISOString(),
    });

    const record = registry.getLinkIngest("discord:guild:channel:message");
    assert.equal(record?.status, "archived");
    const update = record?.statusUpdates?.["source/archive.completed:discord:guild:channel:message"];
    assert.equal(update?.eventName, "source/archive.completed");
    assert.equal(update?.discordMessageId, undefined);
    assert.equal(update?.discordPostSkippedReason, "progress-event-recorded-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
