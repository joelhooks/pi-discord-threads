import type { AppConfig } from "../config.js";
import type { RedisCommandClient } from "./redis-client.js";
import { RetryRunLaterError } from "./errors.js";
import {
  type ActivePointer,
  type FinalizeClaim,
  type QueuedRunInput,
  type RunJob,
  type RunRecord,
  type RetryLaterRecordResult,
  isTerminalRunStatus,
} from "./types.js";

const WORKER_GROUP = "workers";

const VERIFY_RUN_OWNERSHIP_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return 0
end
return 1
`;

const ATOMIC_ENQUEUE_RUN_SCRIPT = `
local active = redis.call('GET', KEYS[1])
if active then
  return {'busy', active}
end
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #ARGV, 2 do
  local hset = redis.pcall('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
  if type(hset) == 'table' and hset['err'] then
    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[2])
    return {'error', hset['err']}
  end
end
local jobId = redis.pcall('XADD', KEYS[3], '*', 'runId', ARGV[1])
if type(jobId) == 'table' and jobId['err'] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return {'error', jobId['err']}
end
return {'enqueued', ARGV[1], jobId}
`;

const CLAIM_RUN_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= ARGV[8] then
  return 0
end
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return 0
end
local claimed = redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3])
if not ((type(claimed) == 'table' and claimed['ok'] == 'OK') or claimed == 'OK') then
  return 0
end
local generation = redis.pcall('HINCRBY', KEYS[3], 'leaseGeneration', 1)
if type(generation) == 'table' and generation['err'] then
  redis.call('DEL', KEYS[2])
  return {'error', generation['err']}
end
local hset = redis.pcall('HSET', KEYS[3],
  'status', ARGV[4],
  'workerId', ARGV[5],
  'leaseToken', ARGV[2],
  'startedAt', ARGV[6],
  'updatedAt', ARGV[7],
  'leaseExpiresAt', ARGV[9],
  'leaseGeneration', generation
)
if type(hset) == 'table' and hset['err'] then
  redis.call('DEL', KEYS[2])
  return {'error', hset['err']}
end
return 1
`;

const RECORD_RETRY_LATER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return {'lost', 'active'}
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return {'lost', 'lease'}
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return {'lost', status or 'missing'}
end
local attempts = redis.pcall('HINCRBY', KEYS[3], 'retryLaterCount', 1)
if type(attempts) == 'table' and attempts['err'] then
  return {'error', attempts['err']}
end
local hset = redis.pcall('HSET', KEYS[3],
  'lastRetryLaterAt', ARGV[4],
  'lastRetryLaterReason', ARGV[5],
  'lastRetryLaterWorkerId', ARGV[3],
  'updatedAt', ARGV[4]
)
if type(hset) == 'table' and hset['err'] then
  return {'error', hset['err']}
end
if attempts >= tonumber(ARGV[6]) then
  local deadLetterReason = 'run-control dead-lettered ' .. ARGV[1] .. ' after ' .. attempts .. ' retry-later attempt(s): ' .. ARGV[5]
  local terminal = redis.pcall('HSET', KEYS[3],
    'status', 'interrupted',
    'updatedAt', ARGV[4],
    'finalizedAt', ARGV[4],
    'deadLetteredAt', ARGV[4],
    'deadLetterReason', deadLetterReason,
    'deadLetteredByWorkerId', ARGV[3],
    'error', deadLetterReason
  )
  if type(terminal) == 'table' and terminal['err'] then
    return {'error', terminal['err']}
  end
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return {'dead_lettered', tostring(attempts)}
end
redis.call('DEL', KEYS[2])
return {'retry_later', tostring(attempts)}
`;

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
        ATOMIC_ENQUEUE_RUN_SCRIPT,
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
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
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
      CLAIM_RUN_LEASE_SCRIPT,
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
      "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end; if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end; local status = redis.call('HGET', KEYS[3], 'status'); if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then return 0 end; redis.call('PEXPIRE', KEYS[2], ARGV[3]); redis.call('HSET', KEYS[3], 'updatedAt', ARGV[4], 'workerId', ARGV[5], 'leaseExpiresAt', ARGV[6]); return 1",
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
      VERIFY_RUN_OWNERSHIP_SCRIPT,
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
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      this.keys.runLease(runId),
      leaseToken,
    ]);
    return Number(result) === 1;
  }

  async recordRetryLater(run: RunRecord, leaseToken: string, workerId: string, reason: string, maxAttempts: number): Promise<RetryLaterRecordResult> {
    const now = new Date().toISOString();
    const boundedMaxAttempts = String(Math.max(1, Math.floor(maxAttempts)));
    const reply = await this.command([
      "EVAL",
      RECORD_RETRY_LATER_SCRIPT,
      "3",
      this.keys.active(run.logicalThreadId),
      this.keys.runLease(run.runId),
      this.keys.run(run.runId),
      run.runId,
      leaseToken,
      workerId,
      now,
      reason,
      boundedMaxAttempts,
    ]);
    const [status, attemptsOrReason] = parseEvalArray(reply);
    if (status === "retry_later" || status === "dead_lettered") {
      const attempts = Number(attemptsOrReason);
      await this.appendRunEvent(run.runId, "retry_later", {
        logicalThreadId: run.logicalThreadId,
        workerId,
        attempts,
        maxAttempts: Number(boundedMaxAttempts),
        reason,
      }).catch(() => undefined);
      if (status === "dead_lettered") {
        await this.appendRunEvent(run.runId, "dead_lettered", {
          logicalThreadId: run.logicalThreadId,
          workerId,
          attempts,
          maxAttempts: Number(boundedMaxAttempts),
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
