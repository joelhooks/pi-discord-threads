import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { RegistryPort, ThreadRecord } from "../registry.js";
import { formatUnknownError } from "../error-format.js";
import { reconcileRunControl, type ReconcileReport } from "./reconcile.js";
import type { ActivePointer, RunControlJobQueueSummary, RunControlStorePort, RunControlWorkerRecord, RunRecord } from "./types.js";

const DAEMON_STDERR_TAIL_BYTES = 64 * 1024;

export interface RunControlDoctorActivePointer {
  logicalThreadId: string;
  runId: string;
  status?: string;
  workerId?: string;
  leaseTtlMs?: number;
  retryLaterCount?: number;
  deadLetteredAt?: string;
}

export interface RunControlDoctorOutboxRun {
  runId: string;
  status: string;
  chunkCount?: number;
  messageIds: string[];
  reservedAt?: string;
  postedAt?: string;
  startedAt?: string;
}

export interface RunControlDoctorDeadLetterRun {
  runId: string;
  status: string;
  retryLaterCount?: number;
  deadLetteredAt?: string;
  deadLetterReason?: string;
}

export interface RunControlDoctorReport {
  checkedAt: string;
  activePointers: RunControlDoctorActivePointer[];
  pendingJobs: RunControlJobQueueSummary;
  workers: RunControlWorkerRecord[];
  outboxRuns: RunControlDoctorOutboxRun[];
  deadLetteredRuns: RunControlDoctorDeadLetterRun[];
  reconcile: Pick<ReconcileReport, "issues" | "applied">;
  daemonStderr: {
    path: string;
    lineCount: number;
    tail: string[];
    truncated: boolean;
    error?: string;
  };
}

export async function loadRunControlDoctorRegistry(config: AppConfig): Promise<RegistryPort> {
  const registryPath = join(config.dataDir, "registry.json");
  if (!existsSync(registryPath)) return readOnlyRegistry({});
  const raw = await readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as { threads?: Record<string, Partial<ThreadRecord>> };
  const threads: Record<string, ThreadRecord> = {};
  for (const [threadId, record] of Object.entries(parsed.threads ?? {})) {
    const normalizedThreadId = String(record.threadId ?? threadId);
    threads[threadId] = {
      ...record,
      threadId: normalizedThreadId,
      kind: record.kind ?? (normalizedThreadId.startsWith("dm:") ? "discord-dm-workroom" : "discord-thread"),
      cwd: record.cwd ?? process.cwd(),
      status: record.status ?? "idle",
      createdAt: record.createdAt ?? new Date(0).toISOString(),
      updatedAt: record.updatedAt ?? new Date(0).toISOString(),
    } as ThreadRecord;
  }
  return readOnlyRegistry(threads);
}

export async function buildRunControlDoctorReport(options: {
  store: RunControlStorePort;
  registry: RegistryPort;
  config: AppConfig;
  stderrPath?: string;
  stderrTailLines?: number;
}): Promise<RunControlDoctorReport> {
  const { store, registry, config } = options;
  const checkedAt = new Date().toISOString();
  const runs = await store.listRuns();
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const activePointers = await store.listActivePointers();
  const activePointerReports = await Promise.all(activePointers.map(async (pointer) => {
    const run = runsById.get(pointer.runId) ?? await store.getRun(pointer.runId).catch(() => undefined);
    const leaseTtlMs = run ? await store.getRunLeaseTtl(run.runId).catch(() => undefined) : undefined;
    return activePointerReport(pointer, run, leaseTtlMs);
  }));

  const [pendingJobs, workers, reconcile, daemonStderr] = await Promise.all([
    store.getJobQueueSummary(),
    store.listWorkers(),
    reconcileRunControl({ store, registry, config, apply: false }),
    readDaemonStderr(options.stderrPath ?? join(config.dataDir, "daemon.err.log"), options.stderrTailLines ?? 20),
  ]);

  return {
    checkedAt,
    activePointers: activePointerReports,
    pendingJobs,
    workers,
    outboxRuns: runs.filter(hasOutboxState).map(outboxRunReport),
    deadLetteredRuns: runs.filter((run) => Boolean(run.deadLetteredAt || run.deadLetterReason)).map(deadLetterRunReport),
    reconcile: { issues: reconcile.issues, applied: reconcile.applied },
    daemonStderr,
  };
}

