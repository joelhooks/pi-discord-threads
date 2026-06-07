import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ActiveRunRecord {
  runId?: string;
  sourceDiscordMessageId: string;
  placeholderDiscordMessageId: string;
  prompt: string;
  promptPreview: string;
  startedAt: string;
  updatedAt: string;
  sessionFile?: string;
  interruptedAt?: string;
}

export interface WorkGraphMetadata {
  nodeId: string;
  rootNodeId: string;
  parentThreadId?: string;
  parentSessionFile?: string;
  relation?: "root" | "fork" | "clone";
  createdFromEntryId?: string;
}

export interface ThreadRecord {
  threadId: string;
  kind?: "discord-thread" | "discord-dm-workroom";
  guildId?: string;
  parentChannelId?: string;
  discordUserId?: string;
  sessionFile?: string;
  cwd: string;
  workspaceName?: string;
  sessionName?: string;
  extensionPaths?: string[];
  status: "idle" | "running" | "error" | "locked" | "interrupted";
  activeRun?: ActiveRunRecord;
  workGraph?: WorkGraphMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  discordMessageId: string;
  threadId: string;
  direction: "user" | "assistant";
  entryId?: string;
  createdAt: string;
}

export interface RegistryData {
  version: 1;
  threads: Record<string, ThreadRecord>;
  messages: Record<string, MessageRecord>;
}

export class Registry {
  private data: RegistryData = { version: 1, threads: {}, messages: {} };
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.data = { version: 1, threads: {}, messages: {} };
      this.loaded = true;
      await this.save();
      return;
    }

    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as RegistryData;
    this.data = {
      version: 1,
      threads: normalizeThreads(parsed.threads ?? {}),
      messages: parsed.messages ?? {},
    };
    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
        await rename(tempPath, this.filePath);
      });
    await this.saveQueue;
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.data.threads[threadId];
  }

  listThreads(): ThreadRecord[] {
    return Object.values(this.data.threads);
  }

  async markRunningThreadsInterrupted(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const record of Object.values(this.data.threads)) {
      if (record.status !== "running") continue;
      record.status = "interrupted";
      record.updatedAt = now;
      if (record.activeRun) {
        record.activeRun = {
          ...record.activeRun,
          interruptedAt: record.activeRun.interruptedAt ?? now,
          updatedAt: now,
        };
      }
      count++;
    }
    if (count > 0) await this.save();
    return count;
  }

  async upsertThread(input: {
    threadId: string;
    kind?: ThreadRecord["kind"];
    guildId?: string;
    parentChannelId?: string;
    discordUserId?: string;
    cwd: string;
    workspaceName?: string;
    sessionFile?: string;
    sessionName?: string;
    extensionPaths?: string[];
    status?: ThreadRecord["status"];
    activeRun?: ActiveRunRecord;
    workGraph?: WorkGraphMetadata;
  }): Promise<ThreadRecord> {
    const now = new Date().toISOString();
    const existing = this.data.threads[input.threadId];
    const record: ThreadRecord = {
      threadId: input.threadId,
      kind: input.kind ?? existing?.kind,
      guildId: input.guildId ?? existing?.guildId,
      parentChannelId: input.parentChannelId ?? existing?.parentChannelId,
      discordUserId: input.discordUserId ?? existing?.discordUserId,
      cwd: input.cwd ?? existing?.cwd,
      workspaceName: input.workspaceName ?? existing?.workspaceName,
      sessionFile: input.sessionFile ?? existing?.sessionFile,
      sessionName: input.sessionName ?? existing?.sessionName,
      extensionPaths: input.extensionPaths ?? existing?.extensionPaths,
      status: input.status ?? existing?.status ?? "idle",
      activeRun: input.activeRun ?? existing?.activeRun,
      workGraph: input.workGraph ?? existing?.workGraph ?? rootWorkGraph(input.threadId),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.threads[input.threadId] = record;
    await this.save();
    return record;
  }

  async patchThread(threadId: string, patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>): Promise<ThreadRecord> {
    const existing = this.data.threads[threadId];
    if (!existing) throw new Error(`No thread registered for ${threadId}`);
    const record: ThreadRecord = {
      ...existing,
      ...patch,
      threadId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.data.threads[threadId] = record;
    await this.save();
    return record;
  }

  async recordMessage(record: MessageRecord): Promise<void> {
    this.data.messages[record.discordMessageId] = record;
    await this.save();
  }

  async recordMessageEntry(discordMessageId: string, entryId: string | undefined): Promise<void> {
    const existing = this.data.messages[discordMessageId];
    if (!existing) return;
    existing.entryId = entryId;
    await this.save();
  }

  getMessage(discordMessageId: string): MessageRecord | undefined {
    return this.data.messages[discordMessageId];
  }
}

function normalizeThreads(threads: Record<string, ThreadRecord>): Record<string, ThreadRecord> {
  const normalized: Record<string, ThreadRecord> = {};
  for (const [threadId, record] of Object.entries(threads)) {
    const normalizedThreadId = record.threadId ?? threadId;
    normalized[threadId] = {
      ...record,
      threadId: normalizedThreadId,
      kind: record.kind ?? (normalizedThreadId.startsWith("dm:") ? "discord-dm-workroom" : "discord-thread"),
      status: record.status ?? "idle",
      workGraph: record.workGraph ?? rootWorkGraph(normalizedThreadId),
    };
  }
  return normalized;
}

function rootWorkGraph(threadId: string): WorkGraphMetadata {
  return {
    nodeId: threadId,
    rootNodeId: threadId,
    relation: "root",
  };
}
