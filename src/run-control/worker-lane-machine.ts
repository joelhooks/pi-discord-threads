import { assign, fromPromise, setup } from "xstate";
import { formatUnknownError } from "../error-format.js";
import type { RunControlStorePort, RunJob, RunRecord } from "./types.js";
import { runRunControlWorkerJob } from "./worker-machine.js";

export interface RunControlWorkerLaneMachineInput {
  store: RunControlStorePort;
  workerId: string;
  blockMs: number;
  initialEnsureRetryDelayMs?: number;
  maxEnsureRetryDelayMs?: number;
  createLeaseToken: () => string;
  executeWithLease(run: RunRecord, leaseToken: string, workerId: string): Promise<void>;
  shouldLeavePending(error: unknown): boolean;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunControlWorkerLaneMachineContext extends RunControlWorkerLaneMachineInput {
  retryDelayMs: number;
  maxRetryDelayMs: number;
  stopRequested: boolean;
  job?: RunJob;
  lastError?: unknown;
}

export type RunControlWorkerLaneMachineEvent = { type: "STOP" };

type DoneEvent<T> = { output: T };
type ErrorEvent = { error: unknown };

function outputFrom<T>(event: unknown): T {
  return (event as DoneEvent<T>).output;
}

function errorFrom(event: unknown): unknown {
  return (event as ErrorEvent).error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref();
  });
}

export const runControlWorkerLaneMachine = setup({
  types: {} as {
    input: RunControlWorkerLaneMachineInput;
    context: RunControlWorkerLaneMachineContext;
    events: RunControlWorkerLaneMachineEvent;
  },
  actors: {
    ensureConsumerGroup: fromPromise<void, RunControlWorkerLaneMachineContext>(async ({ input }) => {
      await input.store.ensureConsumerGroup();
    }),
    retryConsumerGroupDelay: fromPromise<void, RunControlWorkerLaneMachineContext>(async ({ input }) => {
      await sleep(input.retryDelayMs);
    }),
    dequeueJob: fromPromise<RunJob | undefined, RunControlWorkerLaneMachineContext>(async ({ input }) => {
      return input.store.dequeueJob(input.workerId, input.blockMs);
    }),
    recordWorkerIdle: fromPromise<void, RunControlWorkerLaneMachineContext>(async ({ input }) => {
      await input.store.recordWorkerIdle(input.workerId).catch(() => undefined);
    }),
    handleJob: fromPromise<void, RunControlWorkerLaneMachineContext>(async ({ input }) => {
      if (!input.job) return;
      await runRunControlWorkerJob({
        store: input.store,
        job: input.job,
        workerId: input.workerId,
        createLeaseToken: input.createLeaseToken,
        executeWithLease: input.executeWithLease,
        shouldLeavePending: input.shouldLeavePending,
      });
    }),
  },
  actions: {
    requestStop: assign({
      stopRequested: () => true,
    }),
    resetRetryDelay: assign({
      retryDelayMs: ({ context }) => context.initialEnsureRetryDelayMs ?? 500,
    }),
    increaseRetryDelay: assign({
      retryDelayMs: ({ context }) => Math.min(context.maxRetryDelayMs, context.retryDelayMs * 2),
    }),
    rememberJob: assign({
      job: ({ event }) => outputFrom<RunJob | undefined>(event),
    }),
    clearJob: assign({
      job: () => undefined,
    }),
    rememberError: assign({
      lastError: ({ event }) => errorFrom(event),
    }),
    announceListening: ({ context }) => {
      context.log(`run-control worker ${context.workerId} listening for Redis jobs`);
    },
    warnEnsureConsumerGroupFailure: ({ context, event }) => {
      context.warn(`run-control ensure consumer group failed; retrying in ${context.retryDelayMs}ms: ${formatUnknownError(errorFrom(event))}`);
    },
    warnDequeueFailure: ({ context, event }) => {
      context.warn(`run-control dequeue failed for ${context.workerId}: ${formatUnknownError(errorFrom(event))}`);
    },
    reportOutsideHandlerFailure: ({ context, event }) => {
      const runId = context.job?.runId ?? "unknown";
      context.error(`run-control job ${runId} failed outside handler on ${context.workerId}: ${formatUnknownError(errorFrom(event))}`);
    },
  },
  guards: {
    stopRequested: ({ context }) => context.stopRequested,
    hasJob: ({ context }) => Boolean(context.job),
  },
}).createMachine({
  id: "runControlWorkerLane",
  initial: "ensuringConsumerGroup",
  context: ({ input }) => ({
    ...input,
    retryDelayMs: input.initialEnsureRetryDelayMs ?? 500,
    maxRetryDelayMs: input.maxEnsureRetryDelayMs ?? 30_000,
    stopRequested: false,
  }),
  states: {
    ensuringConsumerGroup: {
      on: {
        STOP: { actions: "requestStop" },
      },
      invoke: {
        src: "ensureConsumerGroup",
        input: ({ context }) => context,
        onDone: "routingEnsuredConsumerGroup",
        onError: {
          target: "routingEnsureFailure",
          actions: ["rememberError", "warnEnsureConsumerGroupFailure"],
        },
      },
    },
    routingEnsuredConsumerGroup: {
      always: [
        { guard: "stopRequested", target: "done" },
        { target: "dequeuing", actions: ["resetRetryDelay", "announceListening"] },
      ],
    },
    routingEnsureFailure: {
      always: [
        { guard: "stopRequested", target: "done" },
        { target: "retryingConsumerGroup" },
      ],
    },
    retryingConsumerGroup: {
      on: {
        STOP: { target: "done", actions: "requestStop" },
      },
      invoke: {
        src: "retryConsumerGroupDelay",
        input: ({ context }) => context,
        onDone: {
          target: "ensuringConsumerGroup",
          actions: "increaseRetryDelay",
        },
        onError: "done",
      },
    },
    dequeuing: {
      on: {
        STOP: { actions: "requestStop" },
      },
      invoke: {
        src: "dequeueJob",
        input: ({ context }) => context,
        onDone: {
          target: "routingDequeuedJob",
          actions: "rememberJob",
        },
        onError: {
          target: "retryingConsumerGroup",
          actions: ["rememberError", "clearJob", "warnDequeueFailure"],
        },
      },
    },
    routingDequeuedJob: {
      always: [
        { guard: "hasJob", target: "handlingJob" },
        { target: "recordingIdle" },
      ],
    },
    recordingIdle: {
      on: {
        STOP: { actions: "requestStop" },
      },
      invoke: {
        src: "recordWorkerIdle",
        input: ({ context }) => context,
        onDone: "routingAfterCycle",
        onError: "routingAfterCycle",
      },
    },
    handlingJob: {
      on: {
        STOP: { actions: "requestStop" },
      },
      invoke: {
        src: "handleJob",
        input: ({ context }) => context,
        onDone: {
          target: "routingAfterCycle",
          actions: "clearJob",
        },
        onError: {
          target: "routingAfterCycle",
          actions: ["rememberError", "reportOutsideHandlerFailure", "clearJob"],
        },
      },
    },
    routingAfterCycle: {
      always: [
        { guard: "stopRequested", target: "done" },
        { target: "dequeuing" },
      ],
    },
    done: {
      type: "final",
    },
  },
});
