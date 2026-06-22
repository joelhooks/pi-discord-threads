import { readFile } from "node:fs/promises";

import type { AppConfig } from "./config.js";
import { expandPath } from "./config.js";
import { findDailyThreadByKey, recordDailyThread } from "./daily-thread-registry.js";
import { resolveContextChannelDefault, resolveCwdInput } from "./cwd.js";

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
  readonly cwd?: string;
  readonly workspaceName?: string;
  readonly sessionName?: string;
}

interface DiscordChannel {
  readonly id: string;
  readonly name?: string;
  readonly guild_id?: string;
}

interface DiscordMessage {
  readonly id: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
}

export interface DailyPostResult {
  readonly ok: boolean;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly threadUrl?: string;
  readonly messageUrl?: string;
  readonly threadName: string;
  readonly createdThread?: boolean;
  readonly registeredSession?: boolean;
  readonly cwd?: string;
  readonly workspaceName?: string;
  readonly sessionName?: string;
  readonly error?: string;
}

const firstConfiguredGuildId = (config: AppConfig): string | undefined =>
  config.discord.guildIds.length === 1 ? config.discord.guildIds[0] : undefined;

const discordChannelUrl = (
  guildId: string | undefined,
  channelId: string | undefined
): string | undefined =>
  guildId && channelId
    ? `https://discord.com/channels/${guildId}/${channelId}`
    : undefined;

const discordMessageUrl = (
  guildId: string | undefined,
  channelId: string | undefined,
  messageId: string | undefined
): string | undefined =>
  guildId && channelId && messageId
    ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
    : undefined;

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
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.workspaceName ? { workspaceName: request.workspaceName } : {}),
    ...(request.sessionName ? { sessionName: request.sessionName } : {}),
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

const resolveDailySessionContext = async (
  config: AppConfig,
  request: DailyPostRequest
): Promise<{
  readonly cwd: string;
  readonly workspaceName?: string;
  readonly sessionName: string;
}> => {
  const channelContext = await resolveContextChannelDefault(
    request.channelId,
    undefined,
    config
  );
  const workspaceName = request.workspaceName ?? channelContext?.workspaceName;
  const cwd = request.cwd
    ? await resolveCwdInput(request.cwd, config.pi.defaultCwd)
    : (channelContext?.cwd ?? config.pi.defaultCwd);
  return {
    cwd,
    ...(workspaceName ? { workspaceName } : {}),
    sessionName: request.sessionName ?? request.threadName,
  };
};

export async function postDailyMessage(options: {
  readonly config: AppConfig;
  readonly token: string;
  readonly requestPath: string;
}): Promise<DailyPostResult> {
  const raw = await readFile(expandPath(options.requestPath), "utf8");
  const request = decodeRequest(JSON.parse(raw) as unknown);
  const existing = await findDailyThreadByKey(
    options.config,
    request.channelId,
    request.localDate
  );
  let threadId = request.threadId ?? existing?.threadId;
  let threadName = existing?.threadName ?? request.threadName;
  let guildId = firstConfiguredGuildId(options.config);
  let createdThread = false;

  if (!threadId) {
    const thread = await createThread(options.token, request);
    threadId = thread.id;
    threadName = thread.name ?? request.threadName;
    guildId = thread.guild_id ?? guildId;
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
    guildId = thread.guild_id ?? guildId;
    createdThread = true;
    message = await sendMessage(options.token, threadId, request.content);
  }
  guildId = message.guild_id ?? guildId;

  const sessionContext = await resolveDailySessionContext(options.config, request);
  await recordDailyThread(options.config, {
    channelId: request.channelId,
    ...(guildId ? { guildId } : {}),
    threadId,
    threadName,
    runId: request.runId,
    localDate: request.localDate,
    session: sessionContext,
  });

  return {
    ok: true,
    channelId: request.channelId,
    ...(guildId ? { guildId } : {}),
    threadId,
    messageId: message.id,
    ...(discordChannelUrl(guildId, threadId)
      ? { threadUrl: discordChannelUrl(guildId, threadId) }
      : {}),
    ...(discordMessageUrl(guildId, threadId, message.id)
      ? { messageUrl: discordMessageUrl(guildId, threadId, message.id) }
      : {}),
    threadName,
    createdThread,
    registeredSession: true,
    cwd: sessionContext.cwd,
    ...(sessionContext.workspaceName
      ? { workspaceName: sessionContext.workspaceName }
      : {}),
    sessionName: sessionContext.sessionName,
  };
}
