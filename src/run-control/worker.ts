import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { createProgressEventBus, type ProgressEventBusPort } from "../progress-events.js";
import type { QueuedRunInput, RunControlExecutionResult, RunControlStorePort, RunJob, RunRecord } from "./types.js";
import { isTerminalRunStatus } from "./types.js";

class RetryRunLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryRunLaterError";
  }
}

type PendingRunInput = QueuedRunInput & {
  attempts: number;
  nextRetryAt: number;
};

const MAX_INPUT_APPLY_ATTEMPTS = 30;

export interface RunControlWorkerAdapter {
  executeRun(run: RunRecord, progressEvents: ProgressEventBusPort): Promise<RunControlExecutionResult>;
  finalizeRun(run: RunRecord, result: RunControlExecutionResult): Promise<void>;
  failRun(run: RunRecord, error: Error): Promise<void>;
  applyInput(run: RunRecord, input: QueuedRunInput): Promise<{ queued: boolean }>;
}

export class RunControlWorker {
  private stopped = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly store: RunControlStorePort,
    private readonly adapter: RunControlWorkerAdapter,
    private readonly config: AppConfig,
    private readonly workerId: string,
  ) {}

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop().catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`run-control worker stopped unexpectedly: ${text}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise?.catch(() => undefined);
  }

  private async loop(): Promise<void> {
    await this.ensureConsumerGroupWithRetry();
    if (this.stopped) return;
    console.log(`run-control worker ${this.workerId} listening for Redis jobs`);
    while (!this.stopped) {
      const job = await this.store.dequeueJob(this.workerId, 1_000).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`run-control dequeue failed: ${text}`);
        return undefined;
      });
      if (!job) {
        await this.store.recordWorkerIdle(this.workerId).catch(() => undefined);
        continue;
      }
      await this.handleJob(job).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`run-control job ${job.runId} failed outside handler: ${text}`);
      });
    }
  }

  private async ensureConsumerGroupWithRetry(): Promise<void> {
    let delayMs = 500;
    while (!this.stopped) {
      try {
        await this.store.ensureConsumerGroup();
        return;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`run-control ensure consumer group failed; retrying in ${delayMs}ms: ${text}`);
        await sleep(delayMs);
        delayMs = Math.min(30_000, delayMs * 2);
      }
    }
  }

  private async handleJob(job: RunJob): Promise<void> {
    const run = await this.store.getRun(job.runId);
    if (!run) {
      await this.store.acknowledgeJob(job);
      return;
    }
    if (isTerminalRunStatus(run.status)) {
      await this.store.acknowledgeJob(job);
      return;
    }

    const leaseToken = randomUUID();
    const claimed = await this.store.claimRunLease(run, this.workerId, leaseToken);
    if (!claimed) {
      await this.store.acknowledgeJob(job);
      return;
    }

    let terminal = false;
    try {
      await this.runWithLease(run, leaseToken);
      terminal = true;
    } finally {
      await this.store.releaseRunLease(run.runId, leaseToken).catch(() => undefined);
      if (terminal) {
        await this.store.acknowledgeJob(job);
      }
    }
  }

  private async runWithLease(run: RunRecord, leaseToken: string): Promise<void> {
    let lastInputId = "0-0";
    const pendingInputs: PendingRunInput[] = [];
    let acceptingInputs = run.status !== "finalizing";

    const heartbeat = setInterval(() => {
      void this.store.heartbeatRunLease(run.runId, leaseToken, this.workerId).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`run-control heartbeat failed for ${run.runId}: ${text}`);
      });
    }, this.config.runControl.heartbeatMs);
    heartbeat.unref();

    let drainingInputs = false;
    const drainInputs = async () => {
      if (!acceptingInputs || drainingInputs) return;
      drainingInputs = true;
      try {
        const inputs = await this.store.readInputsSince(run.logicalThreadId, lastInputId);
        for (const input of inputs) {
          if (input.inputId) lastInputId = input.inputId;
          if (input.runId !== run.runId) continue;
          pendingInputs.push({ ...input, attempts: 0, nextRetryAt: 0 });
        }

        for (let index = 0; index < pendingInputs.length;) {
          const input = pendingInputs[index];
          const now = Date.now();
          if (input.nextRetryAt > now) {
            index++;
            continue;
          }

          const applied = await this.adapter.applyInput(run, input).catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            console.warn(`run-control input ${input.inputId ?? "unknown"} failed for ${run.runId}: ${text}`);
            return { queued: false };
          });
          if (applied.queued) {
            pendingInputs.splice(index, 1);
            continue;
          }

          input.attempts++;
          if (input.attempts >= MAX_INPUT_APPLY_ATTEMPTS) {
            console.warn(`run-control input ${input.inputId ?? "unknown"} dropped for ${run.runId} after ${input.attempts} apply attempts`);
            pendingInputs.splice(index, 1);
            continue;
          }

          input.nextRetryAt = now + Math.min(5_000, 250 * (2 ** Math.min(input.attempts, 5)));
          index++;
        }
      } finally {
        drainingInputs = false;
      }
    };

    const inputPump = setInterval(() => {
      if (acceptingInputs) void drainInputs();
    }, Math.min(1_000, Math.max(250, this.config.runControl.heartbeatMs)));
    inputPump.unref();

    const progressEvents = createProgressEventBus(async (progress) => {
      await this.store.appendRunEvent(run.runId, progress.feedEvent?.type ?? progress.phase, {
        title: progress.title,
        detail: progress.detail,
        toolName: progress.toolName,
        isError: progress.isError,
        sessionFile: progress.sessionFile,
      }).catch(() => undefined);
    });

    try {
      let result: RunControlExecutionResult;
      if (run.status === "finalizing" && run.resultText !== undefined) {
        acceptingInputs = false;
        result = this.resultFromFinalizingRun(run);
      } else {
        await drainInputs();
        result = await this.adapter.executeRun(run, progressEvents);
        acceptingInputs = false;
        await this.store.patchRun(run.runId, {
          status: "finalizing",
          sessionFile: result.sessionFile,
          userEntryId: result.userEntryId,
          assistantEntryId: result.assistantEntryId,
          resultText: result.text,
        }, { preserveTerminal: true });
      }

      await this.finalizeSuccessfulRun(run, result);
    } catch (error) {
      acceptingInputs = false;
      if (error instanceof RetryRunLaterError) throw error;
      const normalized = error instanceof Error ? error : new Error(String(error));
      await this.finalizeFailedRun(run, normalized);
    } finally {
      acceptingInputs = false;
      clearInterval(inputPump);
      clearInterval(heartbeat);
    }
  }

  private resultFromFinalizingRun(run: RunRecord): RunControlExecutionResult {
    return {
      text: run.resultText ?? "",
      sessionFile: run.sessionFile,
      userEntryId: run.userEntryId,
      assistantEntryId: run.assistantEntryId,
    };
  }

  private async finalizeSuccessfulRun(run: RunRecord, result: RunControlExecutionResult): Promise<void> {
    const finalizeToken = randomUUID();
    const claim = await this.store.acquireFinalize(run.runId, finalizeToken).catch(() => "busy" as const);
    if (claim === "busy") {
      throw new RetryRunLaterError(`finalization already in progress for ${run.runId}`);
    }

    const finalizedAt = new Date().toISOString();
    if (claim === "acquired") {
      await this.adapter.finalizeRun(run, result);
      await this.store.completeFinalize(run.runId, finalizeToken);
    }

    await this.store.markTerminal(run.runId, "succeeded", {
      sessionFile: result.sessionFile,
      userEntryId: result.userEntryId,
      assistantEntryId: result.assistantEntryId,
      resultText: result.text,
      placeholderRetiredAt: finalizedAt,
    });
    await this.store.clearActiveIfMatches(run.logicalThreadId, run.runId);
  }

  private async finalizeFailedRun(run: RunRecord, error: Error): Promise<void> {
    const finalizeToken = randomUUID();
    const claim = await this.store.acquireFinalize(run.runId, finalizeToken).catch(() => "busy" as const);
    if (claim === "busy") {
      throw new RetryRunLaterError(`failure finalization already in progress for ${run.runId}`);
    }

    const finalizedAt = new Date().toISOString();
    if (claim === "acquired") {
      await this.adapter.failRun(run, error).catch((failError) => {
        const text = failError instanceof Error ? failError.message : String(failError);
        console.warn(`run-control failed to edit error placeholder for ${run.runId}: ${text}`);
      });
      await this.store.completeFinalize(run.runId, finalizeToken);
    }

    await this.store.markTerminal(run.runId, "failed", {
      error: error.message,
      placeholderRetiredAt: finalizedAt,
    });
    await this.store.clearActiveIfMatches(run.logicalThreadId, run.runId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
