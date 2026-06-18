import type { AppConfig } from "../config.js";
import type { RedisCommandClient } from "./redis-client.js";
import {
  type ActivePointer,
  type FinalizeClaim,
  type QueuedRunInput,
  type RunJob,
  type RunRecord,
  isTerminalRunStatus,
} from "./types.js";

const WORKER_GROUP = "workers";

export class RunControlStore {
  readonly keys: RunControlKeys;

  constructor(
    private readonly client: RedisCommandClient,
    private readonly config: AppConfig,
  ) {
    this.keys = new RunControlKeys(config.runControl.keyPrefix);
  }

  async close(): Promise<void> {
    await this.client.close().catch(async () => {
      await Promise.resolve(this.client.destroy?.()).catch(() => undefined);
    });
  }

  async ensureConsumerGroup(): Promise<void> {
    try {
      await this.command(["XGROUP", "CREATE", this.keys.jobs, WORKER_GROUP, "0", "MKSTREAM"]);
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes("BUSYGROUP")) throw error;
    }
  }

  async tryEnqueueRun(run: RunRecord): Promise<{ enqueued: true; run: RunRecord } | { enqueued: false; activeRunId: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const activeKey = this.keys.active(run.logicalThreadId);
      const setReply = await this.command(["SET", activeKey, run.runId, "NX"]);
      if (setReply !== "OK") {
        const activeRunId = await this.getActiveRunId(run.logicalThreadId);
        if (activeRunId && await this.shouldRejectActivePointer(activeRunId)) {
          await this.clearActiveIfMatches(run.logicalThreadId, activeRunId).catch(() => undefined);
          continue;
        }
        return { enqueued: false, activeRunId: activeRunId ?? "unknown" };
      }

      try {
        await this.hset(this.keys.run(run.runId), runRecordToHash(run));
        await this.command(["XADD", this.keys.jobs, "*", "runId", run.runId]);
        await this.appendRunEvent(run.runId, "queued", { logicalThreadId: run.logicalThreadId, threadId: run.threadId });
        return { enqueued: true, run };
      } catch (error) {
        await this.clearActiveIfMatches(run.logicalThreadId, run.runId).catch(() => undefined);
        throw error;
      }
    }

    const activeRunId = await this.getActiveRunId(run.logicalThreadId);
    return { enqueued: false, activeRunId: activeRunId ?? "unknown" };
  }

  async appendInput(input: QueuedRunInput): Promise<string> {
    const streamId = await this.command([
      "XADD",
      this.keys.inputs(input.logicalThreadId),
      "*",
      "runId",
      input.runId,
      "logicalThreadId",
      input.logicalThreadId,
      "mode",
      input.mode,
      "text",
      input.text,
      "imagesJson",
      JSON.stringify(input.images ?? []),
      "sourceDiscordMessageId",
      input.sourceDiscordMessageId ?? "",
      "createdAt",
      input.createdAt,
    ]);
    const inputId = String(streamId);
    await this.appendRunEvent(input.runId, "input_queued", {
      logicalThreadId: input.logicalThreadId,
      mode: input.mode,
      inputId,
    });
    return inputId;
  }

  async getInputStreamLength(logicalThreadId: string): Promise<number> {
    return Number(await this.command(["XLEN", this.keys.inputs(logicalThreadId)]));
  }

  async countInputsForRun(logicalThreadId: string, runId: string): Promise<number> {
    const inputs = await this.readInputsSince(logicalThreadId, "0-0", 1_000);
    return inputs.filter((input) => input.runId === runId).length;
  }

  async readInputsSince(logicalThreadId: string, lastId: string, count = 50): Promise<QueuedRunInput[]> {
    const reply = await this.command([
      "XRANGE",
      this.keys.inputs(logicalThreadId),
      `(${lastId}`,
      "+",
      "COUNT",
      String(count),
    ]);
    return parseStreamEntries(reply).map(({ id, fields }) => queuedInputFromFields(id, fields));
  }

  async dequeueJob(workerId: string, blockMs: number): Promise<RunJob | undefined> {
    const reply = await this.command([
      "XREADGROUP",
      "GROUP",
      WORKER_GROUP,
      workerId,
      "COUNT",
      "1",
      "BLOCK",
      String(blockMs),
      "STREAMS",
      this.keys.jobs,
      ">",
    ]);
    const freshJob = jobFromStreamEntries(parseXReadReply(reply)[0]?.entries ?? []);
    if (freshJob) return freshJob;
    return this.claimStaleJob(workerId);
  }

  async claimStaleJob(workerId: string): Promise<RunJob | undefined> {
    const reply = await this.command([
      "XAUTOCLAIM",
      this.keys.jobs,
      WORKER_GROUP,
      workerId,
      String(this.config.runControl.staleRunMs),
      "0-0",
      "COUNT",
      "1",
    ]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("NOGROUP")) return undefined;
      throw error;
    });
    if (!Array.isArray(reply)) return undefined;
    return jobFromStreamEntries(parseStreamEntries(reply[1]));
  }

  async acknowledgeJob(job: RunJob): Promise<void> {
    await this.command(["XACK", this.keys.jobs, WORKER_GROUP, job.streamId]);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const hash = await this.hgetall(this.keys.run(runId));
    if (Object.keys(hash).length === 0) return undefined;
    return runRecordFromHash(hash);
  }

  async patchRun(runId: string, patch: Partial<RunRecord>, options: { preserveTerminal?: boolean } = {}): Promise<RunRecord | undefined> {
    if (options.preserveTerminal) {
      const current = await this.getRun(runId);
      if (current && isTerminalRunStatus(current.status)) return current;
    }

    const updatedAt = new Date().toISOString();
    await this.hset(this.keys.run(runId), runRecordToHash({ ...patch, updatedAt }));
    return this.getRun(runId);
  }

  async markTerminal(runId: string, status: "succeeded" | "failed" | "interrupted" | "aborted", patch: Partial<RunRecord> = {}): Promise<RunRecord | undefined> {
    const current = await this.getRun(runId);
    if (current && isTerminalRunStatus(current.status)) return current;

    const now = new Date().toISOString();
    await this.hset(this.keys.run(runId), runRecordToHash({
      ...patch,
      status,
      updatedAt: now,
      finalizedAt: patch.finalizedAt ?? now,
    }));
    const next = await this.getRun(runId);
    if (next) {
      await this.appendRunEvent(runId, status, { logicalThreadId: next.logicalThreadId, threadId: next.threadId });
    }
    return next;
  }

  async getActiveRunId(logicalThreadId: string): Promise<string | undefined> {
    const value = await this.command(["GET", this.keys.active(logicalThreadId)]);
    const text = valueToString(value);
    return text || undefined;
  }

  async getQueueableActiveRunId(logicalThreadId: string): Promise<string | undefined> {
    const activeRunId = await this.getActiveRunId(logicalThreadId);
    if (!activeRunId) return undefined;
    if (await this.shouldRejectActivePointer(activeRunId)) {
      await this.clearActiveIfMatches(logicalThreadId, activeRunId).catch(() => undefined);
      return undefined;
    }
    return activeRunId;
  }

  async clearActiveIfMatches(logicalThreadId: string, runId: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      this.keys.active(logicalThreadId),
      runId,
    ]);
    return Number(result) === 1;
  }

  async claimRunLease(run: RunRecord, workerId: string, leaseToken: string): Promise<boolean> {
    const reply = await this.command([
      "SET",
      this.keys.runLease(run.runId),
      leaseToken,
      "NX",
      "PX",
      String(this.config.runControl.leaseTtlMs),
    ]);
    if (reply !== "OK") return false;

    const now = new Date().toISOString();
    await this.hset(this.keys.run(run.runId), runRecordToHash({
      status: run.status === "finalizing" ? "finalizing" : "running",
      workerId,
      leaseToken,
      startedAt: run.startedAt ?? now,
      updatedAt: now,
    }));
    await this.appendRunEvent(run.runId, "running", { logicalThreadId: run.logicalThreadId, workerId });
    return true;
  }

  async heartbeatRunLease(runId: string, leaseToken: string, workerId: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1 else return 0 end",
      "1",
      this.keys.runLease(runId),
      leaseToken,
      String(this.config.runControl.leaseTtlMs),
    ]);
    const ok = Number(result) === 1;
    if (ok) {
      const now = new Date().toISOString();
      await this.hset(this.keys.run(runId), { updatedAt: now, workerId });
      await this.hset(this.keys.worker(workerId), {
        workerId,
        runId,
        status: "running",
        updatedAt: now,
      });
      await this.command(["PEXPIRE", this.keys.worker(workerId), String(Math.max(this.config.runControl.leaseTtlMs * 2, this.config.runControl.heartbeatMs * 3))]);
    }
    return ok;
  }

  async releaseRunLease(runId: string, leaseToken: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      this.keys.runLease(runId),
      leaseToken,
    ]);
    return Number(result) === 1;
  }

  async acquireFinalize(runId: string, leaseToken: string): Promise<FinalizeClaim> {
    const key = this.keys.finalize(runId);
    const existing = valueToString(await this.command(["GET", key]));
    if (existing === "done") return "done";

    const reply = await this.command([
      "SET",
      key,
      leaseToken,
      "NX",
      "PX",
      String(this.config.runControl.leaseTtlMs),
    ]);
    if (reply === "OK") return "acquired";

    const current = valueToString(await this.command(["GET", key]));
    return current === "done" ? "done" : "busy";
  }

  async completeFinalize(runId: string, leaseToken: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      "local current = redis.call('GET', KEYS[1]); if current == ARGV[1] then redis.call('SET', KEYS[1], 'done'); return 1 elseif current == 'done' then return 1 else return 0 end",
      "1",
      this.keys.finalize(runId),
      leaseToken,
    ]);
    return Number(result) === 1;
  }

  async getRunLeaseTtl(runId: string): Promise<number> {
    return Number(await this.command(["PTTL", this.keys.runLease(runId)]));
  }

  async appendRunEvent(runId: string, type: string, fields: Record<string, unknown> = {}): Promise<string> {
    const args = ["XADD", this.keys.events, "*", "runId", runId, "type", type, "createdAt", new Date().toISOString()];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      args.push(key, stringifyField(value));
    }
    return String(await this.command(args));
  }

  async recordWorkerIdle(workerId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.hset(this.keys.worker(workerId), { workerId, status: "idle", updatedAt: now });
    await this.command(["PEXPIRE", this.keys.worker(workerId), String(Math.max(this.config.runControl.leaseTtlMs * 2, this.config.runControl.heartbeatMs * 3))]);
  }

  async listRuns(): Promise<RunRecord[]> {
    const keys = await this.keysMatching(this.keys.runPattern);
    const runs: RunRecord[] = [];
    for (const key of keys) {
      const hash = await this.hgetall(key);
      if (Object.keys(hash).length > 0) runs.push(runRecordFromHash(hash));
    }
    return runs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async listActivePointers(): Promise<ActivePointer[]> {
    const keys = await this.keysMatching(this.keys.activePattern);
    const pointers: ActivePointer[] = [];
    for (const key of keys) {
      const runId = valueToString(await this.command(["GET", key]));
      if (!runId) continue;
      pointers.push({ logicalThreadId: this.keys.logicalThreadIdFromActiveKey(key), runId });
    }
    return pointers;
  }

  private async shouldRejectActivePointer(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return !run || run.status === "finalizing" || isTerminalRunStatus(run.status);
  }

  private async keysMatching(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const reply = await this.command(["SCAN", cursor, "MATCH", pattern, "COUNT", "100"]);
      const parsed = parseScanReply(reply);
      cursor = parsed.cursor;
      keys.push(...parsed.keys.map((value) => valueToString(value)).filter(Boolean));
    } while (cursor !== "0");
    return keys;
  }

  private async command(args: string[]): Promise<unknown> {
    return this.client.sendCommand(args);
  }

  private async hset(key: string, fields: Record<string, string | undefined>): Promise<void> {
    const args = ["HSET", key];
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      args.push(field, value);
    }
    if (args.length > 2) await this.command(args);
  }

  private async hgetall(key: string): Promise<Record<string, string>> {
    return parseHash(await this.command(["HGETALL", key]));
  }
}

