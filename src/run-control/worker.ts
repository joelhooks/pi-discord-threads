import { randomUUID } from "node:crypto";
import { createActor, waitFor, type ActorRefFrom } from "xstate";
import type { AppConfig } from "../config.js";
import type { ProgressEventBusPort } from "../progress-events.js";
import { isRetryRunLaterError } from "./errors.js";
import { runRunControlLeasedRun } from "./leased-run-machine.js";
import type { QueuedRunInput, RunControlExecutionResult, RunControlStorePort, RunRecord } from "./types.js";
import { runControlWorkerLaneMachine } from "./worker-lane-machine.js";

export interface RunControlWorkerAdapter {
  executeRun(run: RunRecord, progressEvents: ProgressEventBusPort): Promise<RunControlExecutionResult>;
  finalizeRun(run: RunRecord, result: RunControlExecutionResult): Promise<void>;
  failRun(run: RunRecord, error: Error): Promise<void>;
  applyInput(run: RunRecord, input: QueuedRunInput): Promise<{ queued: boolean }>;
}

type RunControlWorkerLaneActor = ActorRefFrom<typeof runControlWorkerLaneMachine>;

export class RunControlWorker {
  private lanes: Array<{ actor: RunControlWorkerLaneActor; done: Promise<void> }> = [];

  constructor(
    private readonly store: RunControlStorePort,
    private readonly adapter: RunControlWorkerAdapter,
    private readonly config: AppConfig,
    private readonly workerId: string,
  ) {}

  start(): void {
    if (this.lanes.length > 0) return;
    const concurrency = Math.max(1, Math.floor(this.config.runControl.maxConcurrentRuns));
    this.lanes = Array.from({ length: concurrency }, (_, index) => {
      const laneWorkerId = concurrency === 1 ? this.workerId : `${this.workerId}:${index + 1}`;
      const actor = createActor(runControlWorkerLaneMachine, {
        input: {
          store: this.store,
          workerId: laneWorkerId,
          blockMs: 1_000,
          createLeaseToken: randomUUID,
          executeWithLease: (run, leaseToken, workerId) => runRunControlLeasedRun({
            store: this.store,
            adapter: this.adapter,
            config: this.config,
            run,
            leaseToken,
            workerId,
            createFinalizeToken: randomUUID,
            warn: (message) => console.warn(message),
          }),
          shouldLeavePending: isRetryRunLaterError,
          log: (message) => console.log(message),
          warn: (message) => console.warn(message),
          error: (message) => console.error(message),
        },
      });
      const done = waitFor(actor, (snapshot) => snapshot.status === "done")
        .then(() => undefined)
        .catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          console.error(`run-control worker ${laneWorkerId} stopped unexpectedly: ${text}`);
        })
        .finally(() => actor.stop());
      actor.start();
      return { actor, done };
    });
  }

  async stop(): Promise<void> {
    const lanes = this.lanes;
    if (lanes.length === 0) return;
    for (const lane of lanes) lane.actor.send({ type: "STOP" });
    await Promise.all(lanes.map((lane) => lane.done.catch(() => undefined)));
    this.lanes = [];
  }
}
