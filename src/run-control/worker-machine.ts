import { createActor, waitFor, assign, fromPromise, setup } from "xstate";
import { formatUnknownError } from "../error-format.js";
import { RetryRunLaterError } from "./errors.js";
import type { RunControlStorePort, RunJob, RunRecord } from "./types.js";
import { isTerminalRunStatus } from "./types.js";

export type RunControlWorkerJobOutcome =
  | { kind: "acked"; reason: "missing-run" | "terminal-run" | "stale-job" | "completed" | "dead-lettered" }
  | { kind: "pending"; reason: "lease-busy" | "retry-later" }
  | { kind: "failed"; reason: "handler-error"; error: Error };

export interface RunControlWorkerJobMachineInput {
  store: RunControlStorePort;
  job: RunJob;
  workerId: string;
  createLeaseToken: () => string;
  executeWithLease(run: RunRecord, leaseToken: string, workerId: string): Promise<void>;
  shouldLeavePending(error: unknown): boolean;
  maxRetryLaterAttempts: number;
}

export interface RunControlWorkerJobMachineContext extends RunControlWorkerJobMachineInput {
  run?: RunRecord;
  activeRunId?: string;
  leaseToken?: string;
  lastError?: unknown;
  outcome?: RunControlWorkerJobOutcome;
}

type DoneEvent<T> = { output: T };
type ErrorEvent = { error: unknown };

interface LeaseClaimResult {
  claimed: boolean;
  leaseToken: string;
}

interface RetryLaterDecision {
  attempts: number;
  deadLettered: boolean;
}

function outputFrom<T>(event: unknown): T {
  return (event as DoneEvent<T>).output;
}

function errorFrom(event: unknown): unknown {
  return (event as ErrorEvent).error;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error && error.message.trim()) return error;
  return new Error(formatUnknownError(error));
}

function requireRun(context: RunControlWorkerJobMachineContext): RunRecord {
  if (!context.run) throw new Error(`run-control job ${context.job.runId} has no loaded run`);
  return context.run;
}

function requireLeaseToken(context: RunControlWorkerJobMachineContext): string {
  if (!context.leaseToken) throw new Error(`run-control job ${context.job.runId} has no lease token`);
  return context.leaseToken;
}

async function releaseLease(context: RunControlWorkerJobMachineContext): Promise<void> {
  const run = requireRun(context);
  const leaseToken = requireLeaseToken(context);
  await context.store.releaseRunLease(run.runId, leaseToken).catch(() => undefined);
}

async function recordRetryLaterAndRelease(context: RunControlWorkerJobMachineContext): Promise<RetryLaterDecision> {
  const run = requireRun(context);
  const leaseToken = requireLeaseToken(context);
  const error = normalizeError(context.lastError);
  const reason = error.message || formatUnknownError(error);
  const decision = await context.store.recordRetryLater(
    run,
    leaseToken,
    context.workerId,
    reason,
    context.maxRetryLaterAttempts,
  );
  if (decision.deadLettered) await context.store.acknowledgeJob(context.job);
  return decision;
}

