import assert from "node:assert/strict";
import test from "node:test";
import { waitFor } from "xstate";
import { defaultConfig } from "../dist/config.js";
import { DiscordMessageRenderer } from "../dist/discord/message-renderer.js";
import { buildArchivedHudPayload } from "../dist/discord/payloads.js";
import { createProgressHudController } from "../dist/discord/progress-hud-machine.js";

function makeRecord(overrides = {}) {
  return {
    threadId: "thread-hud-1",
    kind: "discord-thread",
    cwd: process.cwd(),
    status: "running",
    sessionFile: "session.jsonl",
    workspaceName: "pi-discord-threads",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    activeRun: {
      sourceDiscordMessageId: "source-hud-1",
      placeholderDiscordMessageId: "placeholder-hud-1",
      prompt: "test HUD",
      promptPreview: "test HUD",
      startedAt: new Date(0).toISOString(),
      sessionFile: "session.jsonl",
    },
    ...overrides,
  };
}

function makeMessage() {
  return {
    id: "placeholder-hud-1",
    edits: [],
    deletes: 0,
    async edit(payload) {
      this.edits.push(payload);
      return this;
    },
    async delete() {
      this.deletes += 1;
      return this;
    },
  };
}

test("DiscordMessageRenderer queues, dedupes, and deactivates without deleting", async () => {
  const message = makeMessage();
  const renderer = new DiscordMessageRenderer(message);
  const firstPayload = { content: "working", embeds: [], components: [] };

  await renderer.render(firstPayload);
  await renderer.render(firstPayload);
  await renderer.deactivate({ content: "done", embeds: [], components: [] });

  assert.equal(message.deletes, 0);
  assert.equal(message.edits.length, 2);
  assert.equal(message.edits[0].content, "working");
  assert.equal(message.edits[1].content, "done");
});

test("archived HUD renders session memory card when a stable link is available", () => {
  const record = makeRecord();
  const archived = buildArchivedHudPayload(record, {
    sessionMemory: {
      label: "pi-discord-threads",
      brainPath: ".brain/projects/project-memory-portal.svx",
      routePath: "/notes/projects/project-memory-portal",
      workstreamId: "pi-discord-threads-test",
      verified: false,
      verificationStatus: "not_configured",
      summary: "Captured the portal tracer bullet.",
    },
  });
  const json = JSON.stringify(archived);

  assert.match(json, /Done: Captured the portal tracer bullet\./);
  assert.match(json, /\*\*Memory\*\*/);
  assert.match(json, /\.brain\/projects\/project-memory-portal\.svx \(no verified phone-safe URL yet\)/);
  assert.match(json, /session memory refreshed/);
});

test("Progress HUD controller exposes latest state for persistent archived HUD", async () => {
  const message = makeMessage();
  const renderer = new DiscordMessageRenderer(message);
  const config = defaultConfig();
  config.render.hud.enabled = false;
  config.render.hud.updateIntervalMs = 25;
  config.render.threadTitles.enabled = false;
  const record = makeRecord();
  const controller = createProgressHudController({ renderer, record, prompt: "test HUD", config });

  controller.update({
    phase: "tool",
    title: "Reading file",
    detail: "Inspecting src/discord-bot.ts",
    toolName: "read",
    sessionName: "HUD Refactor",
  });

  await waitFor(controller.actor, () => message.edits.length > 0, { timeout: 1_000 });
  const snapshot = controller.snapshot();
  await controller.stop();

  const archived = buildArchivedHudPayload(snapshot.record, snapshot);
  const json = JSON.stringify(archived);

  assert.match(json, /HUD Refactor/);
  assert.match(json, /Inspecting src\/discord-bot\.ts|Reading file/);
  assert.match(json, /final answer posted below; ready for the next turn/);
  assert.match(json, /"disabled":true/);
  assert.equal(message.deletes, 0);
});
