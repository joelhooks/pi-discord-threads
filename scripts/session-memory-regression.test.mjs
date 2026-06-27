import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendSessionMemoryLink, brainPathToNotesRoute, formatSessionMemoryLine, writeSessionMemory } from "../dist/session-memory.js";
import { defaultConfig } from "../dist/config.js";

function makeRecord(cwd) {
  return {
    threadId: "discord-thread-id-stays-hashed",
    kind: "discord-thread",
    cwd,
    workspaceName: "Portal Test",
    status: "running",
    sessionFile: "session.jsonl",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

test("brainPathToNotesRoute maps Brain pages to Document Host routes", () => {
  assert.equal(brainPathToNotesRoute(".brain/projects/project-memory-portal.svx"), "/notes/projects/project-memory-portal");
  assert.equal(brainPathToNotesRoute("projects/foo.svx"), "/notes/projects/foo");
  assert.equal(brainPathToNotesRoute(".brain/index.svx"), "/notes");
});

test("writeSessionMemory writes hashed workstream data and stable portal link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-memory-"));
  await writeFile(join(dir, ".keep"), "");
  await mkdir(join(dir, ".brain", "projects"), { recursive: true });
  await writeFile(join(dir, ".brain", "projects", "project-memory-portal.svx"), "# Project Memory Portal\n");

  const config = defaultConfig();
  config.render.sessionMemory.tailnetBaseUrl = undefined;
  const link = await writeSessionMemory({
    config,
    record: makeRecord(dir),
    prompt: "Please implement the portal tracer bullet",
    resultText: "Implemented the portal tracer bullet with a stable memory link and JSON records.",
    runId: "run-1",
    userEntryId: "user-1",
    assistantEntryId: "assistant-1",
  });

  assert.ok(link);
  assert.equal(link.brainPath, ".brain/projects/project-memory-portal.svx");
  assert.equal(link.routePath, "/notes/projects/project-memory-portal");
  assert.equal(link.verified, false);
  assert.equal(link.verificationStatus, "not_configured");
  assert.match(link.workstreamId, /^portal-test-[a-f0-9]{10}$/);
  assert.equal(formatSessionMemoryLine(link), "Session memory: .brain/projects/project-memory-portal.svx (no verified phone-safe URL yet)");
  assert.match(appendSessionMemoryLink("Done.", link), /Session memory: \.brain\/projects\/project-memory-portal\.svx/);

  const dataPath = join(dir, link.dataPath);
  const workstream = JSON.parse(await readFile(dataPath, "utf8"));
  assert.equal(workstream.source.threadKey.length, 10);
  assert.equal(JSON.stringify(workstream).includes("discord-thread-id-stays-hashed"), false);
  assert.equal(workstream.turns.length, 1);
  assert.equal(workstream.turns[0].assistantEntryId, "assistant-1");

  const index = JSON.parse(await readFile(join(dir, ".brain", "data", "session-memory", "index.json"), "utf8"));
  assert.equal(index.workstreams.length, 1);
  assert.equal(index.workstreams[0].workstreamId, link.workstreamId);
});

test("writeSessionMemory redacts Discord identifiers and upserts retried turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-memory-redact-"));
  await mkdir(join(dir, ".brain", "projects"), { recursive: true });
  await writeFile(join(dir, ".brain", "projects", "project-memory-portal.svx"), "# Project Memory Portal\n");

  const config = defaultConfig();
  const record = {
    ...makeRecord(dir),
    workspaceName: undefined,
    sessionName: "Discord 123456789012345678",
  };
  const input = {
    config,
    record,
    prompt: "Ping <@123456789012345678> in https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
    resultText: "Handled channel <#444444444444444444> and user 555555555555555555.",
    runId: "run-redact",
    assistantEntryId: "assistant-redact",
  };

  const first = await writeSessionMemory(input);
  const second = await writeSessionMemory(input);
  assert.ok(first);
  assert.ok(second);
  assert.match(first.workstreamId, /^session-memory-redact-[a-z0-9]+-[a-f0-9]{10}$/);

  const workstream = JSON.parse(await readFile(join(dir, second.dataPath), "utf8"));
  const serialized = JSON.stringify(workstream);
  assert.equal(workstream.turns.length, 1);
  assert.equal(serialized.includes("123456789012345678"), false);
  assert.equal(serialized.includes("555555555555555555"), false);
  assert.equal(serialized.includes("discord.com/channels"), false);
  assert.match(serialized, /\[discord-ref\]|\[discord-id\]|\[discord-message-link\]/);
});

test("writeSessionMemory refuses non-phone-safe portal base URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-memory-url-"));
  await mkdir(join(dir, ".brain", "projects"), { recursive: true });
  await writeFile(join(dir, ".brain", "projects", "project-memory-portal.svx"), "# Project Memory Portal\n");

  const config = defaultConfig();
  config.render.sessionMemory.tailnetBaseUrl = "http://127.0.0.1:4321";
  const link = await writeSessionMemory({
    config,
    record: makeRecord(dir),
    prompt: "test",
    resultText: "done",
    runId: "run-url",
  });

  assert.ok(link);
  assert.equal(link.url, undefined);
  assert.equal(link.verified, false);
  assert.equal(link.verificationStatus, "unverified");
  assert.match(link.verificationError, /HTTPS|loopback/);
  assert.equal(formatSessionMemoryLine(link), "Session memory: .brain/projects/project-memory-portal.svx (no verified phone-safe URL yet)");
});
