import type { InlineImageContent } from "../attachments.js";
export type { RunControlRole } from "../config.js";
export { runControlRoles } from "../config.js";

export type RunStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "aborted";

export const terminalRunStatuses = ["succeeded", "failed", "interrupted", "aborted"] as const;
export type TerminalRunStatus = typeof terminalRunStatuses[number];

export function isTerminalRunStatus(status: string | undefined): status is TerminalRunStatus {
  return terminalRunStatuses.includes(status as TerminalRunStatus);
}

export type RunKind = "discord-thread" | "discord-dm-workroom";

export interface RunRecord {
  runId: string;
  logicalThreadId: string;
  threadId: string;
  kind: RunKind;
  status: RunStatus;
  sourceDiscordMessageId: string;
  placeholderDiscordMessageId: string;
  prompt: string;
  promptPreview: string;
  cwd: string;
  workspaceName?: string;
  sessionFile?: string;
  images?: InlineImageContent[];
  userEntryId?: string;
  assistantEntryId?: string;
  resultText?: string;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  leaseGeneration?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finalizedAt?: string;
  finalizeAttemptedAt?: string;
  placeholderRetiredAt?: string;
  error?: string;
}

export interface QueuedRunInput {
  inputId?: string;
  runId: string;
  logicalThreadId: string;
  mode: "steer" | "followUp";
  text: string;
  images?: InlineImageContent[];
  sourceDiscordMessageId?: string;
  createdAt: string;
}

export interface RunJob {
  streamId: string;
  runId: string;
}

export type FinalizeClaim = "acquired" | "busy" | "done";

export interface RunControlExecutionResult {
  text: string;
  sessionFile: string | undefined;
  userEntryId?: string;
  assistantEntryId?: string;
}

export interface ActivePointer {
  logicalThreadId: string;
  runId: string;
}

export interface RunControlStorePort {
  close(): Promise<void>;
  ensureConsumerGroup(): Promise<void>;
  tryEnqueueRun(run: RunRecord): Promise<{ enqueued: true; run: RunRecord } | { enqueued: false; activeRunId: string }>;
  appendInput(input: QueuedRunInput): Promise<string>;
  getInputStreamLength(logicalThreadId: string): Promise<number>;
  countInputsForRun(logicalThreadId: string, runId: string): Promise<number>;
  readInputsSince(logicalThreadId: string, lastId: string, count?: number): Promise<QueuedRunInput[]>;
  dequeueJob(workerId: string, blockMs: number): Promise<RunJob | undefined>;
  claimStaleJob(workerId: string): Promise<RunJob | undefined>;
  acknowledgeJob(job: RunJob): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  patchRun(
    runId: string,
    patch: Partial<RunRecord>,
    options?: { preserveTerminal?: boolean },
  ): Promise<RunRecord | undefined>;
  markTerminal(
    runId: string,
    status: "succeeded" | "failed" | "interrupted" | "aborted",
    patch?: Partial<RunRecord>,
  ): Promise<RunRecord | undefined>;
  getActiveRunId(logicalThreadId: string): Promise<string | undefined>;
  getQueueableActiveRunId(logicalThreadId: string): Promise<string | undefined>;
  clearActiveIfMatches(logicalThreadId: string, runId: string): Promise<boolean>;
  claimRunLease(run: RunRecord, workerId: string, leaseToken: string): Promise<boolean>;
  heartbeatRunLease(runId: string, logicalThreadId: string, leaseToken: string, workerId: string): Promise<boolean>;
  verifyRunOwnership(runId: string, logicalThreadId: string, leaseToken: string): Promise<boolean>;
  releaseRunLease(runId: string, leaseToken: string): Promise<boolean>;
  acquireFinalize(runId: string, leaseToken: string): Promise<FinalizeClaim>;
  completeFinalize(runId: string, leaseToken: string): Promise<boolean>;
  getRunLeaseTtl(runId: string): Promise<number>;
  appendRunEvent(runId: string, type: string, fields?: Record<string, unknown>): Promise<string>;
  recordWorkerIdle(workerId: string): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
  listActivePointers(): Promise<ActivePointer[]>;
}
