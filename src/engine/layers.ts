import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { PiRuntimePort } from "../pi-runtime.js";
import { Registry } from "../registry.js";
import { createRunControlRedisClient, RedisCommandTimeoutError } from "../run-control/redis-client.js";
import { RunControlStore } from "../run-control/store.js";
import { isAssistantLeafContinueError } from "../thread-run-state.js";
import type {
  ActivePointer,
  FinalizeClaim,
  QueuedRunInput,
  RunJob,
  RunRecord,
  RetryLaterRecordResult,
} from "../run-control/types.js";
import { Effect, Layer, Option, Scope } from "effect";
import {
  RegistryLinkIngestNotFound,
  RegistryLoadFailed,
  RegistryThreadNotFound,
  PiSessionAlreadyProcessing,
  PiSessionAssistantLeafContinueFailed,
  PiSessionOperationFailed,
  RegistryWriteFailed,
  RunQueueConnectFailed,
  RunQueueOperationFailed,
  RunQueueTimeout,
  type DiscordMessageId,
  type MentionId,
  type PiSessionError,
  type RunQueueError,
  type ThreadId,
} from "./domain.js";
import {
  AppConfigService,
  PiSessionService,
  RegistryService,
  RunQueueService,
  type PiSessionServiceShape,
  type RegistryServiceShape,
  type RunQueueServiceShape,
} from "./services.js";

export const AppConfigLive = (config: AppConfig): Layer.Layer<AppConfigService> =>
  Layer.succeed(AppConfigService, config);

export function makePiSessionService(manager: PiRuntimePort): PiSessionServiceShape {
  const call = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, PiSessionError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => mapPiSessionOperationError(operation, cause),
    });

  return {
    enqueuePrompt: Effect.fn("PiSessionService.enqueuePrompt")((thread, text, images, onProgress, options) =>
      call("enqueuePrompt", () => manager.enqueuePrompt(thread, text, images, onProgress, options)),
    ),
    queueMessageDuringActive: Effect.fn("PiSessionService.queueMessageDuringActive")((threadId, text, mode, images) =>
      call("queueMessageDuringActive", () => manager.queueMessageDuringActive(threadId, text, mode, images)),
    ),
    queueMessageForThreadIfActive: Effect.fn("PiSessionService.queueMessageForThreadIfActive")((thread, text, mode, images) =>
      call("queueMessageForThreadIfActive", () => manager.queueMessageForThreadIfActive(thread, text, mode, images)),
    ),
    enqueueReload: Effect.fn("PiSessionService.enqueueReload")((thread, onProgress) =>
      call("enqueueReload", () => manager.enqueueReload(thread, onProgress)),
    ),
    enqueueCompact: Effect.fn("PiSessionService.enqueueCompact")((thread, customInstructions, onProgress) =>
      call("enqueueCompact", () => manager.enqueueCompact(thread, customInstructions, onProgress)),
    ),
    isActive: (threadId) => manager.isActive(threadId),
    abort: Effect.fn("PiSessionService.abort")((threadId) =>
      call("abort", () => manager.abort(threadId)),
    ),
    disposeAll: Effect.fn("PiSessionService.disposeAll")(() =>
      call("disposeAll", () => manager.disposeAll()),
    ),
  };
}

export const PiSessionManagerLive = (manager: PiRuntimePort): Layer.Layer<PiSessionService> =>
  Layer.succeed(PiSessionService, makePiSessionService(manager));

