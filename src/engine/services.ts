import type { InlineImageContent } from "../attachments.js";
import type { AppConfig } from "../config.js";
import type { CompactResult, PromptProgressHandler, PromptResult, PromptRunOptions, QueueMessageResult } from "../pi-runtime.js";
import type {
  LinkIngestRecord,
  LinkIngestStatusUpdateRecord,
  MessageRecord,
  RegistryPort,
  ThreadRecord,
} from "../registry.js";
import type {
  ActivePointer,
  FinalizeClaim,
  QueuedRunInput,
  RunControlEventSummary,
  RunControlJobQueueSummary,
  RunControlPendingJobDetail,
  RunControlWorkerRecord,
  RunJob,
  RunRecord,
  RetryLaterRecordResult,
} from "../run-control/types.js";
import { Context, Effect, Option } from "effect";
import type {
  DiscordMessageId,
  MentionId,
  RegistryError,
  RegistryLinkIngestNotFound,
  RegistryThreadNotFound,
  RegistryWriteFailed,
  PiSessionError,
  RunQueueError,
  ThreadId,
} from "./domain.js";

export class AppConfigService extends Context.Service<AppConfigService, AppConfig>()(
  "pi-discord/AppConfigService",
) {}

export interface RegistryServiceShape {
  readonly save: () => Effect.Effect<void, RegistryWriteFailed>;
  readonly getThread: (threadId: ThreadId) => Effect.Effect<Option.Option<ThreadRecord>>;
  readonly listThreads: () => Effect.Effect<readonly ThreadRecord[]>;
  readonly upsertThread: (input: Parameters<RegistryPort["upsertThread"]>[0]) => Effect.Effect<ThreadRecord, RegistryWriteFailed>;
  readonly patchThread: (
    threadId: ThreadId,
    patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>,
  ) => Effect.Effect<ThreadRecord, RegistryThreadNotFound | RegistryWriteFailed>;
  readonly markRunningThreadsInterrupted: () => Effect.Effect<number, RegistryWriteFailed>;
  readonly recordMessage: (record: MessageRecord) => Effect.Effect<void, RegistryWriteFailed>;
  readonly recordMessageEntry: (
    discordMessageId: DiscordMessageId,
    entryId: string | undefined,
  ) => Effect.Effect<void, RegistryWriteFailed>;
  readonly getMessage: (discordMessageId: DiscordMessageId) => Effect.Effect<Option.Option<MessageRecord>>;
  readonly upsertLinkIngest: (record: LinkIngestRecord) => Effect.Effect<void, RegistryWriteFailed>;
  readonly getLinkIngest: (mentionId: MentionId) => Effect.Effect<Option.Option<LinkIngestRecord>>;
  readonly listLinkIngests: () => Effect.Effect<readonly LinkIngestRecord[]>;
  readonly getLinkIngestStatusUpdate: (
    mentionId: MentionId,
    statusKey: string,
  ) => Effect.Effect<Option.Option<LinkIngestStatusUpdateRecord>>;
  readonly recordLinkIngestStatusUpdate: (
    update: LinkIngestStatusUpdateRecord,
  ) => Effect.Effect<void, RegistryLinkIngestNotFound | RegistryWriteFailed>;
}

export class RegistryService extends Context.Service<RegistryService, RegistryServiceShape>()(
  "pi-discord/RegistryService",
) {}