export const runControlWorkerJobMachine = setup({
  types: {} as {
    input: RunControlWorkerJobMachineInput;
    context: RunControlWorkerJobMachineContext;
  },
  actors: {
    loadRun: fromPromise<RunRecord | undefined, RunControlWorkerJobMachineContext>(async ({ input }) => {
      return input.store.getRun(input.job.runId);
    }),
    acknowledgeJob: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      await input.store.acknowledgeJob(input.job);
    }),
    loadActiveRunId: fromPromise<string | undefined, RunControlWorkerJobMachineContext>(async ({ input }) => {
      const run = requireRun(input);
      return input.store.getActiveRunId(run.logicalThreadId);
    }),
    recordStaleJobAndAck: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      const run = requireRun(input);
      await input.store.appendRunEvent(run.runId, "stale_job_skipped", {
        logicalThreadId: run.logicalThreadId,
        activeRunId: input.activeRunId ?? "",
        workerId: input.workerId,
      }).catch(() => undefined);
      await input.store.acknowledgeJob(input.job);
    }),
    claimLease: fromPromise<LeaseClaimResult, RunControlWorkerJobMachineContext>(async ({ input }) => {
      const run = requireRun(input);
      const leaseToken = input.createLeaseToken();
      const claimed = await input.store.claimRunLease(run, input.workerId, leaseToken);
      return { claimed, leaseToken };
    }),
    recordBusyLease: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      const run = requireRun(input);
      await input.store.appendRunEvent(run.runId, "lease_claim_busy", {
        logicalThreadId: run.logicalThreadId,
        workerId: input.workerId,
      }).catch(() => undefined);
    }),
    executeWithLease: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      await input.executeWithLease(requireRun(input), requireLeaseToken(input), input.workerId);
    }),
    releaseLeaseAndAck: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      const run = requireRun(input);
      const released = await input.store.releaseRunLease(run.runId, requireLeaseToken(input)).catch(() => false);
      if (!released) {
        const latest = await input.store.getRun(run.runId).catch(() => undefined);
        if (!isTerminalRunStatus(latest?.status)) {
          throw new RetryRunLaterError(`run-control lease lost before ACK for ${run.runId}; leaving job pending`);
        }
      }
      await input.store.acknowledgeJob(input.job);
    }),
    recordRetryLaterAndRelease: fromPromise<RetryLaterDecision, RunControlWorkerJobMachineContext>(async ({ input }) => {
      return recordRetryLaterAndRelease(input);
    }),
    releaseLeasePending: fromPromise<void, RunControlWorkerJobMachineContext>(async ({ input }) => {
      await releaseLease(input);
    }),
  },
  actions: {
    rememberRun: assign({
      run: ({ event }) => outputFrom<RunRecord | undefined>(event),
    }),
    rememberActiveRunId: assign({
      activeRunId: ({ event }) => outputFrom<string | undefined>(event),
    }),
    rememberLeaseClaim: assign({
      leaseToken: ({ event }) => outputFrom<LeaseClaimResult>(event).leaseToken,
    }),
    rememberError: assign({
      lastError: ({ event }) => errorFrom(event),
    }),
    ackedMissingRun: assign({
      outcome: () => ({ kind: "acked", reason: "missing-run" } as const),
    }),
    ackedTerminalRun: assign({
      outcome: () => ({ kind: "acked", reason: "terminal-run" } as const),
    }),
    ackedStaleJob: assign({
      outcome: () => ({ kind: "acked", reason: "stale-job" } as const),
    }),
    pendingBusyLease: assign({
      outcome: () => ({ kind: "pending", reason: "lease-busy" } as const),
    }),
    ackedCompletedRun: assign({
      outcome: () => ({ kind: "acked", reason: "completed" } as const),
    }),
    ackedDeadLetteredRun: assign({
      outcome: () => ({ kind: "acked", reason: "dead-lettered" } as const),
    }),
    pendingRetryLater: assign({
      outcome: () => ({ kind: "pending", reason: "retry-later" } as const),
    }),
    failedFromError: assign({
      outcome: ({ event }) => ({ kind: "failed", reason: "handler-error", error: normalizeError(errorFrom(event)) } as const),
    }),
    failedFromRememberedError: assign({
      outcome: ({ context }) => ({ kind: "failed", reason: "handler-error", error: normalizeError(context.lastError) } as const),
    }),
  },
  guards: {
    runMissing: ({ context }) => !context.run,
    runTerminal: ({ context }) => isTerminalRunStatus(context.run?.status),
    activeRunMismatch: ({ context }) => context.activeRunId !== context.run?.runId,
    leaseClaimed: ({ event }) => outputFrom<LeaseClaimResult>(event).claimed,
    shouldLeavePending: ({ context, event }) => context.shouldLeavePending(errorFrom(event)),
    retryLaterDeadLettered: ({ event }) => outputFrom<RetryLaterDecision>(event).deadLettered,
  },
}).createMachine({
  id: "runControlWorkerJob",
  initial: "loadingRun",
  context: ({ input }) => ({
    ...input,
  }),
  states: {
    loadingRun: {
      invoke: {
        src: "loadRun",
        input: ({ context }) => context,
        onDone: {
          target: "validatingRun",
          actions: "rememberRun",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    validatingRun: {
      always: [
        { guard: "runMissing", target: "acknowledgingMissingRun" },
        { guard: "runTerminal", target: "acknowledgingTerminalRun" },
        { target: "loadingActiveRunId" },
      ],
    },
    acknowledgingMissingRun: {
      invoke: {
        src: "acknowledgeJob",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "ackedMissingRun",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    acknowledgingTerminalRun: {
      invoke: {
        src: "acknowledgeJob",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "ackedTerminalRun",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    loadingActiveRunId: {
      invoke: {
        src: "loadActiveRunId",
        input: ({ context }) => context,
        onDone: {
          target: "validatingActivePointer",
          actions: "rememberActiveRunId",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    validatingActivePointer: {
      always: [
        { guard: "activeRunMismatch", target: "skippingStaleJob" },
        { target: "claimingLease" },
      ],
    },
    skippingStaleJob: {
      invoke: {
        src: "recordStaleJobAndAck",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "ackedStaleJob",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    claimingLease: {
      invoke: {
        src: "claimLease",
        input: ({ context }) => context,
        onDone: [
          {
            guard: "leaseClaimed",
            target: "executingWithLease",
            actions: "rememberLeaseClaim",
          },
          {
            target: "recordingBusyLease",
            actions: "rememberLeaseClaim",
          },
        ],
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    recordingBusyLease: {
      invoke: {
        src: "recordBusyLease",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "pendingBusyLease",
        },
        onError: {
          target: "done",
          actions: "failedFromError",
        },
      },
    },
    executingWithLease: {
      invoke: {
        src: "executeWithLease",
        input: ({ context }) => context,
        onDone: {
          target: "releasingLeaseAndAckingJob",
        },
        onError: [
          {
            guard: "shouldLeavePending",
            target: "recordingRetryLater",
            actions: "rememberError",
          },
          {
            target: "releasingLeaseAfterFailure",
            actions: "rememberError",
          },
        ],
      },
    },
    releasingLeaseAndAckingJob: {
      invoke: {
        src: "releaseLeaseAndAck",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "ackedCompletedRun",
        },
        onError: [
          {
            guard: "shouldLeavePending",
            target: "recordingRetryLater",
            actions: "rememberError",
          },
          {
            target: "done",
            actions: "failedFromError",
          },
        ],
      },
    },
    recordingRetryLater: {
      invoke: {
        src: "recordRetryLaterAndRelease",
        input: ({ context }) => context,
        onDone: [
          {
            guard: "retryLaterDeadLettered",
            target: "done",
            actions: "ackedDeadLetteredRun",
          },
          {
            target: "done",
            actions: "pendingRetryLater",
          },
        ],
        onError: [
          {
            guard: "shouldLeavePending",
            target: "done",
            actions: "pendingRetryLater",
          },
          {
            target: "done",
            actions: "failedFromError",
          },
        ],
      },
    },
    releasingLeaseAfterFailure: {
      invoke: {
        src: "releaseLeasePending",
        input: ({ context }) => context,
        onDone: {
          target: "done",
          actions: "failedFromRememberedError",
        },
        onError: {
          target: "done",
          actions: "failedFromRememberedError",
        },
      },
    },
    done: {
      type: "final",
    },
  },
});

export async function runRunControlWorkerJob(input: RunControlWorkerJobMachineInput): Promise<RunControlWorkerJobOutcome> {
  const actor = createActor(runControlWorkerJobMachine, { input });
  actor.start();
  try {
    const snapshot = await waitFor(actor, (candidate) => candidate.status === "done");
    const outcome = snapshot.context.outcome;
    if (!outcome) throw new Error(`run-control job ${input.job.runId} finished without an outcome`);
    if (outcome.kind === "failed") throw outcome.error;
    return outcome;
  } finally {
    actor.stop();
  }
}
