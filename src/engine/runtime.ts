import { join } from "node:path";
import type { InlineImageContent } from "../attachments.js";
import type { AppConfig } from "../config.js";
import type { CompactResult, PiRuntimePort, PromptProgressHandler, PromptResult, PromptRunOptions, QueueMessageResult } from "../pi-runtime.js";
import { Registry, type LinkIngestRecord, type LinkIngestStatusUpdateRecord, type MessageRecord, type RegistryPort, type ThreadRecord } from "../registry.js";
import type {
  ActivePointer,
  QueuedRunInput,
  RunControlStorePort,
  RunJob,
  RunRecord,
} from "../run-control/types.js";
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import { JsonRegistryFromInstanceLive, PiRuntimeManagerLive, PiSessionManagerLive, RunQueueEngineLive } from "./layers.js";
import type { DiscordMessageId, MentionId, ThreadId } from "./domain.js";
import { PiSessionService, RegistryService, RunQueueService, type PiSessionServiceShape, type RegistryServiceShape, type RunQueueServiceShape } from "./services.js";

export const REGISTRY_ENGINE_NAME = "effect-managed";
export const RUN_QUEUE_ENGINE_NAME = "effect-managed";
export const PI_SESSION_ENGINE_NAME = "effect-managed";

export interface RegistryRuntimeClient extends RegistryPort {
  readonly engine: typeof REGISTRY_ENGINE_NAME;
  warmup(): Promise<void>;
  close(): Promise<void>;
}

export function createRegistryRuntimeClient(config: AppConfig): RegistryRuntimeClient {
  const registry = new Registry(join(config.dataDir, "registry.json"));
  const runtime = ManagedRuntime.make(JsonRegistryFromInstanceLive(registry));

  const withRegistry = <A, E>(
    operation: (registryService: RegistryServiceShape) => Effect.Effect<A, E>,
  ): Promise<A> => runtime.runPromise(
    Effect.gen(function* () {
      const registryService = yield* RegistryService;
      return yield* operation(registryService);
    }),
  );

  return {
    engine: REGISTRY_ENGINE_NAME,
    warmup: () => withRegistry(() => Effect.succeed(undefined)),
    close: () => runtime.dispose(),
    save: () => withRegistry((registryService) => registryService.save()),
    getThread: (threadId: string): ThreadRecord | undefined => registry.getThread(threadId),
    listThreads: (): ThreadRecord[] => registry.listThreads(),
    markRunningThreadsInterrupted: () => withRegistry((registryService) => registryService.markRunningThreadsInterrupted()),
    upsertThread: (input: Parameters<RegistryPort["upsertThread"]>[0]) => withRegistry((registryService) => registryService.upsertThread(input)),
    patchThread: (threadId: string, patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>) =>
      withRegistry((registryService) => registryService.patchThread(threadId as ThreadId, patch)),
    recordMessage: (record: MessageRecord) => withRegistry((registryService) => registryService.recordMessage(record)),
    recordMessageEntry: (discordMessageId: string, entryId: string | undefined) =>
      withRegistry((registryService) => registryService.recordMessageEntry(discordMessageId as DiscordMessageId, entryId)),
    getMessage: (discordMessageId: string): MessageRecord | undefined => registry.getMessage(discordMessageId),
    upsertLinkIngest: (record: LinkIngestRecord) => withRegistry((registryService) => registryService.upsertLinkIngest(record)),
    getLinkIngest: (mentionId: string): LinkIngestRecord | undefined => registry.getLinkIngest(mentionId),
    listLinkIngests: (): LinkIngestRecord[] => registry.listLinkIngests(),
    getLinkIngestStatusUpdate: (mentionId: string, statusKey: string): LinkIngestStatusUpdateRecord | undefined =>
      registry.getLinkIngestStatusUpdate(mentionId, statusKey),
    recordLinkIngestStatusUpdate: (update: LinkIngestStatusUpdateRecord) =>
      withRegistry((registryService) => registryService.recordLinkIngestStatusUpdate({
        ...update,
        mentionId: update.mentionId as MentionId,
      })),
  };
}

export interface PiSessionRuntimeClient extends PiRuntimePort {
  readonly engine: typeof PI_SESSION_ENGINE_NAME;
  warmup(): Promise<void>;
  close(): Promise<void>;
}

export function createPiSessionRuntimeClient(config: AppConfig, registry: RegistryPort): PiSessionRuntimeClient {
  let sessionRef: PiSessionServiceShape | undefined;
  let disposeError: unknown;
  const runtime = ManagedRuntime.make(PiRuntimeManagerLive(config, registry, {
    onService: (service) => {
      sessionRef = service;
    },
    onDisposeError: (cause) => {
      disposeError ??= cause;
    },
  }));

  return makePiSessionRuntimeClient(
    runtime,
    (threadId) => sessionRef?.isActive(threadId) ?? false,
    () => disposeError,
  );
}

