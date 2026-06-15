import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { expandPath } from "./config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const PUBLIC_THREAD = 11;
const ONE_DAY_ARCHIVE_MINUTES = 1440;

interface DailyPostRequest {
  readonly schemaVersion: "pi-discord-threads-daily-post/v1";
  readonly action: "start" | "final";
  readonly channelId: string;
  readonly threadName: string;
  readonly runId: string;
  readonly localDate: string;
  readonly attemptId: string;
  readonly attemptDir: string;
  readonly content: string;
  readonly threadId?: string;
}

interface DailyThreadRecord {
  readonly key: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly runId: string;
  readonly localDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DailyThreadRegistry {
  readonly version: 1;
  readonly threads: Record<string, DailyThreadRecord>;
}

interface DiscordChannel {
  readonly id: string;
  readonly name?: string;
}

interface DiscordMessage {
  readonly id: string;
  readonly channel_id?: string;
}

export interface DailyPostResult {
  readonly ok: boolean;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly threadName: string;
  readonly createdThread?: boolean;
  readonly error?: string;
}

const registryPath = (config: AppConfig): string =>
  join(config.dataDir, "daily-threads.json");

const threadKey = (request: DailyPostRequest): string =>
  `${request.channelId}:${request.localDate}`;

const readJson = async <A>(path: string): Promise<A | undefined> => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as A;
  } catch {
    return undefined;
  }
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
};

const loadRegistry = async (config: AppConfig): Promise<DailyThreadRegistry> =>
  (await readJson<DailyThreadRegistry>(registryPath(config))) ?? {
    version: 1,
    threads: {},
  };

const saveRegistry = async (
  config: AppConfig,
  registry: DailyThreadRegistry
): Promise<void> => writeJsonAtomic(registryPath(config), registry);

const decodeRequest = (value: unknown): DailyPostRequest => {
  const request = value as Partial<DailyPostRequest>;
  if (request.schemaVersion !== "pi-discord-threads-daily-post/v1") {
    throw new Error("Unsupported daily-post request schema.");
  }
  if (request.action !== "start" && request.action !== "final") {
    throw new Error("daily-post action must be start or final.");
  }
  for (const field of [
    "channelId",
    "threadName",
    "runId",
    "localDate",
    "attemptId",
    "attemptDir",
    "content",
  ] as const) {
    if (!request[field] || typeof request[field] !== "string") {
      throw new Error(`daily-post request missing ${field}.`);
    }
  }
  const channelId = request.channelId;
  const threadName = request.threadName;
  const runId = request.runId;
  const localDate = request.localDate;
  const attemptId = request.attemptId;
  const attemptDir = request.attemptDir;
  const content = request.content;
  if (
    !channelId ||
    !threadName ||
    !runId ||
    !localDate ||
    !attemptId ||
    !attemptDir ||
    !content
  ) {
    throw new Error("daily-post request failed validation.");
  }
  return {
    schemaVersion: request.schemaVersion,
    action: request.action,
    channelId,
    threadName,
    runId,
    localDate,
    attemptId,
    attemptDir,
    content,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  };
};

const discordJson = async <A>(
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<A> => {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token.trim()}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as A) : ({} as A);
  if (!response.ok) {
    throw new Error(
      `Discord ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }
  return parsed;
};

const createThread = async (
  token: string,
  request: DailyPostRequest
): Promise<DiscordChannel> =>
  discordJson<DiscordChannel>(
    token,
    "POST",
    `/channels/${encodeURIComponent(request.channelId)}/threads`,
    {
      name: request.threadName,
      auto_archive_duration: ONE_DAY_ARCHIVE_MINUTES,
      type: PUBLIC_THREAD,
    }
  );

const unarchiveThread = async (token: string, threadId: string): Promise<void> => {
  await discordJson<DiscordChannel>(
    token,
    "PATCH",
    `/channels/${encodeURIComponent(threadId)}`,
    { archived: false }
  );
};

const sendMessage = async (
  token: string,
  threadId: string,
  content: string
): Promise<DiscordMessage> =>
  discordJson<DiscordMessage>(
    token,
    "POST",
    `/channels/${encodeURIComponent(threadId)}/messages`,
    { content }
  );

const sendMessageWithUnarchive = async (
  token: string,
  threadId: string,
  content: string
): Promise<DiscordMessage> => {
  try {
    return await sendMessage(token, threadId, content);
  } catch (error) {
    await unarchiveThread(token, threadId);
    return sendMessage(token, threadId, content);
  }
};

export async function postDailyMessage(options: {
  readonly config: AppConfig;
  readonly token: string;
  readonly requestPath: string;
}): Promise<DailyPostResult> {
  const raw = await readFile(expandPath(options.requestPath), "utf8");
  const request = decodeRequest(JSON.parse(raw) as unknown);
  const registry = await loadRegistry(options.config);
  const key = threadKey(request);
  const existing = registry.threads[key];
  let threadId = request.threadId ?? existing?.threadId;
  let threadName = existing?.threadName ?? request.threadName;
  let createdThread = false;

  if (!threadId) {
    const thread = await createThread(options.token, request);
    threadId = thread.id;
    threadName = thread.name ?? request.threadName;
    createdThread = true;
  }

  let message: DiscordMessage;
  try {
    message = await sendMessageWithUnarchive(
      options.token,
      threadId,
      request.content
    );
  } catch (error) {
    if (request.action === "final" || request.threadId) throw error;
    const thread = await createThread(options.token, request);
    threadId = thread.id;
    threadName = thread.name ?? request.threadName;
    createdThread = true;
    message = await sendMessage(options.token, threadId, request.content);
  }

  const now = new Date().toISOString();
  registry.threads[key] = {
    key,
    channelId: request.channelId,
    threadId,
    threadName,
    runId: request.runId,
    localDate: request.localDate,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveRegistry(options.config, registry);

  return {
    ok: true,
    channelId: request.channelId,
    threadId,
    messageId: message.id,
    threadName,
    createdThread,
  };
}
