import type {
  ActivePointer,
  RunControlJobQueueSummary,
  RunControlStorePort,
  RunControlWorkerRecord,
  RunRecord,
} from "./types.js";

export interface RunControlReadModelActiveRun {
  logicalThreadId: string;
  runId: string;
  status?: string;
  workerId?: string;
  leaseTtlMs?: number;
  retryLaterCount?: number;
  deadLetteredAt?: string;
}

export interface RunControlReadModelOutboxRun {
  runId: string;
  status: string;
  chunkCount?: number;
  messageIds: string[];
  reservedAt?: string;
  postedAt?: string;
  startedAt?: string;
}

export interface RunControlReadModelDeadLetterRun {
  runId: string;
  status: string;
  retryLaterCount?: number;
  deadLetteredAt?: string;
  deadLetterReason?: string;
}

export interface RunControlReadModel {
  checkedAt: string;
  runs: RunRecord[];
  activePointers: ActivePointer[];
  activeRuns: RunControlReadModelActiveRun[];
  pendingJobs: RunControlJobQueueSummary;
  workers: RunControlWorkerRecord[];
  outboxRuns: RunControlReadModelOutboxRun[];
  deadLetteredRuns: RunControlReadModelDeadLetterRun[];
  leaseTtlByRunId: Map<string, number>;
}

export type RunControlReadModelStorePort = Pick<RunControlStorePort,
  | "listRuns"
  | "listActivePointers"
  | "getRun"
  | "getRunLeaseTtl"
  | "getJobQueueSummary"
  | "listWorkers"
>;

export interface LoadRunControlReadModelOptions {
  checkedAt?: string;
}

export async function loadRunControlReadModel(
  store: RunControlReadModelStorePort,
  options: LoadRunControlReadModelOptions = {},
): Promise<RunControlReadModel> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const runs = await store.listRuns();
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const activePointers = await store.listActivePointers();

  for (const pointer of activePointers) {
    if (runsById.has(pointer.runId)) continue;
    // listRuns() and listActivePointers() are separate Redis scans. A run can be
    // enqueued between them, so re-read the pointed run before any consumer
    // treats the active pointer as orphaned.
    const run = await store.getRun(pointer.runId);
    if (!run) continue;
    runs.push(run);
    runsById.set(run.runId, run);
  }

  const leaseRunIds = new Set<string>();
  for (const run of runs) {
    if (run.status === "running" || run.status === "finalizing") leaseRunIds.add(run.runId);
  }
  for (const pointer of activePointers) {
    if (runsById.has(pointer.runId)) leaseRunIds.add(pointer.runId);
  }

  const [leaseTtlEntries, pendingJobs, workers] = await Promise.all([
    Promise.all([...leaseRunIds].map(async (runId) => [runId, await store.getRunLeaseTtl(runId)] as const)),
    store.getJobQueueSummary(),
    store.listWorkers(),
  ]);
  const leaseTtlByRunId = new Map(leaseTtlEntries);

  return {
    checkedAt,
    runs,
    activePointers,
    activeRuns: activePointers.map((pointer) => activeRunReport(pointer, runsById.get(pointer.runId), leaseTtlByRunId.get(pointer.runId))),
    pendingJobs,
    workers,
    outboxRuns: runs.filter(hasOutboxState).map(outboxRunReport),
    deadLetteredRuns: runs.filter((run) => Boolean(run.deadLetteredAt || run.deadLetterReason)).map(deadLetterRunReport),
    leaseTtlByRunId,
  };
}

function activeRunReport(pointer: ActivePointer, run: RunRecord | undefined, leaseTtlMs: number | undefined): RunControlReadModelActiveRun {
  return {
    logicalThreadId: pointer.logicalThreadId,
    runId: pointer.runId,
    status: run?.status,
    workerId: run?.workerId,
    leaseTtlMs,
    retryLaterCount: run?.retryLaterCount,
    deadLetteredAt: run?.deadLetteredAt,
  };
}

function hasOutboxState(run: RunRecord): boolean {
  return Boolean(run.finalDiscordOutboxStartedAt
    || run.finalDiscordReservedAt
    || run.finalDiscordPostedAt
    || run.finalDiscordChunkCount
    || (run.finalDiscordMessageIds?.length ?? 0) > 0);
}

function outboxRunReport(run: RunRecord): RunControlReadModelOutboxRun {
  return {
    runId: run.runId,
    status: run.status,
    chunkCount: run.finalDiscordChunkCount,
    messageIds: run.finalDiscordMessageIds ?? [],
    startedAt: run.finalDiscordOutboxStartedAt,
    reservedAt: run.finalDiscordReservedAt,
    postedAt: run.finalDiscordPostedAt,
  };
}

function deadLetterRunReport(run: RunRecord): RunControlReadModelDeadLetterRun {
  return {
    runId: run.runId,
    status: run.status,
    retryLaterCount: run.retryLaterCount,
    deadLetteredAt: run.deadLetteredAt,
    deadLetterReason: run.deadLetterReason,
  };
}
