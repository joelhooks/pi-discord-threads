import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { resolveContextChannelDefault } from "./cwd.js";
import type { RegistryPort, ThreadRecord } from "./registry.js";

export interface DailyThreadSessionContext {
  readonly cwd: string;
  readonly workspaceName?: string;
  readonly sessionName: string;
}

export interface DailyThreadRecord {
  readonly key: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly runId: string;
  readonly localDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd?: string;
  readonly workspaceName?: string;
  readonly sessionName?: string;
}

export interface DailyThreadRegistry {
  readonly version: 1;
  readonly threads: Record<string, DailyThreadRecord>;
}

export interface DailyThreadRecordInput {
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly runId: string;
  readonly localDate: string;
  readonly session: DailyThreadSessionContext;
}

export const dailyThreadRegistryPath = (config: AppConfig): string =>
  join(config.dataDir, "daily-threads.json");

export const dailyThreadKey = (
  channelId: string,
  localDate: string
): string => `${channelId}:${localDate}`;

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

export const loadDailyThreadRegistry = async (
  config: AppConfig
): Promise<DailyThreadRegistry> =>
  (await readJson<DailyThreadRegistry>(dailyThreadRegistryPath(config))) ?? {
    version: 1,
    threads: {},
  };

export const saveDailyThreadRegistry = async (
  config: AppConfig,
  registry: DailyThreadRegistry
): Promise<void> => writeJsonAtomic(dailyThreadRegistryPath(config), registry);

export const findDailyThreadByKey = async (
  config: AppConfig,
  channelId: string,
  localDate: string
): Promise<DailyThreadRecord | undefined> => {
  const registry = await loadDailyThreadRegistry(config);
  return registry.threads[dailyThreadKey(channelId, localDate)];
};

export const findDailyThreadByThreadId = async (
  config: AppConfig,
  threadId: string
): Promise<DailyThreadRecord | undefined> => {
  const registry = await loadDailyThreadRegistry(config);
  return Object.values(registry.threads).find(
    (record) => record.threadId === threadId
  );
};

export const recordDailyThread = async (
  config: AppConfig,
  input: DailyThreadRecordInput
): Promise<DailyThreadRecord> => {
  const registry = await loadDailyThreadRegistry(config);
  const key = dailyThreadKey(input.channelId, input.localDate);
  const existing = registry.threads[key];
  const now = new Date().toISOString();
  const record: DailyThreadRecord = {
    key,
    channelId: input.channelId,
    ...(input.guildId ? { guildId: input.guildId } : existing?.guildId ? { guildId: existing.guildId } : {}),
    threadId: input.threadId,
    threadName: input.threadName,
    runId: input.runId,
    localDate: input.localDate,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    cwd: input.session.cwd,
    ...(input.session.workspaceName ? { workspaceName: input.session.workspaceName } : {}),
    sessionName: input.session.sessionName,
  };
  registry.threads[key] = record;
  await saveDailyThreadRegistry(config, registry);
  return record;
};

const resolveAdoptedDailyThreadContext = async (
  config: AppConfig,
  record: DailyThreadRecord
): Promise<DailyThreadSessionContext> => {
  if (record.cwd) {
    return {
      cwd: record.cwd,
      ...(record.workspaceName ? { workspaceName: record.workspaceName } : {}),
      sessionName: record.sessionName ?? record.threadName,
    };
  }

  const channelContext = await resolveContextChannelDefault(
    record.channelId,
    undefined,
    config
  );
  return {
    cwd: channelContext?.cwd ?? config.pi.defaultCwd,
    ...(channelContext?.workspaceName
      ? { workspaceName: channelContext.workspaceName }
      : {}),
    sessionName: record.sessionName ?? record.threadName,
  };
};

export const adoptDailyThreadSession = async (
  config: AppConfig,
  registry: RegistryPort,
  threadId: string
): Promise<ThreadRecord | undefined> => {
  const existing = registry.getThread(threadId);
  if (existing) return existing;

  const dailyThread = await findDailyThreadByThreadId(config, threadId);
  if (!dailyThread) return undefined;

  const context = await resolveAdoptedDailyThreadContext(config, dailyThread);
  return registry.upsertThread({
    threadId,
    kind: "discord-thread",
    ...(dailyThread.guildId ? { guildId: dailyThread.guildId } : {}),
    parentChannelId: dailyThread.channelId,
    cwd: context.cwd,
    ...(context.workspaceName ? { workspaceName: context.workspaceName } : {}),
    sessionName: context.sessionName,
    status: "idle",
  });
};
