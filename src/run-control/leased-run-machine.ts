import { createActor, waitFor, assign, fromCallback, fromPromise, setup } from "xstate";
import type { AppConfig } from "../config.js";
import { formatUnknownError } from "../error-format.js";
import { createProgressEventBus, type ProgressEventBusPort } from "../progress-events.js";
import type { FinalizeClaim, QueuedRunInput, RunControlExecutionOptions, RunControlExecutionResult, RunControlStorePort, RunRecord } from "./types.js";
import { isRetryRunLaterError, RetryRunLaterError } from "./errors.js";

type PendingRunInput = QueuedRunInput & {
  attempts: number;
  nextRetryAt: number;
};

const MAX_INPUT_APPLY_ATTEMPTS = 30;
const FINAL_OUTBOX_BLIND_NONCE_WINDOW_MS = 2 * 60_000;

export interface RunControlLeasedRunAdapter {
  executeRun(run: RunRecord, progressEvents: ProgressEventBusPort, options: RunControlExecutionOptions): Promise<RunControlExecutionResult>;
  abortRun(run: RunRecord, reason: string): Promise<void>;
  finalizeRun(run: RunRecord, result: RunControlExecutionResult): Promise<void>;
  failRun(run: RunRecord, error: Error): Promise<void>;
  applyInput(run: RunRecord, input: QueuedRunInput): Promise<{ queued: boolean }>;
}

export type RunControlLeasedRunOutcome =
  | { kind: "completed" }
  | { kind: "retry-later"; message: string }
  | { kind: "failed"; error: Error };

export interface RunControlLeasedRunMachineInput {
  store: RunControlStorePort;
  adapter: RunControlLeasedRunAdapter;
  config: AppConfig;
  run: RunRecord;
  leaseToken: string;
  workerId: string;
  createFinalizeToken: () => string;
  warn(message: string): void;
}

export interface RunControlLeasedRunMachineContext extends RunControlLeasedRunMachineInput {
  lastInputId: string;
  pendingInputs: PendingRunInput[];
  result?: RunControlExecutionResult;
  lastError?: unknown;
  finalizeToken?: string;
  finalizeClaim?: FinalizeClaim;
  finalizedAt?: string;
  outcome?: RunControlLeasedRunOutcome;
}

export type RunControlLeasedRunMachineEvent = { type: "INPUT_TICK" } | { type: "LEASE_LOST" };

type DoneEvent<T> = { output: T };
type ErrorEvent = { error: unknown };

interface InputDrainOutput {
  lastInputId: string;
  pendingInputs: PendingRunInput[];
}

