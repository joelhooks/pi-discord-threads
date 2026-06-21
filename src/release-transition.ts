import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import type { AppConfig, RunControlRole } from "./config.js";
import type { DeploySafetyReport, RunControlInspectionSnapshot } from "./run-control/inspection.js";

export type ReleaseTransitionPhase =
  | "preflight"
  | "guard"
  | "canary"
  | "activate"
  | "write-plist"
  | "restart"
  | "postflight"
  | "classify"
  | "rollback";

export interface ReleaseTransitionStep {
  phase: ReleaseTransitionPhase;
  completedAt: string;
}

export interface ReleaseTransitionOperationInput {
  config: AppConfig;
  configPath: string;
  target: string;
  roles: RunControlRole[];
  force: boolean;
}

export interface ReleaseTransitionCanaryOutput {
  releaseId: string;
  summary?: string;
}

export interface ReleaseTransitionActivationOutput {
  releaseId: string;
  previousReleaseId?: string;
  currentPath?: string;
  entryPath?: string;
  summary?: string;
}

export interface ReleaseTransitionLaunchAgentGuard {
  checkedAt: string;
  summary?: string;
}

export interface ReleaseTransitionPlistOutput {
  plistPath: string;
  entryPath: string;
  summary?: string;
}

export interface ReleaseTransitionRestartOutput {
  serviceTarget: string;
  summary?: string;
}

export interface ReleaseTransitionRollbackInput extends ReleaseTransitionOperationInput {
  target: string;
  reason: DeploySafetyReport;
  activation: ReleaseTransitionActivationOutput;
}

export interface ReleaseTransitionRollbackOutput {
  releaseId: string;
  safety: DeploySafetyReport;
  summary?: string;
}

export interface ReleaseTransitionRuntimeInspectInput {
  phase: "preflight" | "postflight";
}

export interface ReleaseTransitionRuntimeClassifyInput {
  config: AppConfig;
  before: RunControlInspectionSnapshot;
  after: RunControlInspectionSnapshot;
  elapsedMs: number;
}

export interface ReleaseTransitionAdapters {
  release: {
    canary(input: ReleaseTransitionOperationInput): Promise<ReleaseTransitionCanaryOutput>;
    activate(input: ReleaseTransitionOperationInput): Promise<ReleaseTransitionActivationOutput>;
    rollback?(input: ReleaseTransitionRollbackInput): Promise<ReleaseTransitionRollbackOutput>;
  };
  launchAgent: {
    assertOutsideDaemon(input: ReleaseTransitionOperationInput): Promise<ReleaseTransitionLaunchAgentGuard>;
    writePlist(input: Omit<ReleaseTransitionOperationInput, "target" | "force"> & { guard: ReleaseTransitionLaunchAgentGuard }): Promise<ReleaseTransitionPlistOutput>;
    restart(input: Pick<ReleaseTransitionOperationInput, "config" | "force"> & { guard: ReleaseTransitionLaunchAgentGuard }): Promise<ReleaseTransitionRestartOutput>;
  };
  runtime: {
    inspect(input: ReleaseTransitionRuntimeInspectInput): Promise<RunControlInspectionSnapshot>;
    classify(input: ReleaseTransitionRuntimeClassifyInput): DeploySafetyReport;
  };
}

export interface RunReleaseDeployTransitionOptions {
  config: AppConfig;
  configPath: string;
  target: string;
  roles?: RunControlRole[];
  force?: boolean;
  elapsedMs?: number;
  now?: () => Date;
  adapters: ReleaseTransitionAdapters;
}

interface ReleaseTransitionInput extends RunReleaseDeployTransitionOptions {
  roles: RunControlRole[];
  force: boolean;
  elapsedMs?: number;
  now: () => Date;
}

export interface ReleaseTransitionContext extends ReleaseTransitionInput {
  steps: ReleaseTransitionStep[];
  preflight?: RunControlInspectionSnapshot;
  guard?: ReleaseTransitionLaunchAgentGuard;
  canary?: ReleaseTransitionCanaryOutput;
  activation?: ReleaseTransitionActivationOutput;
  plist?: ReleaseTransitionPlistOutput;
  restart?: ReleaseTransitionRestartOutput;
  postflight?: RunControlInspectionSnapshot;
  safety?: DeploySafetyReport;
  rollback?: ReleaseTransitionRollbackOutput;
  lastError?: string;
}

export type ReleaseTransitionEvent = { type: "START" };

export interface ReleaseDeployTransitionResult {
  outcome: "safe" | "waiting" | "rolled-back";
  target: string;
  steps: ReleaseTransitionStep[];
  preflight: RunControlInspectionSnapshot;
  canary: ReleaseTransitionCanaryOutput;
  activation: ReleaseTransitionActivationOutput;
  plist: ReleaseTransitionPlistOutput;
  restart: ReleaseTransitionRestartOutput;
  postflight: RunControlInspectionSnapshot;
  safety: DeploySafetyReport;
  rollback?: ReleaseTransitionRollbackOutput;
}