export function createPiSessionRuntimeClientFromManager(manager: PiRuntimePort): PiSessionRuntimeClient {
  let managerLayerAcquired = false;
  let disposeError: unknown;
  const runtime = ManagedRuntime.make(PiSessionManagerLive(manager, {
    onService: () => {
      managerLayerAcquired = true;
    },
    onDisposeError: (cause) => {
      disposeError ??= cause;
    },
  }));

  return makePiSessionRuntimeClient(
    runtime,
    (threadId) => manager.isActive(threadId),
    () => disposeError,
    async () => {
      if (!managerLayerAcquired) {
        await manager.disposeAll();
      }
    },
  );
}

function makePiSessionRuntimeClient(
  runtime: ManagedRuntime.ManagedRuntime<PiSessionService, never>,
  isActive: (threadId: string) => boolean,
  getDisposeError: () => unknown,
  disposeBeforeRuntime?: () => Promise<void>,
): PiSessionRuntimeClient {
  const withSession = async <A, E>(
    operation: (session: PiSessionServiceShape) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const session = yield* PiSessionService;
        return yield* operation(session);
      }),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw unwrapPiSessionCause(exit.cause);
  };

  let runtimeDisposed = false;
  const disposeRuntime = async () => {
    if (runtimeDisposed) return;
    runtimeDisposed = true;
    try {
      await disposeBeforeRuntime?.();
    } finally {
      await runtime.dispose();
    }
    const disposeError = getDisposeError();
    if (disposeError !== undefined) throw disposeError;
  };

  return {
    engine: PI_SESSION_ENGINE_NAME,
    warmup: () => withSession(() => Effect.succeed(undefined)),
    close: disposeRuntime,
    enqueuePrompt: (thread: ThreadRecord, text: string, images?: InlineImageContent[], onProgress?: PromptProgressHandler, options?: PromptRunOptions): Promise<PromptResult> =>
      withSession((session) => session.enqueuePrompt(thread, text, images, onProgress, options)),
    queueMessageDuringActive: (threadId: string, text: string, mode?: "steer" | "followUp", images?: InlineImageContent[]): Promise<QueueMessageResult> =>
      withSession((session) => session.queueMessageDuringActive(threadId, text, mode, images)),
    queueMessageForThreadIfActive: (thread: ThreadRecord, text: string, mode?: "steer" | "followUp", images?: InlineImageContent[]): Promise<QueueMessageResult> =>
      withSession((session) => session.queueMessageForThreadIfActive(thread, text, mode, images)),
    enqueueReload: (thread: ThreadRecord, onProgress?: PromptProgressHandler): Promise<void> =>
      withSession((session) => session.enqueueReload(thread, onProgress)),
    enqueueCompact: (thread: ThreadRecord, customInstructions?: string, onProgress?: PromptProgressHandler): Promise<CompactResult> =>
      withSession((session) => session.enqueueCompact(thread, customInstructions, onProgress)),
    isActive,
    abort: (threadId: string): Promise<void> => withSession((session) => session.abort(threadId)),
    disposeAll: disposeRuntime,
  };
}

function unwrapPiSessionCause(cause: Cause.Cause<unknown>): unknown {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (isPiSessionWrappedError(failure)) {
    return failure.cause instanceof Error ? failure.cause : failure;
  }
  return Cause.squash(cause);
}

function isPiSessionWrappedError(error: unknown): error is { readonly _tag: string; readonly cause: unknown } {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  const tag = (error as { _tag?: unknown })._tag;
  return tag === "PiSessionAlreadyProcessing"
    || tag === "PiSessionAssistantLeafContinueFailed"
    || tag === "PiSessionOperationFailed";
}

export interface RunQueueRuntimeClient extends RunControlStorePort {
  readonly engine: typeof RUN_QUEUE_ENGINE_NAME;
  warmup(): Promise<void>;
}

