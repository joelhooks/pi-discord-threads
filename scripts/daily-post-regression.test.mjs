import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, normalizeConfig } from "../dist/config.js";
import { postDailyMessage } from "../dist/daily-post.js";
import {
  adoptDailyThreadSession,
  recordDailyThread,
} from "../dist/daily-thread-registry.js";
import { Registry } from "../dist/registry.js";

const tempConfig = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discord-daily-"));
  await mkdir(join(root, "daily-workspace"), { recursive: true });
  const dailyWorkspace = await realpath(join(root, "daily-workspace"));
  const config = normalizeConfig({
    ...defaultConfig(),
    dataDir: join(root, "data"),
    discord: {
      ...defaultConfig().discord,
      guildIds: ["guild-1"],
      contextChannels: {
        "daily-channel": { workspace: "daily" },
      },
    },
    pi: {
      ...defaultConfig().pi,
      defaultCwd: root,
      workspaces: {
        daily: dailyWorkspace,
      },
    },
  });
  return { root, config };
};

test("daily-post writes adoptable session metadata without touching the live registry file", async () => {
  const { root, config } = await tempConfig();
  const requestPath = join(root, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      schemaVersion: "pi-discord-threads-daily-post/v1",
      action: "start",
      channelId: "daily-channel",
      threadName: "2026-06-21 daily shitrat",
      runId: "brain-daily/2026-06-21",
      localDate: "2026-06-21",
      attemptId: "attempt-001",
      attemptDir: join(root, "attempt-001"),
      content: "Daily SHITRAT started.",
      sessionName: "Daily SHITRAT 2026-06-21",
    }),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).endsWith("/channels/daily-channel/threads")) {
      return Response.json({
        id: "daily-thread",
        name: "2026-06-21 daily shitrat",
        guild_id: "guild-1",
      });
    }
    if (String(url).endsWith("/channels/daily-thread/messages")) {
      return Response.json({
        id: "daily-message",
        channel_id: "daily-thread",
        guild_id: "guild-1",
      });
    }
    return Response.json({ error: "unexpected url" }, { status: 500 });
  };

  try {
    const result = await postDailyMessage({
      config,
      token: "fake-token",
      requestPath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.threadId, "daily-thread");
    assert.equal(result.registeredSession, true);
    assert.equal(result.cwd, config.pi.workspaces.daily);
    assert.equal(result.workspaceName, "daily");
    assert.equal(result.sessionName, "Daily SHITRAT 2026-06-21");
    assert.equal(calls.length, 2);

    assert.equal(existsSync(join(config.dataDir, "registry.json")), false);

    const dailyThreads = JSON.parse(
      await readFile(join(config.dataDir, "daily-threads.json"), "utf8")
    );
    const record = dailyThreads.threads["daily-channel:2026-06-21"];
    assert.equal(record.threadId, "daily-thread");
    assert.equal(record.cwd, config.pi.workspaces.daily);
    assert.equal(record.workspaceName, "daily");
    assert.equal(record.sessionName, "Daily SHITRAT 2026-06-21");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the live bot can adopt a known daily thread before routing a plain reply", async () => {
  const { root, config } = await tempConfig();
  const registry = new Registry(join(root, "registry.json"));
  await registry.load();

  await recordDailyThread(config, {
    channelId: "daily-channel",
    guildId: "guild-1",
    threadId: "daily-thread",
    threadName: "2026-06-21 daily shitrat",
    runId: "brain-daily/2026-06-21",
    localDate: "2026-06-21",
    session: {
      cwd: config.pi.workspaces.daily,
      workspaceName: "daily",
      sessionName: "Daily SHITRAT 2026-06-21",
    },
  });

  const adopted = await adoptDailyThreadSession(config, registry, "daily-thread");

  assert.ok(adopted);
  assert.equal(adopted.threadId, "daily-thread");
  assert.equal(adopted.kind, "discord-thread");
  assert.equal(adopted.parentChannelId, "daily-channel");
  assert.equal(adopted.guildId, "guild-1");
  assert.equal(adopted.status, "idle");
  assert.equal(adopted.cwd, config.pi.workspaces.daily);
  assert.equal(adopted.workspaceName, "daily");
  assert.equal(adopted.sessionName, "Daily SHITRAT 2026-06-21");
});
