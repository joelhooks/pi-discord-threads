import { assign, createActor, fromPromise, setup, waitFor, type ActorRefFrom } from "xstate";
import type { AppConfig } from "../config.js";
import type { PromptProgress } from "../progress-events.js";
import type { ThreadRecord } from "../registry.js";
import { RunHudNarrator, type RunHudFrame } from "../run-hud.js";
import type { DiscordMessageRendererPort } from "./message-renderer.js";
import { buildHudPayload, buildWorkingPayload } from "./payloads.js";

export interface ProgressHudRenderSnapshot {
  record: ThreadRecord;
  prompt: string;
  progress: PromptProgress;
  frame?: RunHudFrame;
  elapsedMs: number;
}

export interface ProgressHudMachineInput {
  record: ThreadRecord;
  prompt: string;
  updateIntervalMs: number;
  minUpdateIntervalMs?: number;
  now?: () => number;
  render(snapshot: ProgressHudRenderSnapshot): Promise<void>;
  drain?: () => Promise<void>;
  warn?: (message: string) => void;
}

export interface ProgressHudMachineContext extends ProgressHudMachineInput {
  now: () => number;
  startedAt: number;
  lastRenderAt: number;
  hudRecord: ThreadRecord;
  latestProgress?: PromptProgress;
  latestFrame?: RunHudFrame;
  timer?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

export type ProgressHudMachineEvent =
  | { type: "PROGRESS"; progress: PromptProgress }
  | { type: "HUD_FRAME"; frame: RunHudFrame; immediate?: boolean }
  | { type: "FLUSH" }
  | { type: "HEARTBEAT" }
  | { type: "STOP" };

type ErrorEvent = { error: unknown };

function errorFrom(event: unknown): unknown {
  return (event as ErrorEvent).error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progressWantsImmediate(progress: PromptProgress): boolean {
  return progress.isError === true || progress.phase === "compaction" || progress.phase === "retry";
}

function shouldFlushNow(context: ProgressHudMachineContext, immediate = false): boolean {
  if (immediate) return true;
  const minInterval = Math.max(2_500, context.minUpdateIntervalMs ?? context.updateIntervalMs);
  return context.now() - context.lastRenderAt >= minInterval;
}

function timerDelay(context: ProgressHudMachineContext): number {
  const minInterval = Math.max(2_500, context.minUpdateIntervalMs ?? context.updateIntervalMs);
  return Math.max(250, minInterval - (context.now() - context.lastRenderAt));
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) clearTimeout(timer);
}

function clearHeartbeat(heartbeat: NodeJS.Timeout | undefined): void {
  if (heartbeat) clearInterval(heartbeat);
}

export const progressHudMachine = setup({
  types: {} as {
    input: ProgressHudMachineInput;
    context: ProgressHudMachineContext;
    events: ProgressHudMachineEvent;
  },
  actors: {
    renderLatest: fromPromise<void, ProgressHudMachineContext>(async ({ input }) => {
      if (!input.latestProgress) return;
      const elapsedMs = input.now() - input.startedAt;
      await input.render({
        record: input.hudRecord,
        prompt: input.prompt,
        progress: { ...input.latestProgress, elapsedMs },
        frame: input.latestFrame,
        elapsedMs,
      });
    }),
    drainRenderer: fromPromise<void, ProgressHudMachineContext>(async ({ input }) => {
      await input.drain?.();
    }),
  },
  actions: {
    rememberProgress: assign({
      latestProgress: ({ event }) => event.type === "PROGRESS" ? event.progress : undefined,
      hudRecord: ({ context, event }) => {
        if (event.type !== "PROGRESS" || !event.progress.sessionName) return context.hudRecord;
        return { ...context.hudRecord, sessionName: event.progress.sessionName };
      },
    }),
    rememberFrame: assign({
      latestFrame: ({ event }) => event.type === "HUD_FRAME" ? event.frame : undefined,
    }),
    markRendered: assign({
      lastRenderAt: ({ context }) => context.now(),
    }),
    scheduleTimer: assign({
      timer: ({ context, self }) => {
        clearTimer(context.timer);
        const timer = setTimeout(() => self.send({ type: "FLUSH" }), timerDelay(context));
        timer.unref();
        return timer;
      },
    }),
    clearTimer: assign({
      timer: ({ context }) => {
        clearTimer(context.timer);
        return undefined;
      },
    }),
    startHeartbeat: assign({
      heartbeat: ({ context, self }) => {
        if (context.heartbeat) return context.heartbeat;
        const heartbeat = setInterval(() => self.send({ type: "HEARTBEAT" }), context.updateIntervalMs);
        heartbeat.unref();
        return heartbeat;
      },
    }),
    clearHeartbeat: assign({
      heartbeat: ({ context }) => {
        clearHeartbeat(context.heartbeat);
        return undefined;
      },
    }),
    warnRenderFailure: ({ context, event }) => {
      context.warn?.(`progress HUD render failed: ${errorText(errorFrom(event))}`);
    },
  },
  guards: {
    hasLatestProgress: ({ context }) => Boolean(context.latestProgress),
    progressFlushNow: ({ context, event }) => event.type === "PROGRESS" && shouldFlushNow(context, progressWantsImmediate(event.progress)),
    frameFlushNow: ({ context, event }) => event.type === "HUD_FRAME" && shouldFlushNow(context, event.immediate === true),
  },
}).createMachine({
  id: "progressHud",
  initial: "idle",
  context: ({ input }) => {
    const now = input.now ?? Date.now;
    return {
      ...input,
      now,
      startedAt: now(),
      lastRenderAt: 0,
      hudRecord: input.record,
    };
  },
  states: {
    idle: {
      on: {
        PROGRESS: [
          { guard: "progressFlushNow", target: "flushing", actions: ["rememberProgress", "startHeartbeat", "clearTimer"] },
          { target: "scheduled", actions: ["rememberProgress", "startHeartbeat", "scheduleTimer"] },
        ],
        HUD_FRAME: { actions: "rememberFrame" },
        STOP: "stopped",
      },
    },
    running: {
      on: {
        PROGRESS: [
          { guard: "progressFlushNow", target: "flushing", actions: ["rememberProgress", "clearTimer"] },
          { target: "scheduled", actions: ["rememberProgress", "scheduleTimer"] },
        ],
        HUD_FRAME: [
          { guard: "frameFlushNow", target: "flushing", actions: ["rememberFrame", "clearTimer"] },
          { target: "scheduled", actions: ["rememberFrame", "scheduleTimer"] },
        ],
        HEARTBEAT: { guard: "hasLatestProgress", target: "flushing", actions: "clearTimer" },
        STOP: "stopping",
      },
    },
    scheduled: {
      on: {
        PROGRESS: [
          { guard: "progressFlushNow", target: "flushing", actions: ["rememberProgress", "clearTimer"] },
          { actions: ["rememberProgress", "scheduleTimer"] },
        ],
        HUD_FRAME: [
          { guard: "frameFlushNow", target: "flushing", actions: ["rememberFrame", "clearTimer"] },
          { actions: ["rememberFrame", "scheduleTimer"] },
        ],
        FLUSH: { guard: "hasLatestProgress", target: "flushing", actions: "clearTimer" },
        HEARTBEAT: { guard: "hasLatestProgress", target: "flushing", actions: "clearTimer" },
        STOP: "stopping",
      },
    },
    flushing: {
      on: {
        PROGRESS: { target: "scheduled", actions: ["rememberProgress", "scheduleTimer"] },
        HUD_FRAME: { target: "scheduled", actions: ["rememberFrame", "scheduleTimer"] },
        STOP: "stopping",
      },
      invoke: {
        src: "renderLatest",
        input: ({ context }) => context,
        onDone: { target: "running", actions: "markRendered" },
        onError: { target: "running", actions: ["markRendered", "warnRenderFailure"] },
      },
    },
    stopping: {
      entry: ["clearTimer", "clearHeartbeat"],
      invoke: {
        src: "drainRenderer",
        input: ({ context }) => context,
        onDone: "stopped",
        onError: "stopped",
      },
    },
    stopped: {
      type: "final",
    },
  },
});

export type ProgressHudActor = ActorRefFrom<typeof progressHudMachine>;

export interface ProgressHudSnapshot {
  record: ThreadRecord;
  prompt: string;
  progress?: PromptProgress;
  frame?: RunHudFrame;
  elapsedMs: number;
}

export interface ProgressHudController {
  update(progress: PromptProgress): void;
  snapshot(): ProgressHudSnapshot;
  stop(): Promise<void>;
  actor: ProgressHudActor;
}

export function createProgressHudController(input: {
  renderer: DiscordMessageRendererPort;
  record: ThreadRecord;
  prompt: string;
  config: AppConfig;
  warn?: (message: string) => void;
}): ProgressHudController {
  let stopped = false;
  const actor = createActor(progressHudMachine, {
    input: {
      record: input.record,
      prompt: input.prompt,
      updateIntervalMs: input.config.render.hud.updateIntervalMs,
      render: async (snapshot) => {
        if (stopped) return;
        const payload = snapshot.frame
          ? buildHudPayload(snapshot.record, snapshot.frame, snapshot.elapsedMs, snapshot.progress.isError)
          : buildWorkingPayload(snapshot.record, snapshot.prompt, snapshot.progress);
        await input.renderer.render(payload);
      },
      drain: () => input.renderer.flush(),
      warn: input.warn,
    },
  });

  const narrator = input.config.render.hud.enabled
    ? new RunHudNarrator({
        cwd: input.record.cwd,
        agentDir: input.config.pi.agentDir,
        model: input.config.render.hud.model,
        updateIntervalMs: input.config.render.hud.updateIntervalMs,
        onFrame(frame, options) {
          if (stopped) return;
          actor.send({ type: "HUD_FRAME", frame, immediate: options?.immediate });
        },
        onError(error) {
          input.warn?.(`run HUD narrator failed: ${error.message}`);
        },
      })
    : undefined;

  actor.start();
  narrator?.start();

  const readSnapshot = (): ProgressHudSnapshot => {
    const snapshot = actor.getSnapshot();
    const context = snapshot.context;
    const elapsedMs = context.now() - context.startedAt;
    return {
      record: context.hudRecord,
      prompt: context.prompt,
      progress: context.latestProgress ? { ...context.latestProgress, elapsedMs } : undefined,
      frame: context.latestFrame,
      elapsedMs,
    };
  };

  return {
    actor,
    update(progress) {
      if (stopped) return;
      actor.send({ type: "PROGRESS", progress });
      if (progress.feedEvent) narrator?.record(progress.feedEvent);
    },
    snapshot: readSnapshot,
    async stop() {
      if (stopped) return;
      stopped = true;
      narrator?.dispose();
      actor.send({ type: "STOP" });
      await waitFor(actor, (snapshot) => snapshot.status === "done", { timeout: 5_000 }).catch(() => undefined);
      actor.stop();
      await input.renderer.flush();
    },
  };
}
