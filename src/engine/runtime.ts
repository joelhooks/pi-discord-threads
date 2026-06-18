import type { AppConfig } from "../config.js";
import type {
  ActivePointer,
  QueuedRunInput,
  RunControlStorePort,
  RunJob,
  RunRecord,
} from "../run-control/types.js";
import { Effect, ManagedRuntime } from "effect";
import { RunQueueEngineLive } from "./layers.js";
import { RunQueueService, type RunQueueServiceShape } from "./services.js";

export const RUN_QUEUE_ENGINE_NAME = "effect-managed";

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
    heartbeatRunLease: (runId: string, leaseToken: string, workerId: string) =>
      withQueue((queue) => queue.heartbeatRunLease(runId, leaseToken, workerId)),
    releaseRunLease: (runId: string, leaseToken: string) => withQueue((queue) => queue.releaseRunLease(runId, leaseToken)),
    acquireFinalize: (runId: string, leaseToken: string) => withQueue((queue) => queue.acquireFinalize(runId, leaseToken)),
    completeFinalize: (runId: string, leaseToken: string) => withQueue((queue) => queue.completeFinalize(runId, leaseToken)),
    getRunLeaseTtl: (runId: string) => withQueue((queue) => queue.getRunLeaseTtl(runId)),
    appendRunEvent: (runId: string, type: string, fields?: Record<string, unknown>) =>
      withQueue((queue) => queue.appendRunEvent(runId, type, fields)),
    recordWorkerIdle: (workerId: string) => withQueue((queue) => queue.recordWorkerIdle(workerId)),
    listRuns: (): Promise<RunRecord[]> => withQueue((queue) => queue.listRuns()).then((runs) => [...runs]),
    listActivePointers: (): Promise<ActivePointer[]> => withQueue((queue) => queue.listActivePointers()).then((pointers) => [...pointers]),
  };
}