export class RunControlKeys {
  readonly prefix: string;
  readonly jobs: string;
  readonly events: string;

  constructor(prefix: string) {
    this.prefix = prefix.replace(/:+$/g, "") || "pi-discord-threads";
    this.jobs = `${this.prefix}:run:jobs`;
    this.events = `${this.prefix}:run:events`;
  }

  get runPattern(): string {
    return `${this.prefix}:runs:*`;
  }

  get activePattern(): string {
    return `${this.prefix}:thread:*:active`;
  }

  run(runId: string): string {
    return `${this.prefix}:runs:${runId}`;
  }

  active(logicalThreadId: string): string {
    return `${this.prefix}:thread:${logicalThreadId}:active`;
  }

  inputs(logicalThreadId: string): string {
    return `${this.prefix}:thread:${logicalThreadId}:inputs`;
  }

  threadLock(logicalThreadId: string): string {
    return `${this.prefix}:locks:thread:${logicalThreadId}`;
  }

  runLease(runId: string): string {
    return `${this.prefix}:leases:run:${runId}`;
  }

  finalize(runId: string): string {
    return `${this.prefix}:finalize:${runId}`;
  }

  worker(workerId: string): string {
    return `${this.prefix}:workers:${workerId}`;
  }

  logicalThreadIdFromActiveKey(key: string): string {
    const start = `${this.prefix}:thread:`;
    const end = ":active";
    return key.startsWith(start) && key.endsWith(end)
      ? key.slice(start.length, -end.length)
      : key;
  }
}

