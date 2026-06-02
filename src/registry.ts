import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ThreadRecord {
  threadId: string;
  guildId?: string;
  parentChannelId?: string;
  sessionFile?: string;
  cwd: string;
  workspaceName?: string;
  sessionName?: string;
  status: "idle" | "running" | "error" | "locked";
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
      threads: parsed.threads ?? {},
      messages: parsed.messages ?? {},
    };
    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.data.threads[threadId];
  }

  listThreads(): ThreadRecord[] {
    return Object.values(this.data.threads);
  }

  async upsertThread(input: {
    threadId: string;
    guildId?: string;
    parentChannelId?: string;
    cwd: string;
    workspaceName?: string;
    sessionFile?: string;
    sessionName?: string;
    status?: ThreadRecord["status"];
  }): Promise<ThreadRecord> {
    const now = new Date().toISOString();
    const existing = this.data.threads[input.threadId];
    const record: ThreadRecord = {
      threadId: input.threadId,
      guildId: input.guildId ?? existing?.guildId,
      parentChannelId: input.parentChannelId ?? existing?.parentChannelId,
      cwd: input.cwd ?? existing?.cwd,
      workspaceName: input.workspaceName ?? existing?.workspaceName,
      sessionFile: input.sessionFile ?? existing?.sessionFile,
      sessionName: input.sessionName ?? existing?.sessionName,
      status: input.status ?? existing?.status ?? "idle",
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