export function makeRegistryService(registry: Registry): RegistryServiceShape {
  const write = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RegistryWriteFailed> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new RegistryWriteFailed({ operation, cause }),
    });

  return {
    save: Effect.fn("RegistryService.save")(() =>
      write("save", () => registry.save()),
    ),

    getThread: Effect.fn("RegistryService.getThread")((threadId: ThreadId) =>
      Effect.sync(() => Option.fromNullishOr(registry.getThread(threadId))),
    ),

    listThreads: Effect.fn("RegistryService.listThreads")(() =>
      Effect.sync(() => registry.listThreads()),
    ),

    upsertThread: Effect.fn("RegistryService.upsertThread")((input) =>
      write("upsertThread", () => registry.upsertThread(input)),
    ),

    patchThread: Effect.fn("RegistryService.patchThread")(function* (threadId, patch) {
      if (!registry.getThread(threadId)) {
        return yield* new RegistryThreadNotFound({ threadId });
      }
      return yield* write("patchThread", () => registry.patchThread(threadId, patch));
    }),

    markRunningThreadsInterrupted: Effect.fn("RegistryService.markRunningThreadsInterrupted")(() =>
      write("markRunningThreadsInterrupted", () => registry.markRunningThreadsInterrupted()),
    ),

    recordMessage: Effect.fn("RegistryService.recordMessage")((record) =>
      write("recordMessage", () => registry.recordMessage(record)),
    ),

    recordMessageEntry: Effect.fn("RegistryService.recordMessageEntry")((discordMessageId: DiscordMessageId, entryId) =>
      write("recordMessageEntry", () => registry.recordMessageEntry(discordMessageId, entryId)),
    ),

    getMessage: Effect.fn("RegistryService.getMessage")((discordMessageId: DiscordMessageId) =>
      Effect.sync(() => Option.fromNullishOr(registry.getMessage(discordMessageId))),
    ),

    upsertLinkIngest: Effect.fn("RegistryService.upsertLinkIngest")((record) =>
      write("upsertLinkIngest", () => registry.upsertLinkIngest(record)),
    ),

    getLinkIngest: Effect.fn("RegistryService.getLinkIngest")((mentionId: MentionId) =>
      Effect.sync(() => Option.fromNullishOr(registry.getLinkIngest(mentionId))),
    ),

    listLinkIngests: Effect.fn("RegistryService.listLinkIngests")(() =>
      Effect.sync(() => registry.listLinkIngests()),
    ),

    getLinkIngestStatusUpdate: Effect.fn("RegistryService.getLinkIngestStatusUpdate")((mentionId: MentionId, statusKey) =>
      Effect.sync(() => Option.fromNullishOr(registry.getLinkIngestStatusUpdate(mentionId, statusKey))),
    ),

    recordLinkIngestStatusUpdate: Effect.fn("RegistryService.recordLinkIngestStatusUpdate")(function* (update) {
      if (!registry.getLinkIngest(update.mentionId)) {
        return yield* new RegistryLinkIngestNotFound({ mentionId: update.mentionId as MentionId });
      }
      return yield* write("recordLinkIngestStatusUpdate", () => registry.recordLinkIngestStatusUpdate(update));
    }),
  };
}

export const JsonRegistryFromInstanceLive = (registry: Registry): Layer.Layer<RegistryService, RegistryLoadFailed> => Layer.effect(
  RegistryService,
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => registry.load(),
      catch: (cause) => new RegistryLoadFailed({ cause }),
    });

    const saveOnClose = Effect.ignore(Effect.tryPromise({
      try: () => registry.save(),
      catch: (cause) => new RegistryWriteFailed({ operation: "saveOnClose", cause }),
    }));

    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, saveOnClose);

    return makeRegistryService(registry);
  }),
);

export const JsonRegistryLive: Layer.Layer<RegistryService, RegistryLoadFailed, AppConfigService> = Layer.effect(
  RegistryService,
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const registry = new Registry(join(config.dataDir, "registry.json"));

    yield* Effect.tryPromise({
      try: () => registry.load(),
      catch: (cause) => new RegistryLoadFailed({ cause }),
    });

    const saveOnClose = Effect.ignore(Effect.tryPromise({
      try: () => registry.save(),
      catch: (cause) => new RegistryWriteFailed({ operation: "saveOnClose", cause }),
    }));

    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, saveOnClose);

    return makeRegistryService(registry);
  }),
);

export type RunQueueStoreLike = {
  readonly ensureConsumerGroup: () => Promise<void>;
  readonly tryEnqueueRun: (run: RunRecord) => Promise<{ enqueued: true; run: RunRecord } | { enqueued: false; activeRunId: string }>;
  readonly appendInput: (input: QueuedRunInput) => Promise<string>;
  readonly getInputStreamLength: (logicalThreadId: string) => Promise<number>;
  readonly countInputsForRun: (logicalThreadId: string, runId: string) => Promise<number>;
  readonly readInputsSince: (logicalThreadId: string, lastId: string, count?: number) => Promise<QueuedRunInput[]>;
  readonly dequeueJob: (workerId: string, blockMs: number) => Promise<RunJob | undefined>;
  readonly claimStaleJob: (workerId: string) => Promise<RunJob | undefined>;
  readonly acknowledgeJob: (job: RunJob) => Promise<void>;
  readonly getRun: (runId: string) => Promise<RunRecord | undefined>;
  readonly patchRun: (
    runId: string,
    patch: Partial<RunRecord>,
    options?: { preserveTerminal?: boolean },
  ) => Promise<RunRecord | undefined>;
  readonly markTerminal: (
    runId: string,
    status: "succeeded" | "failed" | "interrupted" | "aborted",
    patch?: Partial<RunRecord>,
  ) => Promise<RunRecord | undefined>;
  readonly getActiveRunId: (logicalThreadId: string) => Promise<string | undefined>;
  readonly getQueueableActiveRunId: (logicalThreadId: string) => Promise<string | undefined>;
  readonly clearActiveIfMatches: (logicalThreadId: string, runId: string) => Promise<boolean>;
  readonly claimRunLease: (run: RunRecord, workerId: string, leaseToken: string) => Promise<boolean>;
  readonly heartbeatRunLease: (runId: string, logicalThreadId: string, leaseToken: string, workerId: string) => Promise<boolean>;
  readonly verifyRunOwnership: (runId: string, logicalThreadId: string, leaseToken: string) => Promise<boolean>;
  readonly releaseRunLease: (runId: string, leaseToken: string) => Promise<boolean>;
  readonly recordRetryLater: (
    run: RunRecord,
    leaseToken: string,
    workerId: string,
    reason: string,
    maxAttempts: number,
  ) => Promise<RetryLaterRecordResult>;
  readonly acquireFinalize: (runId: string, leaseToken: string) => Promise<FinalizeClaim>;
  readonly completeFinalize: (runId: string, leaseToken: string) => Promise<boolean>;
  readonly getRunLeaseTtl: (runId: string) => Promise<number>;
  readonly appendRunEvent: (runId: string, type: string, fields?: Record<string, unknown>) => Promise<string>;
  readonly recordWorkerIdle: (workerId: string) => Promise<void>;
  readonly listRuns: () => Promise<RunRecord[]>;
  readonly listActivePointers: () => Promise<ActivePointer[]>;
};

