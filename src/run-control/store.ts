import type { AppConfig } from "../config.js";
import { formatUnknownError } from "../error-format.js";
import type { RedisCommandClient } from "./redis-client.js";
import { RetryRunLaterError } from "./errors.js";
import {
  atomicEnqueueRunScript,
  buildRecordRetryLaterEval,
  claimRunLeaseScript,
  clearActiveIfMatchesScript,
  completeFinalizeScript,
  heartbeatRunLeaseScript,
  recordWorkerIdleScript,
  releaseRunLeaseScript,
  verifyRunOwnershipScript,
} from "./lua-scripts.js";
import {
  type ActivePointer,
  type FinalizeClaim,
  type QueuedRunInput,
  type RunControlEventSummary,
  type RunControlEventTypeCount,
  type RunControlJobQueueSummary,
  type RunControlPendingJobDetail,
  type RunControlWorkerRecord,
  type RunJob,
  type RunRecord,
  type RetryLaterRecordResult,
  isTerminalRunStatus,
} from "./types.js";

const WORKER_GROUP = "workers";
const RUN_EVENT_STREAM_MAXLEN = 50_000;
const DEFAULT_RUN_EVENT_SUMMARY_SAMPLE_LIMIT = 1_000;
const MAX_RUN_EVENT_SUMMARY_SAMPLE_LIMIT = 5_000;
const DEFAULT_PENDING_JOB_DETAIL_LIMIT = 10;
const MAX_PENDING_JOB_DETAIL_LIMIT = 50;
const HIGH_VOLUME_EVENT_TYPES = new Set(["thinking_delta", "text_delta"]);

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
    const runFields = runRecordToHash(run);
    const hashArgs: string[] = [];
    for (const [field, value] of Object.entries(runFields)) {
      if (value === undefined) continue;
      hashArgs.push(field, value);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.command([
        "EVAL",
        atomicEnqueueRunScript.source,
        "3",
        this.keys.active(run.logicalThreadId),
        this.keys.run(run.runId),
        this.keys.jobs,
        run.runId,
        ...hashArgs,
      ]);
      const [status, activeRunId] = parseEvalArray(reply);
      if (status === "enqueued") {
        await this.appendRunEvent(run.runId, "queued", { logicalThreadId: run.logicalThreadId, threadId: run.threadId });
        return { enqueued: true, run };
      }
      if (status === "error") {
        throw new Error(`Redis enqueue failed for ${run.runId}: ${activeRunId || "unknown error"}`);
      }

      const currentActiveRunId = activeRunId || await this.getActiveRunId(run.logicalThreadId);
      if (currentActiveRunId && await this.shouldRejectActivePointer(currentActiveRunId)) {
        await this.clearActiveIfMatches(run.logicalThreadId, currentActiveRunId).catch(() => undefined);
        continue;
      }
      return { enqueued: false, activeRunId: currentActiveRunId ?? "unknown" };
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
    const reply = await this.blockingCommand([
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
    ], workerId);
    const freshJob = jobFromStreamEntries(parseXReadReply(reply)[0]?.entries ?? []);
    if (freshJob) return freshJob;
    return this.claimStaleJob(workerId);
  }

  async claimStaleJob(workerId: string): Promise<RunJob | undefined> {
    const reclaimIdleMs = Math.max(1, this.config.runControl.leaseTtlMs);
    const reply = await this.command([
      "XAUTOCLAIM",
      this.keys.jobs,
      WORKER_GROUP,
      workerId,
      String(reclaimIdleMs),
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
    const run = await this.getRun(activeRunId);
    if (!run || isTerminalRunStatus(run.status)) {
      await this.clearActiveIfMatches(logicalThreadId, activeRunId).catch(() => undefined);
      return undefined;
    }
    if (run.status === "finalizing") return undefined;
    return activeRunId;
  }

  async clearActiveIfMatches(logicalThreadId: string, runId: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      clearActiveIfMatchesScript.source,
      "1",
      this.keys.active(logicalThreadId),
      runId,
    ]);
    return Number(result) === 1;
  }

  async claimRunLease(run: RunRecord, workerId: string, leaseToken: string): Promise<boolean> {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + this.config.runControl.leaseTtlMs).toISOString();
    const result = await this.command([
      "EVAL",
      claimRunLeaseScript.source,
      "3",
      this.keys.active(run.logicalThreadId),
      this.keys.runLease(run.runId),
      this.keys.run(run.runId),
      run.runId,
      leaseToken,
      String(this.config.runControl.leaseTtlMs),
      run.status === "finalizing" ? "finalizing" : "running",
      workerId,
      run.startedAt ?? now,
      now,
      run.status,
      leaseExpiresAt,
    ]);
    const claimResult = parseEvalArray(result);
    if (claimResult[0] === "error") {
      throw new Error(`Redis lease claim failed for ${run.runId}: ${claimResult[1] || "unknown error"}`);
    }
    if (Number(result) !== 1 && claimResult[0] !== "1") return false;

    await this.appendRunEvent(run.runId, "running", { logicalThreadId: run.logicalThreadId, workerId });
    return true;
  }

  async heartbeatRunLease(runId: string, logicalThreadId: string, leaseToken: string, workerId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + this.config.runControl.leaseTtlMs).toISOString();
    const result = await this.command([
      "EVAL",
      heartbeatRunLeaseScript.source,
      "3",
      this.keys.active(logicalThreadId),
      this.keys.runLease(runId),
      this.keys.run(runId),
      runId,
      leaseToken,
      String(this.config.runControl.leaseTtlMs),
      now,
      workerId,
      leaseExpiresAt,
    ]);
    const ok = Number(result) === 1;
    if (ok) {
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

  async verifyRunOwnership(runId: string, logicalThreadId: string, leaseToken: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      verifyRunOwnershipScript.source,
      "3",
      this.keys.active(logicalThreadId),
      this.keys.runLease(runId),
      this.keys.run(runId),
      runId,
      leaseToken,
    ]);
    return Number(result) === 1;
  }

  async releaseRunLease(runId: string, leaseToken: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      releaseRunLeaseScript.source,
      "1",
      this.keys.runLease(runId),
      leaseToken,
    ]);
    return Number(result) === 1;
  }

  async recordRetryLater(run: RunRecord, leaseToken: string, workerId: string, reason: string, maxAttempts: number): Promise<RetryLaterRecordResult> {
    const now = new Date().toISOString();
    const { command, boundedMaxAttempts } = buildRecordRetryLaterEval({
      activeKey: this.keys.active(run.logicalThreadId),
      leaseKey: this.keys.runLease(run.runId),
      runKey: this.keys.run(run.runId),
      runId: run.runId,
      leaseToken,
      workerId,
      now,
      reason,
      maxAttempts,
    });
    const reply = await this.command(command);
    const [status, attemptsOrReason] = parseEvalArray(reply);
    if (status === "retry_later" || status === "dead_lettered") {
      const attempts = Number(attemptsOrReason);
      await this.appendRunEvent(run.runId, "retry_later", {
        logicalThreadId: run.logicalThreadId,
        workerId,
        attempts,
        maxAttempts: boundedMaxAttempts,
        reason,
      }).catch(() => undefined);
      if (status === "dead_lettered") {
        await this.appendRunEvent(run.runId, "dead_lettered", {
          logicalThreadId: run.logicalThreadId,
          workerId,
          attempts,
          maxAttempts: boundedMaxAttempts,
          reason,
        }).catch(() => undefined);
      }
      return { attempts, deadLettered: status === "dead_lettered" };
    }
    if (status === "error") {
      throw new Error(`Redis retry-later record failed for ${run.runId}: ${attemptsOrReason || "unknown error"}`);
    }
    throw new RetryRunLaterError(`run-control ownership lost before retry-later record for ${run.runId}: ${attemptsOrReason || status || "unknown"}`);
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
      completeFinalizeScript.source,
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
    const args = ["XADD", this.keys.events, "MAXLEN", "~", String(RUN_EVENT_STREAM_MAXLEN), "*", "runId", runId, "type", type, "createdAt", new Date().toISOString()];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      args.push(key, stringifyField(value));
    }
    return String(await this.command(args));
  }

  async recordWorkerIdle(workerId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.command([
      "EVAL",
      recordWorkerIdleScript.source,
      "1",
      this.keys.worker(workerId),
      workerId,
      now,
      String(Math.max(this.config.runControl.leaseTtlMs * 2, this.config.runControl.heartbeatMs * 3)),
    ]);
  }

  async getJobQueueSummary(): Promise<RunControlJobQueueSummary> {
    const reply = await this.command(["XPENDING", this.keys.jobs, WORKER_GROUP]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("NOGROUP") || message.includes("no such key")) return [0, null, null, []];
      throw error;
    });
    return parsePendingSummary(reply);
  }

  async getPendingJobDetails(limit = DEFAULT_PENDING_JOB_DETAIL_LIMIT): Promise<RunControlPendingJobDetail[]> {
    const boundedLimit = clampInteger(limit, 1, MAX_PENDING_JOB_DETAIL_LIMIT);
    const pendingReply = await this.command(["XPENDING", this.keys.jobs, WORKER_GROUP, "-", "+", String(boundedLimit)]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("NOGROUP") || message.includes("no such key")) return [];
      throw error;
    });
    const pendingEntries = parsePendingDetailReply(pendingReply);
    const details: RunControlPendingJobDetail[] = [];
    for (const entry of pendingEntries) {
      const runId = await this.readJobRunId(entry.streamId);
      const run = runId ? await this.getRun(runId) : undefined;
      const leaseTtlMs = runId ? await this.getRunLeaseTtl(runId) : undefined;
      details.push({
        streamId: entry.streamId,
        consumer: entry.consumer,
        idleMs: entry.idleMs,
        deliveries: entry.deliveries,
        runId,
        runStatus: run?.status,
        leaseWorkerId: run?.workerId,
        leaseTtlMs,
      });
    }
    return details;
  }

  async getRunEventSummary(options: { sampleLimit?: number } = {}): Promise<RunControlEventSummary> {
    const sampleLimit = clampInteger(options.sampleLimit ?? DEFAULT_RUN_EVENT_SUMMARY_SAMPLE_LIMIT, 1, MAX_RUN_EVENT_SUMMARY_SAMPLE_LIMIT);
    let lengthReply: unknown = 0;
    let events: Array<{ id: string; fields: Record<string, string> }> = [];
    let error: string | undefined;
    try {
      const [rawLength, eventsReply] = await Promise.all([
        this.command(["XLEN", this.keys.events]),
        this.command(["XREVRANGE", this.keys.events, "+", "-", "COUNT", String(sampleLimit)]),
      ]);
      lengthReply = rawLength;
      events = parseStreamEntries(eventsReply);
    } catch (cause) {
      error = formatUnknownError(cause);
    }
    const typeCounts = new Map<string, RunControlEventTypeCount>();
    const highVolumeCounts = new Map<string, RunControlEventTypeCount>();
    const warningCounts = new Map<string, RunControlEventTypeCount>();
    for (const event of events) {
      const type = event.fields.type || "unknown";
      incrementEventCount(typeCounts, type, event.fields.createdAt);
      if (HIGH_VOLUME_EVENT_TYPES.has(type)) incrementEventCount(highVolumeCounts, type, event.fields.createdAt);
      if (isWarningEvent(type, event.fields)) incrementEventCount(warningCounts, type, event.fields.createdAt);
    }
    const newest = events[0];
    const oldest = events[events.length - 1];
    return {
      streamKey: this.keys.events,
      streamLength: Number(lengthReply) || 0,
      sampleLimit,
      sampleCount: events.length,
      newestEventId: newest?.id,
      oldestSampledEventId: oldest?.id,
      newestCreatedAt: newest?.fields.createdAt,
      oldestSampledCreatedAt: oldest?.fields.createdAt,
      typeCounts: sortedEventCounts(typeCounts),
      highVolumeTypeCounts: sortedEventCounts(highVolumeCounts),
      warningTypeCounts: sortedEventCounts(warningCounts),
      error,
    };
  }

  private async readJobRunId(streamId: string): Promise<string | undefined> {
    const entries = parseStreamEntries(await this.command(["XRANGE", this.keys.jobs, streamId, streamId]));
    return entries[0]?.fields.runId || undefined;
  }

  async listWorkers(): Promise<RunControlWorkerRecord[]> {
    const keys = await this.keysMatching(this.keys.workerPattern);
    const workers: RunControlWorkerRecord[] = [];
    for (const key of keys) {
      const hash = await this.hgetall(key);
      const workerId = hash.workerId || this.keys.workerIdFromWorkerKey(key);
      if (!workerId) continue;
      const ttlMs = Number(await this.command(["PTTL", key]).catch(() => -2));
      workers.push({
        workerId,
        status: hash.status || undefined,
        runId: hash.runId || undefined,
        updatedAt: hash.updatedAt || undefined,
        ttlMs,
      });
    }
    return workers.sort((a, b) => a.workerId.localeCompare(b.workerId));
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
    return !run || isTerminalRunStatus(run.status);
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

  private async blockingCommand(args: string[], isolationKey: string): Promise<unknown> {
    return this.client.sendBlockingCommand
      ? this.client.sendBlockingCommand(args, isolationKey)
      : this.client.sendCommand(args);
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

  get workerPattern(): string {
    return `${this.prefix}:workers:*`;
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

  workerIdFromWorkerKey(key: string): string {
    const start = `${this.prefix}:workers:`;
    return key.startsWith(start) ? key.slice(start.length) : key;
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
    leaseExpiresAt: record.leaseExpiresAt,
    leaseGeneration: record.leaseGeneration === undefined ? undefined : String(record.leaseGeneration),
    retryLaterCount: record.retryLaterCount === undefined ? undefined : String(record.retryLaterCount),
    lastRetryLaterAt: record.lastRetryLaterAt,
    lastRetryLaterReason: record.lastRetryLaterReason,
    lastRetryLaterWorkerId: record.lastRetryLaterWorkerId,
    deadLetteredAt: record.deadLetteredAt,
    deadLetterReason: record.deadLetterReason,
    deadLetteredByWorkerId: record.deadLetteredByWorkerId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finalizedAt: record.finalizedAt,
    finalizeAttemptedAt: record.finalizeAttemptedAt,
    finalDiscordOutboxStartedAt: record.finalDiscordOutboxStartedAt,
    finalDiscordMessageIdsJson: record.finalDiscordMessageIds ? JSON.stringify(record.finalDiscordMessageIds) : undefined,
    finalDiscordChunkCount: record.finalDiscordChunkCount === undefined ? undefined : String(record.finalDiscordChunkCount),
    finalDiscordReservedAt: record.finalDiscordReservedAt,
    finalDiscordPostedAt: record.finalDiscordPostedAt,
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
    leaseExpiresAt: hash.leaseExpiresAt || undefined,
    leaseGeneration: hash.leaseGeneration ? Number(hash.leaseGeneration) : undefined,
    retryLaterCount: hash.retryLaterCount ? Number(hash.retryLaterCount) : undefined,
    lastRetryLaterAt: hash.lastRetryLaterAt || undefined,
    lastRetryLaterReason: hash.lastRetryLaterReason || undefined,
    lastRetryLaterWorkerId: hash.lastRetryLaterWorkerId || undefined,
    deadLetteredAt: hash.deadLetteredAt || undefined,
    deadLetterReason: hash.deadLetterReason || undefined,
    deadLetteredByWorkerId: hash.deadLetteredByWorkerId || undefined,
    createdAt: hash.createdAt,
    updatedAt: hash.updatedAt,
    startedAt: hash.startedAt || undefined,
    finalizedAt: hash.finalizedAt || undefined,
    finalizeAttemptedAt: hash.finalizeAttemptedAt || undefined,
    finalDiscordOutboxStartedAt: hash.finalDiscordOutboxStartedAt || undefined,
    finalDiscordMessageIds: parseJson(hash.finalDiscordMessageIdsJson, []),
    finalDiscordChunkCount: hash.finalDiscordChunkCount ? Number(hash.finalDiscordChunkCount) : undefined,
    finalDiscordReservedAt: hash.finalDiscordReservedAt || undefined,
    finalDiscordPostedAt: hash.finalDiscordPostedAt || undefined,
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

function parseEvalArray(reply: unknown): string[] {
  return Array.isArray(reply) ? reply.map(valueToString) : [valueToString(reply)];
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

function parsePendingDetailReply(reply: unknown): Array<{ streamId: string; consumer: string; idleMs: number; deliveries: number }> {
  if (!Array.isArray(reply)) return [];
  return reply.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 4) return [];
    return [{
      streamId: valueToString(entry[0]),
      consumer: valueToString(entry[1]),
      idleMs: Number(entry[2]) || 0,
      deliveries: Number(entry[3]) || 0,
    }];
  }).filter((entry) => Boolean(entry.streamId));
}

function parsePendingSummary(reply: unknown): RunControlJobQueueSummary {
  if (!Array.isArray(reply)) return { pendingCount: 0, consumers: [] };
  const [count, first, last, consumers] = reply;
  return {
    pendingCount: Number(count) || 0,
    firstPendingId: valueToString(first) || undefined,
    lastPendingId: valueToString(last) || undefined,
    consumers: Array.isArray(consumers)
      ? consumers.flatMap((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) return [];
        return [{ name: valueToString(entry[0]), pending: Number(entry[1]) || 0 }];
      })
      : [],
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

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function incrementEventCount(counts: Map<string, RunControlEventTypeCount>, type: string, createdAt: string | undefined): void {
  const current = counts.get(type);
  if (!current) {
    counts.set(type, { type, count: 1, newestCreatedAt: createdAt });
    return;
  }
  current.count += 1;
  if (!current.newestCreatedAt && createdAt) current.newestCreatedAt = createdAt;
}

function sortedEventCounts(counts: Map<string, RunControlEventTypeCount>): RunControlEventTypeCount[] {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function isWarningEvent(type: string, fields: Record<string, string>): boolean {
  if (fields.isError === "true") return true;
  return /(?:error|fail|dead|retry_later|lease_lost|stale|busy|timeout)/iu.test(type);
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