function runRecordToHash(record: Partial<RunRecord>): Record<string, string | undefined> {
  return {
    runId: record.runId,
    logicalThreadId: record.logicalThreadId,
    threadId: record.threadId,
    kind: record.kind,
    status: record.status,
    sourceDiscordMessageId: record.sourceDiscordMessageId,
    placeholderDiscordMessageId: record.placeholderDiscordMessageId,
    prompt: record.prompt,
    promptPreview: record.promptPreview,
    cwd: record.cwd,
    workspaceName: record.workspaceName,
    sessionFile: record.sessionFile,
    imagesJson: record.images ? JSON.stringify(record.images) : undefined,
    userEntryId: record.userEntryId,
    assistantEntryId: record.assistantEntryId,
    resultText: record.resultText,
    workerId: record.workerId,
    leaseToken: record.leaseToken,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finalizedAt: record.finalizedAt,
    placeholderRetiredAt: record.placeholderRetiredAt,
    error: record.error,
  };
}

function runRecordFromHash(hash: Record<string, string>): RunRecord {
  return {
    runId: hash.runId,
    logicalThreadId: hash.logicalThreadId,
    threadId: hash.threadId,
    kind: hash.kind === "discord-dm-workroom" ? "discord-dm-workroom" : "discord-thread",
    status: (hash.status as RunRecord["status"]) || "queued",
    sourceDiscordMessageId: hash.sourceDiscordMessageId,
    placeholderDiscordMessageId: hash.placeholderDiscordMessageId,
    prompt: hash.prompt ?? "",
    promptPreview: hash.promptPreview ?? "",
    cwd: hash.cwd ?? process.cwd(),
    workspaceName: hash.workspaceName || undefined,
    sessionFile: hash.sessionFile || undefined,
    images: parseJson(hash.imagesJson, []),
    userEntryId: hash.userEntryId || undefined,
    assistantEntryId: hash.assistantEntryId || undefined,
    resultText: hash.resultText || undefined,
    workerId: hash.workerId || undefined,
    leaseToken: hash.leaseToken || undefined,
    createdAt: hash.createdAt,
    updatedAt: hash.updatedAt,
    startedAt: hash.startedAt || undefined,
    finalizedAt: hash.finalizedAt || undefined,
    placeholderRetiredAt: hash.placeholderRetiredAt || undefined,
    error: hash.error || undefined,
  };
}