type DoneEvent<T> = { output: T };
type ErrorEvent = { error: unknown };

function outputFrom<T>(event: unknown): T {
  return (event as DoneEvent<T>).output;
}

function errorFrom(event: unknown): string {
  const error = (event as ErrorEvent).error;
  return error instanceof Error ? error.message : String(error);
}

function operationInput(context: ReleaseTransitionContext): ReleaseTransitionOperationInput {
  return {
    config: context.config,
    configPath: context.configPath,
    target: context.target,
    roles: context.roles,
    force: context.force,
  };
}

function addStep(context: ReleaseTransitionContext, phase: ReleaseTransitionPhase): ReleaseTransitionStep[] {
  return [...context.steps, { phase, completedAt: context.now().toISOString() }];
}

function requirePreflight(context: ReleaseTransitionContext): RunControlInspectionSnapshot {
  if (!context.preflight) throw new Error("release transition missing preflight inspection");
  return context.preflight;
}

function requirePostflight(context: ReleaseTransitionContext): RunControlInspectionSnapshot {
  if (!context.postflight) throw new Error("release transition missing postflight inspection");
  return context.postflight;
}

function resolveElapsedMs(context: ReleaseTransitionContext): number {
  if (context.elapsedMs !== undefined) return Math.max(0, context.elapsedMs);
  const preflight = Date.parse(requirePreflight(context).checkedAt);
  const postflight = Date.parse(requirePostflight(context).checkedAt);
  if (!Number.isFinite(preflight) || !Number.isFinite(postflight)) return 0;
  return Math.max(0, postflight - preflight);
}

function requireSafety(context: ReleaseTransitionContext): DeploySafetyReport {
  if (!context.safety) throw new Error("release transition missing safety report");
  return context.safety;
}

function requireGuard(context: ReleaseTransitionContext): ReleaseTransitionLaunchAgentGuard {
  if (!context.guard) throw new Error("release transition missing LaunchAgent guard result");
  return context.guard;
}

function requireActivation(context: ReleaseTransitionContext): ReleaseTransitionActivationOutput {
  if (!context.activation) throw new Error("release transition missing activation result");
  return context.activation;
}

function requireTransitionResult(context: ReleaseTransitionContext): ReleaseDeployTransitionResult {
  if (!context.preflight || !context.canary || !context.activation || !context.plist || !context.restart || !context.postflight || !context.safety) {
    throw new Error("release transition completed without required state");
  }
  return {
    outcome: context.rollback ? "rolled-back" : context.safety.status === "waiting" ? "waiting" : "safe",
    target: context.target,
    steps: context.steps,
    preflight: context.preflight,
    canary: context.canary,
    activation: context.activation,
    plist: context.plist,
    restart: context.restart,
    postflight: context.postflight,
    safety: context.safety,
    ...(context.rollback ? { rollback: context.rollback } : {}),
  };
}

function transitionFailureSafetyReport(context: ReleaseTransitionContext): DeploySafetyReport {
  return {
    status: "unknown",
    checkedAt: context.now().toISOString(),
    reasons: [{
      code: "transition-failed-after-activation",
      severity: "unknown",
      message: `Release transition failed after activation before a safe postflight could be proven: ${context.lastError ?? "unknown error"}`,
    }],
    preflightActiveRunCount: context.preflight?.activeRuns.length ?? 0,
    postflightActiveRunCount: context.postflight?.activeRuns.length ?? 0,
    postflightPendingCount: context.postflight?.pendingJobs.pendingCount ?? 0,
  };
}

