import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ProgressEventBusPort } from "../progress-events.js";
import { isRetryRunLaterError } from "./errors.js";
import { runRunControlLeasedRun } from "./leased-run-machine.js";
import type { QueuedRunInput, RunControlExecutionResult, RunControlStorePort, RunJob, RunRecord } from "./types.js";
import { runRunControlWorkerJob } from "./worker-machine.js";

export interface RunControlWorkerAdapter {
  executeRun(run: RunRecord, progressEvents: ProgressEventBusPort): Promise<RunControlExecutionResult>;
  finalizeRun(run: RunRecord, result: RunControlExecutionResult): Promise<void>;
  failRun(run: RunRecord, error: Error): Promise<void>;
  applyInput(run: RunRecord, input: QueuedRunInput): Promise<{ queued: boolean }>;
}

export class RunControlWorker {
  private stopped = false;
  private loopPromises: Promise<void>[] = [];

  constructor(
    private readonly store: RunControlStorePort,
    private readonly adapter: RunControlWorkerAdapter,
    private readonly config: AppConfig,
    private readonly workerId: string,
  ) {}

  start(): void {
    if (this.loopPromises.length > 0) return;
    this.stopped = false;
    const concurrency = Math.max(1, Math.floor(this.config.runControl.maxConcurrentRuns));
    this.loopPromises = Array.from({ length: concurrency }, (_, index) => {
      const laneWorkerId = concurrency === 1 ? this.workerId : `${this.workerId}:${index + 1}`;
      return this.loop(laneWorkerId).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`run-control worker ${laneWorkerId} stopped unexpectedly: ${text}`);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loopPromises.map((promise) => promise.catch(() => undefined)));
    this.loopPromises = [];
  }

  private async loop(workerId: string): Promise<void> {
    await this.ensureConsumerGroupWithRetry();
    if (this.stopped) return;
    console.log(`run-control worker ${workerId} listening for Redis jobs`);
    while (!this.stopped) {
      const job = await this.store.dequeueJob(workerId, 1_000).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`run-control dequeue failed for ${workerId}: ${text}`);
        return undefined;
      });
      if (!job) {
        await this.store.recordWorkerIdle(workerId).catch(() => undefined);
        continue;
      }
      await this.handleJob(job, workerId).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`run-control job ${job.runId} failed outside handler on ${workerId}: ${text}`);
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

  private async handleJob(job: RunJob, workerId: string): Promise<void> {
    await runRunControlWorkerJob({
      store: this.store,
      job,
      workerId,
      createLeaseToken: randomUUID,
      executeWithLease: (run, leaseToken, laneWorkerId) => runRunControlLeasedRun({
        store: this.store,
        adapter: this.adapter,
        config: this.config,
        run,
        leaseToken,
        workerId: laneWorkerId,
        createFinalizeToken: randomUUID,
        warn: (message) => console.warn(message),
      }),
      shouldLeavePending: isRetryRunLaterError,
    });
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