export function makeRunQueueService(store: RunQueueStoreLike, timeoutMs: number): RunQueueServiceShape {
  const call = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RunQueueError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => mapRunQueueOperationError(operation, timeoutMs, cause),
    });

  return {
    ensureConsumerGroup: Effect.fn("RunQueueService.ensureConsumerGroup")(() =>
      call("ensureConsumerGroup", () => store.ensureConsumerGroup()),
    ),
    tryEnqueueRun: Effect.fn("RunQueueService.tryEnqueueRun")((run) =>
      call("tryEnqueueRun", () => store.tryEnqueueRun(run)),
    ),
    appendInput: Effect.fn("RunQueueService.appendInput")((input) =>
      call("appendInput", () => store.appendInput(input)),
    ),
    getInputStreamLength: Effect.fn("RunQueueService.getInputStreamLength")((logicalThreadId) =>
      call("getInputStreamLength", () => store.getInputStreamLength(logicalThreadId)),
    ),
    countInputsForRun: Effect.fn("RunQueueService.countInputsForRun")((logicalThreadId, runId) =>
      call("countInputsForRun", () => store.countInputsForRun(logicalThreadId, runId)),
    ),
    readInputsSince: Effect.fn("RunQueueService.readInputsSince")((logicalThreadId, lastId, count) =>
      call("readInputsSince", () => store.readInputsSince(logicalThreadId, lastId, count)),
    ),
    dequeueJob: Effect.fn("RunQueueService.dequeueJob")((workerId, blockMs) =>
      call("dequeueJob", () => store.dequeueJob(workerId, blockMs)),
    ),
    claimStaleJob: Effect.fn("RunQueueService.claimStaleJob")((workerId) =>
      call("claimStaleJob", () => store.claimStaleJob(workerId)),
    ),
    acknowledgeJob: Effect.fn("RunQueueService.acknowledgeJob")((job) =>
      call("acknowledgeJob", () => store.acknowledgeJob(job)),
    ),
    getRun: Effect.fn("RunQueueService.getRun")((runId) =>
      call("getRun", () => store.getRun(runId)),
    ),
    patchRun: Effect.fn("RunQueueService.patchRun")((runId, patch, options) =>
      call("patchRun", () => store.patchRun(runId, patch, options)),
    ),
    markTerminal: Effect.fn("RunQueueService.markTerminal")((runId, status, patch) =>
      call("markTerminal", () => store.markTerminal(runId, status, patch)),
    ),
    getActiveRunId: Effect.fn("RunQueueService.getActiveRunId")((logicalThreadId) =>
      call("getActiveRunId", () => store.getActiveRunId(logicalThreadId)),
    ),
    getQueueableActiveRunId: Effect.fn("RunQueueService.getQueueableActiveRunId")((logicalThreadId) =>
      call("getQueueableActiveRunId", () => store.getQueueableActiveRunId(logicalThreadId)),
    ),
    clearActiveIfMatches: Effect.fn("RunQueueService.clearActiveIfMatches")((logicalThreadId, runId) =>
      call("clearActiveIfMatches", () => store.clearActiveIfMatches(logicalThreadId, runId)),
    ),
    claimRunLease: Effect.fn("RunQueueService.claimRunLease")((run, workerId, leaseToken) =>
      call("claimRunLease", () => store.claimRunLease(run, workerId, leaseToken)),
    ),
    heartbeatRunLease: Effect.fn("RunQueueService.heartbeatRunLease")((runId, logicalThreadId, leaseToken, workerId) =>
      call("heartbeatRunLease", () => store.heartbeatRunLease(runId, logicalThreadId, leaseToken, workerId)),
    ),
    verifyRunOwnership: Effect.fn("RunQueueService.verifyRunOwnership")((runId, logicalThreadId, leaseToken) =>
      call("verifyRunOwnership", () => store.verifyRunOwnership(runId, logicalThreadId, leaseToken)),
    ),
    releaseRunLease: Effect.fn("RunQueueService.releaseRunLease")((runId, leaseToken) =>
      call("releaseRunLease", () => store.releaseRunLease(runId, leaseToken)),
    ),
    recordRetryLater: Effect.fn("RunQueueService.recordRetryLater")((run, leaseToken, workerId, reason, maxAttempts) =>
      call("recordRetryLater", () => store.recordRetryLater(run, leaseToken, workerId, reason, maxAttempts)),
    ),
    acquireFinalize: Effect.fn("RunQueueService.acquireFinalize")((runId, leaseToken) =>
      call("acquireFinalize", () => store.acquireFinalize(runId, leaseToken)),
    ),
    completeFinalize: Effect.fn("RunQueueService.completeFinalize")((runId, leaseToken) =>
      call("completeFinalize", () => store.completeFinalize(runId, leaseToken)),
    ),
    getRunLeaseTtl: Effect.fn("RunQueueService.getRunLeaseTtl")((runId) =>
      call("getRunLeaseTtl", () => store.getRunLeaseTtl(runId)),
    ),
    appendRunEvent: Effect.fn("RunQueueService.appendRunEvent")((runId, type, fields) =>
      call("appendRunEvent", () => store.appendRunEvent(runId, type, fields)),
    ),
    recordWorkerIdle: Effect.fn("RunQueueService.recordWorkerIdle")((workerId) =>
      call("recordWorkerIdle", () => store.recordWorkerIdle(workerId)),
    ),
    listRuns: Effect.fn("RunQueueService.listRuns")(() =>
      call("listRuns", () => store.listRuns()),
    ),
    listActivePointers: Effect.fn("RunQueueService.listActivePointers")(() =>
      call("listActivePointers", () => store.listActivePointers()),
    ),
  };
}