export const releaseDeployTransitionMachine = setup({
  types: {} as {
    input: ReleaseTransitionInput;
    context: ReleaseTransitionContext;
    events: ReleaseTransitionEvent;
  },
  actors: {
    inspectPreflight: fromPromise<RunControlInspectionSnapshot, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.runtime.inspect({ phase: "preflight" });
    }),
    guardOutsideDaemon: fromPromise<ReleaseTransitionLaunchAgentGuard, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.launchAgent.assertOutsideDaemon(operationInput(input));
    }),
    canaryRelease: fromPromise<ReleaseTransitionCanaryOutput, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.release.canary(operationInput(input));
    }),
    activateRelease: fromPromise<ReleaseTransitionActivationOutput, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.release.activate(operationInput(input));
    }),
    writePlist: fromPromise<ReleaseTransitionPlistOutput, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.launchAgent.writePlist({
        config: input.config,
        configPath: input.configPath,
        roles: input.roles,
        guard: requireGuard(input),
      });
    }),
    restartLaunchAgent: fromPromise<ReleaseTransitionRestartOutput, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.launchAgent.restart({ config: input.config, force: input.force, guard: requireGuard(input) });
    }),
    inspectPostflight: fromPromise<RunControlInspectionSnapshot, ReleaseTransitionContext>(async ({ input }) => {
      return input.adapters.runtime.inspect({ phase: "postflight" });
    }),
    rollbackRelease: fromPromise<ReleaseTransitionRollbackOutput, ReleaseTransitionContext>(async ({ input }) => {
      const activation = requireActivation(input);
      const target = activation.previousReleaseId;
      if (!target) throw new Error("postflight was unsafe, but activation did not report a previous release id for rollback");
      if (!input.adapters.release.rollback) throw new Error("postflight was unsafe, but no release rollback adapter was provided");
      const rollback = await input.adapters.release.rollback({
        ...operationInput(input),
        target,
        reason: requireSafety(input),
        activation,
      });
      if (rollback.safety.status === "unsafe" || rollback.safety.status === "unknown") {
        throw new Error(`automatic rollback postflight safety is ${rollback.safety.status}`);
      }
      return rollback;
    }),
    rollbackAfterMutationFailure: fromPromise<ReleaseTransitionRollbackOutput, ReleaseTransitionContext>(async ({ input }) => {
      const activation = requireActivation(input);
      const target = activation.previousReleaseId;
      if (!target) throw new Error("transition failed after activation, but activation did not report a previous release id for rollback");
      if (!input.adapters.release.rollback) throw new Error("transition failed after activation, but no release rollback adapter was provided");
      const rollback = await input.adapters.release.rollback({
        ...operationInput(input),
        target,
        reason: transitionFailureSafetyReport(input),
        activation,
      });
      if (rollback.safety.status === "unsafe" || rollback.safety.status === "unknown") {
        throw new Error(`automatic rollback after transition failure postflight safety is ${rollback.safety.status}`);
      }
      return rollback;
    }),
  },
  actions: {
    rememberPreflight: assign({
      preflight: ({ event }) => outputFrom<RunControlInspectionSnapshot>(event),
      steps: ({ context }) => addStep(context, "preflight"),
    }),
    rememberGuard: assign({
      guard: ({ event }) => outputFrom<ReleaseTransitionLaunchAgentGuard>(event),
      steps: ({ context }) => addStep(context, "guard"),
    }),
    rememberCanary: assign({
      canary: ({ event }) => outputFrom<ReleaseTransitionCanaryOutput>(event),
      steps: ({ context }) => addStep(context, "canary"),
    }),
    rememberActivation: assign({
      activation: ({ event }) => outputFrom<ReleaseTransitionActivationOutput>(event),
      steps: ({ context }) => addStep(context, "activate"),
    }),
    rememberPlist: assign({
      plist: ({ event }) => outputFrom<ReleaseTransitionPlistOutput>(event),
      steps: ({ context }) => addStep(context, "write-plist"),
    }),
    rememberRestart: assign({
      restart: ({ event }) => outputFrom<ReleaseTransitionRestartOutput>(event),
      steps: ({ context }) => addStep(context, "restart"),
    }),
    rememberPostflight: assign({
      postflight: ({ event }) => outputFrom<RunControlInspectionSnapshot>(event),
      steps: ({ context }) => addStep(context, "postflight"),
    }),
    classifyPostflight: assign({
      safety: ({ context }) => context.adapters.runtime.classify({
        config: context.config,
        before: requirePreflight(context),
        after: requirePostflight(context),
        elapsedMs: resolveElapsedMs(context),
      }),
      steps: ({ context }) => addStep(context, "classify"),
    }),
    rememberRollback: assign({
      rollback: ({ event }) => outputFrom<ReleaseTransitionRollbackOutput>(event),
      steps: ({ context }) => addStep(context, "rollback"),
    }),
    rememberRollbackAfterFailure: assign({
      rollback: ({ event }) => outputFrom<ReleaseTransitionRollbackOutput>(event),
      steps: ({ context }) => addStep(context, "rollback"),
      lastError: ({ context, event }) => {
        const rollback = outputFrom<ReleaseTransitionRollbackOutput>(event);
        return `${context.lastError ?? "release transition failed"}; automatic rollback to ${rollback.releaseId} completed`;
      },
    }),
    rememberFailure: assign({
      lastError: ({ event }) => errorFrom(event),
    }),
    rememberCompensationFailure: assign({
      lastError: ({ context, event }) => `${context.lastError ?? "release transition failed"}; automatic rollback failed: ${errorFrom(event)}`,
    }),
    rememberPostflightFailure: assign({
      lastError: ({ context }) => `release transition postflight safety is ${context.safety?.status ?? "unknown"} and automatic rollback is unavailable`,
    }),
  },
  guards: {
    shouldRollback: ({ context }) => {
      const status = context.safety?.status;
      return (status === "unsafe" || status === "unknown")
        && Boolean(context.activation?.previousReleaseId)
        && Boolean(context.adapters.release.rollback);
    },
    failedWithoutRollback: ({ context }) => {
      const status = context.safety?.status;
      return status === "unsafe" || status === "unknown";
    },
    canCompensateAfterMutationFailure: ({ context }) => {
      return Boolean(context.activation?.previousReleaseId) && Boolean(context.adapters.release.rollback);
    },
  },
}).createMachine({
  id: "releaseDeployTransition",
  initial: "idle",
  context: ({ input }) => ({
    ...input,
    steps: [],
  }),
  states: {
    idle: {
      on: { START: "preflight" },
    },
    preflight: {
      invoke: {
        src: "inspectPreflight",
        input: ({ context }) => context,
        onDone: { target: "guarding", actions: "rememberPreflight" },
        onError: { target: "failed", actions: "rememberFailure" },
      },
    },
    guarding: {
      invoke: {
        src: "guardOutsideDaemon",
        input: ({ context }) => context,
        onDone: { target: "canarying", actions: "rememberGuard" },
        onError: { target: "failed", actions: "rememberFailure" },
      },
    },
    canarying: {
      invoke: {
        src: "canaryRelease",
        input: ({ context }) => context,
        onDone: { target: "activating", actions: "rememberCanary" },
        onError: { target: "failed", actions: "rememberFailure" },
      },
    },
    activating: {
      invoke: {
        src: "activateRelease",
        input: ({ context }) => context,
        onDone: { target: "writingPlist", actions: "rememberActivation" },
        onError: { target: "failed", actions: "rememberFailure" },
      },
    },
    writingPlist: {
      invoke: {
        src: "writePlist",
        input: ({ context }) => context,
        onDone: { target: "restarting", actions: "rememberPlist" },
        onError: [
          { guard: "canCompensateAfterMutationFailure", target: "compensatingFailure", actions: "rememberFailure" },
          { target: "failed", actions: "rememberFailure" },
        ],
      },
    },
    restarting: {
      invoke: {
        src: "restartLaunchAgent",
        input: ({ context }) => context,
        onDone: { target: "postflight", actions: "rememberRestart" },
        onError: [
          { guard: "canCompensateAfterMutationFailure", target: "compensatingFailure", actions: "rememberFailure" },
          { target: "failed", actions: "rememberFailure" },
        ],
      },
    },
    postflight: {
      invoke: {
        src: "inspectPostflight",
        input: ({ context }) => context,
        onDone: { target: "classifying", actions: "rememberPostflight" },
        onError: [
          { guard: "canCompensateAfterMutationFailure", target: "compensatingFailure", actions: "rememberFailure" },
          { target: "failed", actions: "rememberFailure" },
        ],
      },
    },
    classifying: {
      entry: "classifyPostflight",
      always: [
        { guard: "shouldRollback", target: "rollingBack" },
        { guard: "failedWithoutRollback", target: "failed", actions: "rememberPostflightFailure" },
        { target: "succeeded" },
      ],
    },
    rollingBack: {
      invoke: {
        src: "rollbackRelease",
        input: ({ context }) => context,
        onDone: { target: "rolledBack", actions: "rememberRollback" },
        onError: { target: "failed", actions: "rememberFailure" },
      },
    },
    compensatingFailure: {
      invoke: {
        src: "rollbackAfterMutationFailure",
        input: ({ context }) => context,
        onDone: { target: "failed", actions: "rememberRollbackAfterFailure" },
        onError: { target: "failed", actions: "rememberCompensationFailure" },
      },
    },
    succeeded: {
      tags: ["done"],
      type: "final",
    },
    rolledBack: {
      tags: ["done", "rolled-back"],
      type: "final",
    },
    failed: {
      tags: ["failed"],
      type: "final",
    },
  },
});

export async function runReleaseDeployTransition(options: RunReleaseDeployTransitionOptions): Promise<ReleaseDeployTransitionResult> {
  const input: ReleaseTransitionInput = {
    ...options,
    roles: options.roles ?? options.config.runControl.roles,
    force: options.force ?? false,
    ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
    now: options.now ?? (() => new Date()),
  };
  const actor = createActor(releaseDeployTransitionMachine, { input });
  actor.start();
  actor.send({ type: "START" });
  const snapshot = await waitFor(actor, (state) => state.status === "done");
  actor.stop();

  if (snapshot.hasTag("failed")) {
    throw new Error(snapshot.context.lastError ?? "release transition failed");
  }
  return requireTransitionResult(snapshot.context);
}