export function createRunQueueRuntimeClient(config: AppConfig): RunQueueRuntimeClient {
  const runtime = ManagedRuntime.make(RunQueueEngineLive(config));

  const withQueue = <A, E>(
    operation: (queue: RunQueueServiceShape) => Effect.Effect<A, E>,
  ): Promise<A> => runtime.runPromise(
    Effect.gen(function* () {
      const queue = yield* RunQueueService;
      return yield* operation(queue);
    }),
  );

  return {
    engine: RUN_QUEUE_ENGINE_NAME,
    warmup: () => withQueue(() => Effect.succeed(undefined)),
    close: () => runtime.dispose(),
    ensureConsumerGroup: () => withQueue((queue) => queue.ensureConsumerGroup()),
    tryEnqueueRun: (run: RunRecord) => withQueue((queue) => queue.tryEnqueueRun(run)),
    appendInput: (input: QueuedRunInput) => withQueue((queue) => queue.appendInput(input)),
    getInputStreamLength: (logicalThreadId: string) => withQueue((queue) => queue.getInputStreamLength(logicalThreadId)),
    countInputsForRun: (logicalThreadId: string, runId: string) => withQueue((queue) => queue.countInputsForRun(logicalThreadId, runId)),
    readInputsSince: (logicalThreadId: string, lastId: string, count?: number) =>
      withQueue((queue) => queue.readInputsSince(logicalThreadId, lastId, count)),
    dequeueJob: (workerId: string, blockMs: number) => withQueue((queue) => queue.dequeueJob(workerId, blockMs)),
    claimStaleJob: (workerId: string) => withQueue((queue) => queue.claimStaleJob(workerId)),
    acknowledgeJob: (job: RunJob) => withQueue((queue) => queue.acknowledgeJob(job)),
    getRun: (runId: string) => withQueue((queue) => queue.getRun(runId)),
    patchRun: (runId: string, patch: Partial<RunRecord>, options?: { preserveTerminal?: boolean }) =>
      withQueue((queue) => queue.patchRun(runId, patch, options)),
    markTerminal: (
      runId: string,
      status: "succeeded" | "failed" | "interrupted" | "aborted",
      patch?: Partial<RunRecord>,
    ) => withQueue((queue) => queue.markTerminal(runId, status, patch)),
    getActiveRunId: (logicalThreadId: string) => withQueue((queue) => queue.getActiveRunId(logicalThreadId)),
    getQueueableActiveRunId: (logicalThreadId: string) => withQueue((queue) => queue.getQueueableActiveRunId(logicalThreadId)),
    clearActiveIfMatches: (logicalThreadId: string, runId: string) => withQueue((queue) => queue.clearActiveIfMatches(logicalThreadId, runId)),
    claimRunLease: (run: RunRecord, workerId: string, leaseToken: string) => withQueue((queue) => queue.claimRunLease(run, workerId, leaseToken)),
    heartbeatRunLease: (runId: string, logicalThreadId: string, leaseToken: string, workerId: string) =>
      withQueue((queue) => queue.heartbeatRunLease(runId, logicalThreadId, leaseToken, workerId)),
    verifyRunOwnership: (runId: string, logicalThreadId: string, leaseToken: string) =>
      withQueue((queue) => queue.verifyRunOwnership(runId, logicalThreadId, leaseToken)),
    releaseRunLease: (runId: string, leaseToken: string) => withQueue((queue) => queue.releaseRunLease(runId, leaseToken)),
    recordRetryLater: (run: RunRecord, leaseToken: string, workerId: string, reason: string, maxAttempts: number) =>
      withQueue((queue) => queue.recordRetryLater(run, leaseToken, workerId, reason, maxAttempts)),
    acquireFinalize: (runId: string, leaseToken: string) => withQueue((queue) => queue.acquireFinalize(runId, leaseToken)),
    completeFinalize: (runId: string, leaseToken: string) => withQueue((queue) => queue.completeFinalize(runId, leaseToken)),
    getRunLeaseTtl: (runId: string) => withQueue((queue) => queue.getRunLeaseTtl(runId)),
    appendRunEvent: (runId: string, type: string, fields?: Record<string, unknown>) =>
      withQueue((queue) => queue.appendRunEvent(runId, type, fields)),
    recordWorkerIdle: (workerId: string) => withQueue((queue) => queue.recordWorkerIdle(workerId)),
    getJobQueueSummary: () => withQueue((queue) => queue.getJobQueueSummary()),
    getPendingJobDetails: (limit?: number) => withQueue((queue) => queue.getPendingJobDetails(limit)).then((details) => [...details]),
    getRunEventSummary: (options?: { sampleLimit?: number }) => withQueue((queue) => queue.getRunEventSummary(options)),
    listWorkers: () => withQueue((queue) => queue.listWorkers()).then((workers) => [...workers]),
    listRuns: (): Promise<RunRecord[]> => withQueue((queue) => queue.listRuns()).then((runs) => [...runs]),
    listActivePointers: (): Promise<ActivePointer[]> => withQueue((queue) => queue.listActivePointers()).then((pointers) => [...pointers]),
  };
}