export interface RunQueueServiceShape {
  readonly ensureConsumerGroup: () => Effect.Effect<void, RunQueueError>;
  readonly tryEnqueueRun: (
    run: RunRecord,
  ) => Effect.Effect<{ enqueued: true; run: RunRecord } | { enqueued: false; activeRunId: string }, RunQueueError>;
  readonly appendInput: (input: QueuedRunInput) => Effect.Effect<string, RunQueueError>;
  readonly getInputStreamLength: (logicalThreadId: string) => Effect.Effect<number, RunQueueError>;
  readonly countInputsForRun: (logicalThreadId: string, runId: string) => Effect.Effect<number, RunQueueError>;
  readonly readInputsSince: (
    logicalThreadId: string,
    lastId: string,
    count?: number,
  ) => Effect.Effect<QueuedRunInput[], RunQueueError>;
  readonly dequeueJob: (workerId: string, blockMs: number) => Effect.Effect<RunJob | undefined, RunQueueError>;
  readonly claimStaleJob: (workerId: string) => Effect.Effect<RunJob | undefined, RunQueueError>;
  readonly acknowledgeJob: (job: RunJob) => Effect.Effect<void, RunQueueError>;
  readonly getRun: (runId: string) => Effect.Effect<RunRecord | undefined, RunQueueError>;
  readonly patchRun: (
    runId: string,
    patch: Partial<RunRecord>,
    options?: { preserveTerminal?: boolean },
  ) => Effect.Effect<RunRecord | undefined, RunQueueError>;
  readonly markTerminal: (
    runId: string,
    status: "succeeded" | "failed" | "interrupted" | "aborted",
    patch?: Partial<RunRecord>,
  ) => Effect.Effect<RunRecord | undefined, RunQueueError>;
  readonly getActiveRunId: (logicalThreadId: string) => Effect.Effect<string | undefined, RunQueueError>;
  readonly getQueueableActiveRunId: (logicalThreadId: string) => Effect.Effect<string | undefined, RunQueueError>;
  readonly clearActiveIfMatches: (logicalThreadId: string, runId: string) => Effect.Effect<boolean, RunQueueError>;
  readonly claimRunLease: (run: RunRecord, workerId: string, leaseToken: string) => Effect.Effect<boolean, RunQueueError>;
  readonly heartbeatRunLease: (
    runId: string,
    logicalThreadId: string,
    leaseToken: string,
    workerId: string,
  ) => Effect.Effect<boolean, RunQueueError>;
  readonly verifyRunOwnership: (runId: string, logicalThreadId: string, leaseToken: string) => Effect.Effect<boolean, RunQueueError>;
  readonly releaseRunLease: (runId: string, leaseToken: string) => Effect.Effect<boolean, RunQueueError>;
  readonly recordRetryLater: (
    run: RunRecord,
    leaseToken: string,
    workerId: string,
    reason: string,
    maxAttempts: number,
  ) => Effect.Effect<RetryLaterRecordResult, RunQueueError>;
  readonly acquireFinalize: (runId: string, leaseToken: string) => Effect.Effect<FinalizeClaim, RunQueueError>;
  readonly completeFinalize: (runId: string, leaseToken: string) => Effect.Effect<boolean, RunQueueError>;
  readonly getRunLeaseTtl: (runId: string) => Effect.Effect<number, RunQueueError>;
  readonly appendRunEvent: (
    runId: string,
    type: string,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<string, RunQueueError>;
  readonly recordWorkerIdle: (workerId: string) => Effect.Effect<void, RunQueueError>;
  readonly getJobQueueSummary: () => Effect.Effect<RunControlJobQueueSummary, RunQueueError>;
  readonly getPendingJobDetails: (limit?: number) => Effect.Effect<readonly RunControlPendingJobDetail[], RunQueueError>;
  readonly getRunEventSummary: (options?: { sampleLimit?: number }) => Effect.Effect<RunControlEventSummary, RunQueueError>;
  readonly listWorkers: () => Effect.Effect<readonly RunControlWorkerRecord[], RunQueueError>;
  readonly listRuns: () => Effect.Effect<readonly RunRecord[], RunQueueError>;
  readonly listActivePointers: () => Effect.Effect<readonly ActivePointer[], RunQueueError>;
}

export class RunQueueService extends Context.Service<RunQueueService, RunQueueServiceShape>()(
  "pi-discord/RunQueueService",
) {}

export interface PiSessionServiceShape {
  readonly enqueuePrompt: (
    thread: ThreadRecord,
    text: string,
    images?: InlineImageContent[],
    onProgress?: PromptProgressHandler,
    options?: PromptRunOptions,
  ) => Effect.Effect<PromptResult, PiSessionError>;
  readonly queueMessageDuringActive: (
    threadId: string,
    text: string,
    mode?: "steer" | "followUp",
    images?: InlineImageContent[],
  ) => Effect.Effect<QueueMessageResult, PiSessionError>;
  readonly queueMessageForThreadIfActive: (
    thread: ThreadRecord,
    text: string,
    mode?: "steer" | "followUp",
    images?: InlineImageContent[],
  ) => Effect.Effect<QueueMessageResult, PiSessionError>;
  readonly enqueueReload: (thread: ThreadRecord, onProgress?: PromptProgressHandler) => Effect.Effect<void, PiSessionError>;
  readonly enqueueCompact: (
    thread: ThreadRecord,
    customInstructions?: string,
    onProgress?: PromptProgressHandler,
  ) => Effect.Effect<CompactResult, PiSessionError>;
  readonly isActive: (threadId: string) => boolean;
  readonly abort: (threadId: string) => Effect.Effect<void, PiSessionError>;
  readonly disposeAll: () => Effect.Effect<void, PiSessionError>;
}

export class PiSessionService extends Context.Service<PiSessionService, PiSessionServiceShape>()(
  "pi-discord/PiSessionService",
) {}

export type RegistryServiceError = RegistryError;
export type RunQueueServiceError = RunQueueError;
export type PiSessionServiceError = PiSessionError;