interface FinalizeAcquireOutput {
  claim: FinalizeClaim;
  finalizeToken: string;
  finalizedAt: string;
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

function resultFromFinalizingRun(run: RunRecord): RunControlExecutionResult {
  return {
    text: run.resultText ?? "",
    sessionFile: run.sessionFile,
    userEntryId: run.userEntryId,
    assistantEntryId: run.assistantEntryId,
  };
}

function requireResult(context: RunControlLeasedRunMachineContext): RunControlExecutionResult {
  if (!context.result) throw new Error(`run-control leased run ${context.run.runId} has no execution result`);
  return context.result;
}

function requireFinalizeToken(context: RunControlLeasedRunMachineContext): string {
  if (!context.finalizeToken) throw new Error(`run-control leased run ${context.run.runId} has no finalize token`);
  return context.finalizeToken;
}

function finalizedAt(context: RunControlLeasedRunMachineContext): string {
  return context.finalizedAt ?? new Date().toISOString();
}

function leaseLostError(context: RunControlLeasedRunMachineContext): RetryRunLaterError {
  return new RetryRunLaterError(`run-control lease lost for ${context.run.runId}; leaving job pending for ownership recovery`);
}

async function ensureOwnership(context: RunControlLeasedRunMachineContext): Promise<void> {
  const owned = await context.store.verifyRunOwnership(context.run.runId, context.run.logicalThreadId, context.leaseToken).catch((error) => {
    throw new RetryRunLaterError(`run-control ownership check failed for ${context.run.runId}: ${formatUnknownError(error)}`);
  });
  if (!owned) throw leaseLostError(context);
}

async function drainInputs(context: RunControlLeasedRunMachineContext): Promise<InputDrainOutput> {
  await ensureOwnership(context);
  let lastInputId = context.lastInputId;
  const pendingInputs = context.pendingInputs.map((input) => ({ ...input }));
  const inputs = await context.store.readInputsSince(context.run.logicalThreadId, lastInputId);
  for (const input of inputs) {
    if (input.inputId) lastInputId = input.inputId;
    if (input.runId !== context.run.runId) continue;
    pendingInputs.push({ ...input, attempts: 0, nextRetryAt: 0 });
  }

  for (let index = 0; index < pendingInputs.length;) {
    const input = pendingInputs[index];
    const now = Date.now();
    if (input.nextRetryAt > now) {
      index++;
      continue;
    }

    const applied = await context.adapter.applyInput(context.run, input).catch((error) => {
      context.warn(`run-control input ${input.inputId ?? "unknown"} failed for ${context.run.runId}: ${formatUnknownError(error)}`);
      return { queued: false };
    });
    if (applied.queued) {
      pendingInputs.splice(index, 1);
      continue;
    }

    input.attempts++;
    if (input.attempts >= MAX_INPUT_APPLY_ATTEMPTS) {
      context.warn(`run-control input ${input.inputId ?? "unknown"} dropped for ${context.run.runId} after ${input.attempts} apply attempts`);
      pendingInputs.splice(index, 1);
      continue;
    }

    input.nextRetryAt = now + Math.min(5_000, 250 * (2 ** Math.min(input.attempts, 5)));
    index++;
  }

  return { lastInputId, pendingInputs };
}

async function acquireFinalize(context: RunControlLeasedRunMachineContext): Promise<FinalizeAcquireOutput> {
  await ensureOwnership(context);
  const finalizeToken = context.createFinalizeToken();
  const claim = await context.store.acquireFinalize(context.run.runId, finalizeToken).catch(() => "busy" as const);
  return { claim, finalizeToken, finalizedAt: new Date().toISOString() };
}

function duplicateFinalizationError(): Error {
  return new Error("Previous Discord finalization attempt is uncertain; refusing to post a duplicate final answer");
}

function finalOutboxStartedAtMs(run: RunRecord): number | undefined {
  if (!run.finalDiscordOutboxStartedAt) return undefined;
  const startedAt = Date.parse(run.finalDiscordOutboxStartedAt);
  return Number.isFinite(startedAt) ? startedAt : undefined;
}

function hasCompleteFinalOutboxIds(run: RunRecord): boolean {
  const ids = run.finalDiscordMessageIds ?? [];
  if (ids.length === 0) return false;
  return run.finalDiscordChunkCount === undefined || ids.length >= run.finalDiscordChunkCount;
}

function hasRecoverableFinalOutbox(run: RunRecord): boolean {
  if (hasCompleteFinalOutboxIds(run)) return true;
  const startedAt = finalOutboxStartedAtMs(run);
  return startedAt !== undefined && Date.now() - startedAt <= FINAL_OUTBOX_BLIND_NONCE_WINDOW_MS;
}

function hasExpiredFinalOutboxWithoutCompleteIds(run: RunRecord): boolean {
  if (hasCompleteFinalOutboxIds(run)) return false;
  const startedAt = finalOutboxStartedAtMs(run);
  return startedAt !== undefined && Date.now() - startedAt > FINAL_OUTBOX_BLIND_NONCE_WINDOW_MS;
}

export const runControlLeasedRunMachine = setup({
  types: {} as {
    input: RunControlLeasedRunMachineInput;
    context: RunControlLeasedRunMachineContext;
    events: RunControlLeasedRunMachineEvent;
  },
  actors: {
    heartbeat: fromCallback<RunControlLeasedRunMachineEvent, RunControlLeasedRunMachineContext>(({ input, sendBack }) => {
      const heartbeat = setInterval(() => {
        void input.store.heartbeatRunLease(input.run.runId, input.run.logicalThreadId, input.leaseToken, input.workerId).then((owned) => {
          if (!owned) sendBack({ type: "LEASE_LOST" });
        }).catch((error) => {
          input.warn(`run-control heartbeat failed for ${input.run.runId}: ${formatUnknownError(error)}`);
        });
      }, input.config.runControl.heartbeatMs);
      heartbeat.unref();
      return () => clearInterval(heartbeat);
    }),
    inputTicker: fromCallback<RunControlLeasedRunMachineEvent, RunControlLeasedRunMachineContext>(({ input, sendBack }) => {
      const inputPump = setInterval(() => {
        sendBack({ type: "INPUT_TICK" });
      }, Math.min(1_000, Math.max(250, input.config.runControl.heartbeatMs)));
      inputPump.unref();
      return () => clearInterval(inputPump);
    }),
    drainInputs: fromPromise<InputDrainOutput, RunControlLeasedRunMachineContext>(async ({ input }) => {
      return drainInputs(input);
    }),
    executeFreshRun: fromPromise<RunControlExecutionResult, RunControlLeasedRunMachineContext>(async ({ input, signal }) => {
      const progressEvents = createProgressEventBus(async (progress) => {
        await input.store.appendRunEvent(input.run.runId, progress.feedEvent?.type ?? progress.phase, {
          title: progress.title,
          detail: progress.detail,
          toolName: progress.toolName,
          isError: progress.isError,
          sessionFile: progress.sessionFile,
        }).catch(() => undefined);
      });
      return input.adapter.executeRun(input.run, progressEvents, { signal });
    }),
    abortFreshExecution: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await input.adapter.abortRun(input.run, leaseLostError(input).message).catch((error) => {
        input.warn(`run-control abort after lease loss failed for ${input.run.runId}: ${formatUnknownError(error)}`);
      });
    }),
    patchRunFinalizing: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await ensureOwnership(input);
      const result = requireResult(input);
      await input.store.patchRun(input.run.runId, {
        status: "finalizing",
        sessionFile: result.sessionFile,
        userEntryId: result.userEntryId,
        assistantEntryId: result.assistantEntryId,
        resultText: result.text,
      }, { preserveTerminal: true });
    }),
    acquireSuccessFinalize: fromPromise<FinalizeAcquireOutput, RunControlLeasedRunMachineContext>(async ({ input }) => {
      return acquireFinalize(input);
    }),
    acquireFailureFinalize: fromPromise<FinalizeAcquireOutput, RunControlLeasedRunMachineContext>(async ({ input }) => {
      return acquireFinalize(input);
    }),
    recordFinalizeAttempt: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await ensureOwnership(input);
    }),
    postSuccessDiscord: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await ensureOwnership(input);
      await input.adapter.finalizeRun(input.run, requireResult(input));
    }),
    editUncertainFailurePlaceholder: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await ensureOwnership(input);
      const error = duplicateFinalizationError();
      await input.adapter.failRun(input.run, error).catch((failError) => {
        input.warn(`run-control failed to edit uncertain-finalization placeholder for ${input.run.runId}: ${formatUnknownError(failError)}`);
      });
    }),
    editFailurePlaceholder: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await ensureOwnership(input);
      const error = normalizeError(input.lastError);
      await input.adapter.failRun(input.run, error).catch((failError) => {
        input.warn(`run-control failed to edit error placeholder for ${input.run.runId}: ${formatUnknownError(failError)}`);
      });
    }),
    completeFinalize: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      const completed = await input.store.completeFinalize(input.run.runId, requireFinalizeToken(input));
      if (!completed) throw new RetryRunLaterError(`finalize claim lost for ${input.run.runId}; leaving job pending for uncertain-finalization recovery`);
    }),
    markSuccessTerminal: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      const result = requireResult(input);
      await input.store.markTerminal(input.run.runId, "succeeded", {
        sessionFile: result.sessionFile,
        userEntryId: result.userEntryId,
        assistantEntryId: result.assistantEntryId,
        resultText: result.text,
        placeholderRetiredAt: finalizedAt(input),
      });
    }),
    markUncertainFailureTerminal: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      const error = duplicateFinalizationError();
      await input.store.markTerminal(input.run.runId, "failed", {
        error: error.message,
        placeholderRetiredAt: finalizedAt(input),
      });
    }),
    markFailureTerminal: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      const error = normalizeError(input.lastError);
      await input.store.markTerminal(input.run.runId, "failed", {
        error: error.message,
        placeholderRetiredAt: finalizedAt(input),
      });
    }),
    clearActivePointer: fromPromise<void, RunControlLeasedRunMachineContext>(async ({ input }) => {
      await input.store.clearActiveIfMatches(input.run.logicalThreadId, input.run.runId);
    }),
  },
  actions: {
    rememberInputDrain: assign({
      lastInputId: ({ event }) => outputFrom<InputDrainOutput>(event).lastInputId,
      pendingInputs: ({ event }) => outputFrom<InputDrainOutput>(event).pendingInputs,
    }),
    warnInputDrainFailure: ({ context, event }) => {
      const error = errorFrom(event);
      context.warn(`run-control input drain failed for ${context.run.runId}: ${formatUnknownError(error)}`);
    },
    rememberPersistedResult: assign({
      result: ({ context }) => resultFromFinalizingRun(context.run),
    }),
    rememberResult: assign({
      result: ({ event }) => outputFrom<RunControlExecutionResult>(event),
    }),
    rememberError: assign({
      lastError: ({ event }) => errorFrom(event),
    }),
    rememberFinalizeAcquire: assign({
      finalizeClaim: ({ event }) => outputFrom<FinalizeAcquireOutput>(event).claim,
      finalizeToken: ({ event }) => outputFrom<FinalizeAcquireOutput>(event).finalizeToken,
      finalizedAt: ({ event }) => outputFrom<FinalizeAcquireOutput>(event).finalizedAt,
    }),
    completed: assign({
      outcome: () => ({ kind: "completed" } as const),
    }),
    retryLater: assign({
      outcome: ({ context }) => ({ kind: "retry-later", message: `finalization already in progress for ${context.run.runId}` } as const),
    }),
    failureRetryLater: assign({
      outcome: ({ context }) => ({ kind: "retry-later", message: `failure finalization already in progress for ${context.run.runId}` } as const),
    }),
    failedFromError: assign({
      outcome: ({ event }) => ({ kind: "failed", error: normalizeError(errorFrom(event)) } as const),
    }),
    retryLaterFromError: assign({
      outcome: ({ event }) => ({ kind: "retry-later", message: normalizeError(errorFrom(event)).message } as const),
    }),
    lostOwnership: assign({
      outcome: ({ context }) => {
        const error = leaseLostError(context);
        context.warn(error.message);
        return { kind: "retry-later", message: error.message } as const;
      },
    }),
  },
  guards: {
    hasPersistedFinalizingResult: ({ context }) => context.run.status === "finalizing" && context.run.resultText !== undefined,
    hasFinalizeAttemptReceipt: ({ context }) => Boolean(context.run.finalizeAttemptedAt),
    hasRecoverableFinalOutbox: ({ context }) => hasRecoverableFinalOutbox(context.run),
    hasExpiredFinalOutboxWithoutCompleteIds: ({ context }) => hasExpiredFinalOutboxWithoutCompleteIds(context.run),
    isRetryLaterError: ({ event }) => isRetryRunLaterError(errorFrom(event)),
    finalizeBusy: ({ context }) => context.finalizeClaim === "busy",
    finalizeAcquired: ({ context }) => context.finalizeClaim === "acquired",
    finalizeDone: ({ context }) => context.finalizeClaim === "done",
  },
}).createMachine({
  id: "runControlLeasedRun",
  initial: "leased",
  context: ({ input }) => ({
    ...input,
    lastInputId: "0-0",
    pendingInputs: [],
  }),
  states: {
    leased: {
      invoke: {
        id: "heartbeat",
        src: "heartbeat",
        input: ({ context }) => context,
      },
      initial: "checkingPersistedResult",
      states: {
        checkingPersistedResult: {
          always: [
            {
              guard: "hasPersistedFinalizingResult",
              target: "acquiringSuccessFinalize",
              actions: "rememberPersistedResult",
            },
            { target: "drainingInitialInputs" },
          ],
        },
        drainingInitialInputs: {
          invoke: {
            src: "drainInputs",
            input: ({ context }) => context,
            onDone: {
              target: "freshExecution",
              actions: "rememberInputDrain",
            },
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "acquiringFailureFinalize",
                actions: "rememberError",
              },
            ],
          },
        },
        freshExecution: {
          type: "parallel",
          on: {
            LEASE_LOST: { target: "abortingFreshExecution", actions: "lostOwnership" },
          },
          invoke: {
            id: "inputTicker",
            src: "inputTicker",
            input: ({ context }) => context,
          },
          states: {
            inputPump: {
              initial: "waiting",
              states: {
                waiting: {
                  on: {
                    INPUT_TICK: "draining",
                  },
                },
                draining: {
                  invoke: {
                    src: "drainInputs",
                    input: ({ context }) => context,
                    onDone: {
                      target: "waiting",
                      actions: "rememberInputDrain",
                    },
                    onError: [
                      {
                        guard: "isRetryLaterError",
                        target: "#runControlLeasedRun.done",
                        actions: "retryLaterFromError",
                      },
                      {
                        target: "waiting",
                        actions: "warnInputDrainFailure",
                      },
                    ],
                  },
                },
              },
            },
            execution: {
              initial: "executing",
              states: {
                executing: {
                  invoke: {
                    src: "executeFreshRun",
                    input: ({ context }) => context,
                    onDone: {
                      target: "#runControlLeasedRun.leased.patchingRunFinalizing",
                      actions: "rememberResult",
                    },
                    onError: [
                      {
                        guard: "isRetryLaterError",
                        target: "#runControlLeasedRun.done",
                        actions: "retryLaterFromError",
                      },
                      {
                        target: "#runControlLeasedRun.leased.acquiringFailureFinalize",
                        actions: "rememberError",
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        abortingFreshExecution: {
          invoke: {
            src: "abortFreshExecution",
            input: ({ context }) => context,
            onDone: "#runControlLeasedRun.done",
            onError: "#runControlLeasedRun.done",
          },
        },
        patchingRunFinalizing: {
          invoke: {
            src: "patchRunFinalizing",
            input: ({ context }) => context,
            onDone: "acquiringSuccessFinalize",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "acquiringFailureFinalize",
                actions: "rememberError",
              },
            ],
          },
        },
        acquiringSuccessFinalize: {
          invoke: {
            src: "acquireSuccessFinalize",
            input: ({ context }) => context,
            onDone: {
              target: "routingSuccessFinalizeClaim",
              actions: "rememberFinalizeAcquire",
            },
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        routingSuccessFinalizeClaim: {
          always: [
            { guard: "finalizeBusy", target: "#runControlLeasedRun.done", actions: "retryLater" },
            { guard: "finalizeDone", target: "markingSuccessTerminal" },
            { guard: "hasRecoverableFinalOutbox", target: "postingSuccessDiscord" },
            { guard: "hasExpiredFinalOutboxWithoutCompleteIds", target: "editingUncertainFailurePlaceholder" },
            { guard: "hasFinalizeAttemptReceipt", target: "editingUncertainFailurePlaceholder" },
            { guard: "finalizeAcquired", target: "recordingFinalizeAttempt" },
            { target: "#runControlLeasedRun.done", actions: "retryLater" },
          ],
        },
        recordingFinalizeAttempt: {
          invoke: {
            src: "recordFinalizeAttempt",
            input: ({ context }) => context,
            onDone: "postingSuccessDiscord",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "acquiringFailureFinalize",
                actions: "rememberError",
              },
            ],
          },
        },
        postingSuccessDiscord: {
          invoke: {
            src: "postSuccessDiscord",
            input: ({ context }) => context,
            onDone: "completingSuccessFinalize",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "acquiringFailureFinalize",
                actions: "rememberError",
              },
            ],
          },
        },
        completingSuccessFinalize: {
          invoke: {
            src: "completeFinalize",
            input: ({ context }) => context,
            onDone: "markingSuccessTerminal",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "acquiringFailureFinalize",
                actions: "rememberError",
              },
            ],
          },
        },
        editingUncertainFailurePlaceholder: {
          invoke: {
            src: "editUncertainFailurePlaceholder",
            input: ({ context }) => context,
            onDone: "markingUncertainFailureTerminal",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        markingUncertainFailureTerminal: {
          invoke: {
            src: "markUncertainFailureTerminal",
            input: ({ context }) => context,
            onDone: "completingUncertainFinalize",
            onError: {
              target: "#runControlLeasedRun.done",
              actions: "failedFromError",
            },
          },
        },
        completingUncertainFinalize: {
          invoke: {
            src: "completeFinalize",
            input: ({ context }) => context,
            onDone: "clearingActivePointer",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        acquiringFailureFinalize: {
          invoke: {
            src: "acquireFailureFinalize",
            input: ({ context }) => context,
            onDone: {
              target: "routingFailureFinalizeClaim",
              actions: "rememberFinalizeAcquire",
            },
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        routingFailureFinalizeClaim: {
          always: [
            { guard: "finalizeBusy", target: "#runControlLeasedRun.done", actions: "failureRetryLater" },
            { guard: "finalizeDone", target: "markingFailureTerminal" },
            { guard: "finalizeAcquired", target: "editingFailurePlaceholder" },
            { target: "#runControlLeasedRun.done", actions: "failureRetryLater" },
          ],
        },
        editingFailurePlaceholder: {
          invoke: {
            src: "editFailurePlaceholder",
            input: ({ context }) => context,
            onDone: "completingFailureFinalize",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        completingFailureFinalize: {
          invoke: {
            src: "completeFinalize",
            input: ({ context }) => context,
            onDone: "markingFailureTerminal",
            onError: [
              {
                guard: "isRetryLaterError",
                target: "#runControlLeasedRun.done",
                actions: "retryLaterFromError",
              },
              {
                target: "#runControlLeasedRun.done",
                actions: "failedFromError",
              },
            ],
          },
        },
        markingSuccessTerminal: {
          invoke: {
            src: "markSuccessTerminal",
            input: ({ context }) => context,
            onDone: "clearingActivePointer",
            onError: {
              target: "#runControlLeasedRun.done",
              actions: "failedFromError",
            },
          },
        },
        markingFailureTerminal: {
          invoke: {
            src: "markFailureTerminal",
            input: ({ context }) => context,
            onDone: "clearingActivePointer",
            onError: {
              target: "#runControlLeasedRun.done",
              actions: "failedFromError",
            },
          },
        },
        clearingActivePointer: {
          invoke: {
            src: "clearActivePointer",
            input: ({ context }) => context,
            onDone: {
              target: "#runControlLeasedRun.done",
              actions: "completed",
            },
            onError: {
              target: "#runControlLeasedRun.done",
              actions: "failedFromError",
            },
          },
        },
      },
    },
    done: {
      type: "final",
    },
  },
});

export async function runRunControlLeasedRun(input: RunControlLeasedRunMachineInput): Promise<void> {
  const actor = createActor(runControlLeasedRunMachine, { input });
  actor.start();
  try {
    const snapshot = await waitFor(actor, (candidate) => candidate.status === "done");
    const outcome = snapshot.context.outcome;
    if (!outcome) throw new Error(`run-control leased run ${input.run.runId} finished without an outcome`);
    if (outcome.kind === "retry-later") throw new RetryRunLaterError(outcome.message);
    if (outcome.kind === "failed") throw outcome.error;
  } finally {
    actor.stop();
  }
}