export const RedisRunQueueLive: Layer.Layer<RunQueueService, RunQueueError, AppConfigService> = Layer.effect(
  RunQueueService,
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const timeoutMs = config.runControl.commandTimeoutMs;
    const client = yield* Effect.tryPromise({
      try: () => createRunControlRedisClient(config),
      catch: (cause) => mapRunQueueConnectError(timeoutMs, cause),
    });
    const store = new RunControlStore(client, config);

    const closeOnScopeClose = Effect.ignore(Effect.tryPromise({
      try: () => store.close(),
      catch: (cause) => mapRunQueueOperationError("close", timeoutMs, cause),
    }));

    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, closeOnScopeClose);

    return makeRunQueueService(store, timeoutMs);
  }),
);

export const RegistryEngineLive = (config: AppConfig): Layer.Layer<RegistryService, RegistryLoadFailed> =>
  JsonRegistryLive.pipe(Layer.provide(AppConfigLive(config)));

export const RunQueueEngineLive = (config: AppConfig): Layer.Layer<RunQueueService, RunQueueError> =>
  RedisRunQueueLive.pipe(Layer.provide(AppConfigLive(config)));

function mapPiSessionOperationError(operation: string, cause: unknown): PiSessionError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("Agent is already processing")) {
    return new PiSessionAlreadyProcessing({ operation, cause });
  }
  if (isAssistantLeafContinueError(cause)) {
    return new PiSessionAssistantLeafContinueFailed({ operation, cause });
  }
  return new PiSessionOperationFailed({ operation, cause });
}

function mapRunQueueConnectError(timeoutMs: number, cause: unknown): RunQueueConnectFailed | RunQueueTimeout {
  if (cause instanceof RedisCommandTimeoutError) {
    return new RunQueueTimeout({ operation: "connect", timeoutMs, cause });
  }
  return new RunQueueConnectFailed({ cause });
}

function mapRunQueueOperationError(operation: string, timeoutMs: number, cause: unknown): RunQueueOperationFailed | RunQueueTimeout {
  if (cause instanceof RedisCommandTimeoutError) {
    return new RunQueueTimeout({ operation, timeoutMs, cause });
  }
  return new RunQueueOperationFailed({ operation, cause });
}