function queuedInputFromFields(inputId: string, fields: Record<string, string>): QueuedRunInput {
  return {
    inputId,
    runId: fields.runId,
    logicalThreadId: fields.logicalThreadId,
    mode: fields.mode === "followUp" ? "followUp" : "steer",
    text: fields.text ?? "",
    images: parseJson(fields.imagesJson, []),
    sourceDiscordMessageId: fields.sourceDiscordMessageId || undefined,
    createdAt: fields.createdAt || new Date().toISOString(),
  };
}

function jobFromStreamEntries(entries: Array<{ id: string; fields: Record<string, string> }>): RunJob | undefined {
  const first = entries[0];
  const runId = first?.fields.runId;
  return first && runId ? { streamId: first.id, runId } : undefined;
}

function parseXReadReply(reply: unknown): Array<{ stream: string; entries: Array<{ id: string; fields: Record<string, string> }> }> {
  if (!Array.isArray(reply)) return [];
  return reply.map((streamReply) => {
    if (!Array.isArray(streamReply)) return { stream: "", entries: [] };
    const [stream, entries] = streamReply;
    return {
      stream: valueToString(stream),
      entries: parseStreamEntries(entries),
    };
  });
}

function parseStreamEntries(reply: unknown): Array<{ id: string; fields: Record<string, string> }> {
  if (!Array.isArray(reply)) return [];
  return reply.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const [id, rawFields] = entry;
    return [{ id: valueToString(id), fields: parseFieldList(rawFields) }];
  });
}

function parseFieldList(rawFields: unknown): Record<string, string> {
  if (!Array.isArray(rawFields)) return {};
  const fields: Record<string, string> = {};
  for (let i = 0; i < rawFields.length; i += 2) {
    const key = valueToString(rawFields[i]);
    if (!key) continue;
    fields[key] = valueToString(rawFields[i + 1]);
  }
  return fields;
}

function parseScanReply(reply: unknown): { cursor: string; keys: unknown[] } {
  if (!Array.isArray(reply) || reply.length < 2) return { cursor: "0", keys: [] };
  const [cursor, keys] = reply;
  return {
    cursor: valueToString(cursor) || "0",
    keys: Array.isArray(keys) ? keys : [],
  };
}

function parseHash(reply: unknown): Record<string, string> {
  if (!reply) return {};
  if (Array.isArray(reply)) return parseFieldList(reply);
  if (typeof reply === "object") {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(reply as Record<string, unknown>)) {
      result[key] = valueToString(value);
    }
    return result;
  }
  return {};
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}