export function formatRunControlDoctorReport(report: RunControlDoctorReport): string {
  const lines = [`run-control doctor checkedAt: ${report.checkedAt}`];

  lines.push(`activePointers: ${report.activePointers.length}`);
  if (report.activePointers.length === 0) lines.push("- none");
  for (const pointer of report.activePointers) {
    lines.push(`- ${pointer.logicalThreadId} -> ${pointer.runId} status=${pointer.status ?? "missing"} worker=${pointer.workerId ?? "none"} leaseTtlMs=${formatOptionalNumber(pointer.leaseTtlMs)} retryLater=${formatOptionalNumber(pointer.retryLaterCount)}${pointer.deadLetteredAt ? ` deadLetteredAt=${pointer.deadLetteredAt}` : ""}`);
  }

  lines.push(`pendingJobs: ${report.pendingJobs.pendingCount}${report.pendingJobs.firstPendingId ? ` first=${report.pendingJobs.firstPendingId}` : ""}${report.pendingJobs.lastPendingId ? ` last=${report.pendingJobs.lastPendingId}` : ""}`);
  if (report.pendingJobs.consumers.length === 0) lines.push("- consumers: none");
  for (const consumer of report.pendingJobs.consumers) lines.push(`- consumer ${consumer.name} pending=${consumer.pending}`);

  lines.push(`workers: ${report.workers.length}`);
  if (report.workers.length === 0) lines.push("- none");
  for (const worker of report.workers) {
    lines.push(`- ${worker.workerId} status=${worker.status ?? "unknown"} ${formatWorkerRunField(worker)} updatedAt=${worker.updatedAt ?? "unknown"} ttlMs=${worker.ttlMs}`);
  }

  lines.push(`outboxRuns: ${report.outboxRuns.length}`);
  if (report.outboxRuns.length === 0) lines.push("- none");
  for (const outbox of report.outboxRuns) {
    lines.push(`- ${outbox.runId} status=${outbox.status} chunks=${formatOptionalNumber(outbox.chunkCount)} ids=${outbox.messageIds.length} startedAt=${outbox.startedAt ?? "none"} reservedAt=${outbox.reservedAt ?? "none"} postedAt=${outbox.postedAt ?? "none"}`);
  }

  lines.push(`deadLetteredRuns: ${report.deadLetteredRuns.length}`);
  if (report.deadLetteredRuns.length === 0) lines.push("- none");
  for (const run of report.deadLetteredRuns) {
    lines.push(`- ${run.runId} status=${run.status} retryLater=${formatOptionalNumber(run.retryLaterCount)} deadLetteredAt=${run.deadLetteredAt ?? "unknown"} reason=${run.deadLetterReason ?? "unknown"}`);
  }

  lines.push(`reconcileIssues: ${report.reconcile.issues.length}`);
  if (report.reconcile.issues.length === 0) lines.push("- none");
  for (const issue of report.reconcile.issues) lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}${issue.action ? ` (${issue.action})` : ""}`);

  lines.push(`daemonStderr: ${report.daemonStderr.path} lines=${report.daemonStderr.lineCount}${report.daemonStderr.truncated ? ` tailBytes=${DAEMON_STDERR_TAIL_BYTES}` : ""}${report.daemonStderr.error ? ` error=${report.daemonStderr.error}` : ""}`);
  if (report.daemonStderr.tail.length === 0) lines.push("- tail: empty");
  for (const line of report.daemonStderr.tail) lines.push(`- ${line}`);

  return lines.join("\n");
}

function readOnlyRegistry(threads: Record<string, ThreadRecord>): RegistryPort {
  return {
    getThread: (threadId: string) => threads[threadId],
    listThreads: () => Object.values(threads),
    save: async () => undefined,
  } as unknown as RegistryPort;
}

function activePointerReport(pointer: ActivePointer, run: RunRecord | undefined, leaseTtlMs: number | undefined): RunControlDoctorActivePointer {
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

function outboxRunReport(run: RunRecord): RunControlDoctorOutboxRun {
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

function deadLetterRunReport(run: RunRecord): RunControlDoctorDeadLetterRun {
  return {
    runId: run.runId,
    status: run.status,
    retryLaterCount: run.retryLaterCount,
    deadLetteredAt: run.deadLetteredAt,
    deadLetterReason: run.deadLetterReason,
  };
}

async function readDaemonStderr(path: string, tailLines: number): Promise<RunControlDoctorReport["daemonStderr"]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const stats = await file.stat();
    const start = Math.max(0, stats.size - DAEMON_STDERR_TAIL_BYTES);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await file.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/u).filter((line) => line.length > 0);
    const truncated = start > 0;
    if (truncated && lines.length > 0) lines[0] = `…${lines[0]}`;
    return { path, lineCount: lines.length, tail: lines.slice(-tailLines), truncated };
  } catch (error) {
    return { path, lineCount: 0, tail: [], truncated: false, error: formatUnknownError(error) };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function formatWorkerRunField(worker: RunControlWorkerRecord): string {
  if (worker.status === "idle" && worker.runId) return `run=none staleRun=${worker.runId}`;
  return `run=${worker.runId ?? "none"}`;
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "unknown" : String(value);
}
