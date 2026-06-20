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

export interface ThreadTitleTurnRecord {
  user: string;
  assistant: string;
  createdAt: string;
}

export interface ThreadTitleState {
  turnCount: number;
  lastEvaluatedTurn?: number;
  lastRenamedTurn?: number;
  lastRenamedAt?: string;
  lastSuggestedTitle?: string;
  recentTurns: ThreadTitleTurnRecord[];
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
  status: "idle" | "queued" | "running" | "error" | "locked" | "interrupted";
  activeRun?: ActiveRunRecord;
  titleState?: ThreadTitleState;
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

export interface LinkIngestRecord {
  sourceId: string;
  mentionId: string;
  eventId: string;
  eventName: "link/ingest.requested";
  url: string;
  normalizedUrl: string;
  threadId: string;
  channelId: string;
  guildId?: string;
  discordMessageId?: string;
  interactionId?: string;
  authorId?: string;
  status: "accepted" | "classified" | "archived" | "video_metadata" | "video_media" | "audio_transcript" | "article_extracted" | "x_snapshot" | "transcript_processed" | "summarized" | "ready" | "indexed" | "needs_human" | "failed" | "send_failed";
  statusUpdates?: Record<string, LinkIngestStatusUpdateRecord>;
  inngestEventIds?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkIngestStatusUpdateRecord {
  statusKey: string;
  eventName: string;
  sourceId: string;
  mentionId: string;
  status: "accepted" | "classified" | "archived" | "video_metadata" | "video_media" | "audio_transcript" | "article_extracted" | "x_snapshot" | "transcript_processed" | "summarized" | "ready" | "indexed" | "needs_human" | "failed";
  discordMessageId?: string;
  discordPostSkippedReason?: string;
  brainPath?: string;
  manifestPath?: string;
  sourceType?: string;
  postedAt: string;
}

export interface RegistryData {
  version: 1;
  threads: Record<string, ThreadRecord>;
  messages: Record<string, MessageRecord>;
  linkIngests: Record<string, LinkIngestRecord>;
}

export interface RegistryPort {
  save(): Promise<void>;
  getThread(threadId: string): ThreadRecord | undefined;
  listThreads(): ThreadRecord[];
  markRunningThreadsInterrupted(): Promise<number>;
  upsertThread(input: {
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
  }): Promise<ThreadRecord>;
  patchThread(threadId: string, patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>): Promise<ThreadRecord>;
  recordMessage(record: MessageRecord): Promise<void>;
  recordMessageEntry(discordMessageId: string, entryId: string | undefined): Promise<void>;
  getMessage(discordMessageId: string): MessageRecord | undefined;
  upsertLinkIngest(record: LinkIngestRecord): Promise<void>;
  getLinkIngest(mentionId: string): LinkIngestRecord | undefined;
  listLinkIngests(): LinkIngestRecord[];
  getLinkIngestStatusUpdate(mentionId: string, statusKey: string): LinkIngestStatusUpdateRecord | undefined;
  recordLinkIngestStatusUpdate(update: LinkIngestStatusUpdateRecord): Promise<void>;
  close?(): Promise<void>;
}

export class Registry implements RegistryPort {
  private data: RegistryData = { version: 1, threads: {}, messages: {}, linkIngests: {} };
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.data = { version: 1, threads: {}, messages: {}, linkIngests: {} };
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
      linkIngests: normalizeLinkIngests(parsed.linkIngests ?? {}),
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
    const record = normalizeThreadLifecycle({
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
      titleState: existing?.titleState,
      workGraph: input.workGraph ?? existing?.workGraph ?? rootWorkGraph(input.threadId),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.data.threads[input.threadId] = record;
    await this.save();
    return record;
  }

  async patchThread(threadId: string, patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>): Promise<ThreadRecord> {
    const existing = this.data.threads[threadId];
    if (!existing) throw new Error(`No thread registered for ${threadId}`);
    const record = normalizeThreadLifecycle({
      ...existing,
      ...patch,
      threadId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
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

  async upsertLinkIngest(record: LinkIngestRecord): Promise<void> {
    const existing = this.data.linkIngests[record.mentionId];
    this.data.linkIngests[record.mentionId] = {
      ...existing,
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: record.updatedAt,
    };
    await this.save();
  }

  getLinkIngest(mentionId: string): LinkIngestRecord | undefined {
    return this.data.linkIngests[mentionId];
  }

  listLinkIngests(): LinkIngestRecord[] {
    return Object.values(this.data.linkIngests);
  }

  getLinkIngestStatusUpdate(mentionId: string, statusKey: string): LinkIngestStatusUpdateRecord | undefined {
    return this.data.linkIngests[mentionId]?.statusUpdates?.[statusKey];
  }

  async recordLinkIngestStatusUpdate(update: LinkIngestStatusUpdateRecord): Promise<void> {
    const existing = this.data.linkIngests[update.mentionId];
    if (!existing) throw new Error(`No link ingest registered for ${update.mentionId}`);
    this.data.linkIngests[update.mentionId] = {
      ...existing,
      status: update.status,
      statusUpdates: {
        ...(existing.statusUpdates ?? {}),
        [update.statusKey]: update,
      },
      updatedAt: update.postedAt,
    };
    await this.save();
  }
}

function normalizeThreadLifecycle(record: ThreadRecord): ThreadRecord {
  if (record.status === "queued" || record.status === "running" || record.status === "interrupted") return record;
  const { activeRun: _activeRun, ...withoutActiveRun } = record;
  return withoutActiveRun;
}

function normalizeThreads(threads: Record<string, ThreadRecord>): Record<string, ThreadRecord> {
  const normalized: Record<string, ThreadRecord> = {};
  for (const [threadId, record] of Object.entries(threads)) {
    const normalizedThreadId = record.threadId ?? threadId;
    normalized[threadId] = normalizeThreadLifecycle({
      ...record,
      threadId: normalizedThreadId,
      kind: record.kind ?? (normalizedThreadId.startsWith("dm:") ? "discord-dm-workroom" : "discord-thread"),
      status: record.status ?? "idle",
      titleState: normalizeTitleState(record.titleState),
      workGraph: record.workGraph ?? rootWorkGraph(normalizedThreadId),
    });
  }
  return normalized;
}

function normalizeTitleState(state: ThreadTitleState | undefined): ThreadTitleState | undefined {
  if (!state) return undefined;
  const recentTurns = Array.isArray(state.recentTurns)
    ? state.recentTurns
      .map((turn) => ({
        user: String(turn.user ?? ""),
        assistant: String(turn.assistant ?? ""),
        createdAt: String(turn.createdAt ?? ""),
      }))
      .filter((turn) => turn.user || turn.assistant)
      .slice(-12)
    : [];
  return {
    turnCount: Number.isFinite(state.turnCount) ? Math.max(0, Math.floor(Number(state.turnCount))) : recentTurns.length,
    lastEvaluatedTurn: Number.isFinite(state.lastEvaluatedTurn) ? Math.max(0, Math.floor(Number(state.lastEvaluatedTurn))) : undefined,
    lastRenamedTurn: Number.isFinite(state.lastRenamedTurn) ? Math.max(0, Math.floor(Number(state.lastRenamedTurn))) : undefined,
    lastRenamedAt: state.lastRenamedAt,
    lastSuggestedTitle: state.lastSuggestedTitle,
    recentTurns,
  };
}

function normalizeLinkIngests(records: Record<string, LinkIngestRecord>): Record<string, LinkIngestRecord> {
  const normalized: Record<string, LinkIngestRecord> = {};
  for (const [mentionId, record] of Object.entries(records)) {
    if (!record?.sourceId || !record?.mentionId || !record?.url) continue;
    normalized[mentionId] = {
      ...record,
      eventName: "link/ingest.requested",
      status: normalizeLinkIngestStatus(record.status),
      statusUpdates: normalizeLinkIngestStatusUpdates(record.statusUpdates),
      createdAt: record.createdAt ?? record.updatedAt ?? new Date(0).toISOString(),
      updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
    };
  }
  return normalized;
}

function normalizeLinkIngestStatus(status: string | undefined): LinkIngestRecord["status"] {
  if (status === "classified" || status === "archived" || status === "video_metadata" || status === "video_media" || status === "audio_transcript" || status === "article_extracted" || status === "x_snapshot" || status === "transcript_processed" || status === "summarized" || status === "ready" || status === "indexed" || status === "needs_human" || status === "failed" || status === "send_failed") return status;
  return "accepted";
}

function normalizeLinkIngestStatusUpdates(
  updates: Record<string, LinkIngestStatusUpdateRecord> | undefined,
): Record<string, LinkIngestStatusUpdateRecord> | undefined {
  if (!updates || typeof updates !== "object") return undefined;
  const normalized: Record<string, LinkIngestStatusUpdateRecord> = {};
  for (const [statusKey, update] of Object.entries(updates)) {
    if (!update?.eventName || !update.sourceId || !update.mentionId) continue;
    normalized[statusKey] = {
      ...update,
      statusKey,
      status: update.status === "classified" || update.status === "archived" || update.status === "video_metadata" || update.status === "video_media" || update.status === "audio_transcript" || update.status === "article_extracted" || update.status === "x_snapshot" || update.status === "transcript_processed" || update.status === "summarized" || update.status === "ready" || update.status === "indexed" || update.status === "needs_human" || update.status === "failed" ? update.status : "accepted",
      postedAt: update.postedAt ?? new Date(0).toISOString(),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function rootWorkGraph(threadId: string): WorkGraphMetadata {
  return {
    nodeId: threadId,
    rootNodeId: threadId,
    relation: "root",
  };
}
