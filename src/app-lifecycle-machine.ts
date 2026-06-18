import type { AppConfig, RunControlRole } from "./config.js";
import type { PiSessionRuntimeClient, RegistryRuntimeClient, RunQueueRuntimeClient } from "./engine/runtime.js";
import type { RegistryPort } from "./registry.js";
import type { RunControlStorePort } from "./run-control/types.js";
import type { BotRuntimeHandle, RunBotOptions } from "./discord-bot.js";
import { STARTUP_RECOVERY_ENV, startupRecoveryEnabled } from "./startup-recovery.js";
import { assign, fromCallback, fromPromise, setup } from "xstate";

export interface DiscordSecrets {
  token: string;
  allowedUserIds: string[];
}

export interface AppLifecycleAdapters {
  createRunControlStore(config: AppConfig): RunQueueRuntimeClient | undefined;
  createRegistry(config: AppConfig): RegistryRuntimeClient;
  createPiSessionRuntime(config: AppConfig, registry: RegistryPort): PiSessionRuntimeClient;
  resolveDiscordSecrets(config: AppConfig): Promise<DiscordSecrets>;
  startReconcileLoop(input: {
    store: RunControlStorePort;
    registry: RegistryPort;
    config: AppConfig;
  }): () => void;
  startDiscordBot(options: RunBotOptions): BotRuntimeHandle;
  getWorkerId(config: AppConfig): string;
  log(message: string): void;
  warn(message: string): void;
}

export interface AppLifecycleInput {
  config: AppConfig;
  roles: RunControlRole[];
  adapters: AppLifecycleAdapters;
}

export interface AppLifecycleContext extends AppLifecycleInput {
  runControlStore?: RunQueueRuntimeClient;
  registry?: RegistryRuntimeClient;
  runtimeManager?: PiSessionRuntimeClient;
  stopReconcileLoop?: () => void;
  bot?: BotRuntimeHandle;
  token?: string;
  allowedUserIds: string[];
  lastError?: string;
  shutdownReason?: string;
}

export type AppLifecycleEvent =
  | { type: "START" }
  | { type: "SIGINT"; signal: "SIGINT" | string }
  | { type: "SIGTERM"; signal: "SIGTERM" | string }
  | { type: "APP_FAILURE"; error: unknown };

type DoneEvent<T> = { output: T };
type ErrorEvent = { error: unknown };

interface RegistryWarmupOutput {
  registry: RegistryRuntimeClient;
  interruptedCount: number;
}

function outputFrom<T>(event: unknown): T {
  return (event as DoneEvent<T>).output;
}

function errorFrom(event: unknown): string {
  const error = (event as ErrorEvent).error;
  return error instanceof Error ? error.message : String(error);
}

function hasRole(context: AppLifecycleContext, role: RunControlRole): boolean {
  return context.roles.includes(role);
}

function needsDiscord(context: AppLifecycleContext): boolean {
  return hasRole(context, "bot") || hasRole(context, "worker");
}

async function closeAppResources(context: AppLifecycleContext): Promise<void> {
  const failures: string[] = [];
  const close = async (label: string, operation: (() => void | Promise<void>) | undefined) => {
    if (!operation) return;
    try {
      await operation();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${text}`);
      context.adapters.warn(`failed to close ${label}: ${text}`);
    }
  };

  await close("run-control reconcile loop", () => context.stopReconcileLoop?.());
  context.stopReconcileLoop = undefined;
  await close("Discord bot", () => context.bot?.stop());
  context.bot = undefined;
  await close("Pi session runtime", () => context.runtimeManager?.close());
  context.runtimeManager = undefined;
  await close("run-control runtime", () => context.runControlStore?.close());
  context.runControlStore = undefined;
  await close("registry runtime", () => context.registry?.close());
  context.registry = undefined;

  if (failures.length > 0) {
    throw new Error(`shutdown completed with ${failures.length} failure(s): ${failures.join("; ")}`);
  }
}

export const appLifecycleMachine = setup({
  types: {} as {
    input: AppLifecycleInput;
    context: AppLifecycleContext;
    events: AppLifecycleEvent;
  },
  actors: {
    processSignals: fromCallback<AppLifecycleEvent>(({ sendBack }) => {
      const onSigint = () => sendBack({ type: "SIGINT", signal: "SIGINT" });
      const onSigterm = () => sendBack({ type: "SIGTERM", signal: "SIGTERM" });
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    }),
    warmRunQueue: fromPromise<RunQueueRuntimeClient | undefined, AppLifecycleContext>(async ({ input }) => {
      if (!input.config.runControl.enabled) return undefined;
      const store = input.adapters.createRunControlStore(input.config);
      await store?.warmup();
      if (store) {
        input.adapters.log(`Effect RunQueueRuntime warmed: engine=${store.engine}, workerId=${input.adapters.getWorkerId(input.config)}, keyPrefix=${input.config.runControl.keyPrefix}`);
      }
      return store;
    }),
    warmRegistry: fromPromise<RegistryWarmupOutput, AppLifecycleContext>(async ({ input }) => {
      const registry = input.adapters.createRegistry(input.config);
      await registry.warmup();
      input.adapters.log(`Effect RegistryRuntime warmed: engine=${registry.engine}`);
      const interruptedCount = input.config.runControl.enabled ? 0 : await registry.markRunningThreadsInterrupted();
      return { registry, interruptedCount };
    }),
    startReconcile: fromPromise<(() => void) | undefined, AppLifecycleContext>(async ({ input }) => {
      if (!input.config.runControl.enabled || !input.runControlStore || !input.registry || !hasRole(input, "reconcile")) {
        return undefined;
      }
      return input.adapters.startReconcileLoop({
        store: input.runControlStore,
        registry: input.registry,
        config: input.config,
      });
    }),
    resolveDiscordSecrets: fromPromise<DiscordSecrets, AppLifecycleContext>(async ({ input }) => {
      return input.adapters.resolveDiscordSecrets(input.config);
    }),
    warmPiSession: fromPromise<PiSessionRuntimeClient, AppLifecycleContext>(async ({ input }) => {
      if (!input.registry) throw new Error("registry runtime is required before Pi session runtime warmup");
      const runtimeManager = input.adapters.createPiSessionRuntime(input.config, input.registry);
      await runtimeManager.warmup();
      input.adapters.log(`Effect PiSessionRuntime warmed: engine=${runtimeManager.engine}`);
      return runtimeManager;
    }),
    startDiscordBot: fromPromise<BotRuntimeHandle, AppLifecycleContext>(async ({ input, signal }) => {
      if (!input.registry || !input.runtimeManager || !input.token) {
        throw new Error("Discord bot requires registry, Pi session runtime, and token before startup");
      }
      const bot = input.adapters.startDiscordBot({
        runControlStore: input.runControlStore,
        runControlRoles: input.roles,
        runControlWorkerId: input.adapters.getWorkerId(input.config),
        config: input.config,
        token: input.token,
        allowedUserIds: input.allowedUserIds,
        registry: input.registry,
        runtimeManager: input.runtimeManager,
      });
      const abort = () => void bot.stop();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await bot.ready;
        return bot;
      } catch (error) {
        await bot.stop().catch((stopError) => {
          const text = stopError instanceof Error ? stopError.message : String(stopError);
          input.adapters.warn(`failed to stop Discord bot after startup failure: ${text}`);
        });
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }),
    shutdown: fromPromise<void, AppLifecycleContext>(async ({ input }) => {
      await closeAppResources(input);
    }),
  },
  actions: {
    rememberShutdownReason: assign({
      shutdownReason: ({ event }) => event.type === "SIGINT" || event.type === "SIGTERM" ? event.signal : "shutdown",
    }),
    rememberFailure: assign({
      lastError: ({ event }) => event.type === "APP_FAILURE" ? String(event.error) : errorFrom(event),
    }),
    rememberRunQueue: assign({
      runControlStore: ({ event }) => outputFrom<RunQueueRuntimeClient | undefined>(event),
    }),
    rememberRegistry: assign({
      registry: ({ event }) => outputFrom<RegistryWarmupOutput>(event).registry,
    }),
    logInterruptedThreads: ({ context, event }) => {
      const interruptedCount = outputFrom<RegistryWarmupOutput>(event).interruptedCount;
      if (interruptedCount <= 0) return;
      if (startupRecoveryEnabled()) {
        context.adapters.log(`marked ${interruptedCount} stale running Pi session(s) as interrupted`);
      } else {
        context.adapters.warn(`startup recovery disabled; marked ${interruptedCount} stale running Pi session(s) as interrupted without auto-resume. Set ${STARTUP_RECOVERY_ENV}=1 to resume them on boot.`);
      }
    },
    rememberReconcileLoop: assign({
      stopReconcileLoop: ({ event }) => outputFrom<(() => void) | undefined>(event),
    }),
    rememberDiscordSecrets: assign({
      token: ({ event }) => outputFrom<DiscordSecrets>(event).token,
      allowedUserIds: ({ event }) => outputFrom<DiscordSecrets>(event).allowedUserIds,
    }),
    rememberPiSessionRuntime: assign({
      runtimeManager: ({ event }) => outputFrom<PiSessionRuntimeClient>(event),
    }),
    rememberDiscordBot: assign({
      bot: ({ event }) => outputFrom<BotRuntimeHandle>(event),
    }),
    logAlreadyDraining: ({ context }) => {
      context.adapters.log("shutdown already in progress");
    },
    logStopped: ({ context }) => {
      context.adapters.log(`app lifecycle stopped${context.shutdownReason ? ` after ${context.shutdownReason}` : ""}`);
    },
    logFailed: ({ context }) => {
      context.adapters.warn(`app lifecycle failed: ${context.lastError ?? "unknown failure"}`);
    },
  },
  guards: {
    needsDiscord: ({ context }) => needsDiscord(context),
    hasBotRole: ({ context }) => hasRole(context, "bot"),
    hasWorkerRole: ({ context }) => hasRole(context, "worker"),
    hasReconcileRole: ({ context }) => hasRole(context, "reconcile"),
  },
}).createMachine({
  id: "appLifecycle",
  initial: "idle",
  context: ({ input }) => ({
    ...input,
    allowedUserIds: [],
  }),
  states: {
    idle: {
      on: {
        START: "active",
      },
    },
    active: {
      invoke: {
        id: "processSignals",
        src: "processSignals",
      },
      initial: "warmingRunQueue",
      on: {
        SIGINT: {
          target: ".draining",
          actions: "rememberShutdownReason",
        },
        SIGTERM: {
          target: ".draining",
          actions: "rememberShutdownReason",
        },
        APP_FAILURE: {
          target: ".failing",
          actions: "rememberFailure",
        },
      },
      states: {
        warmingRunQueue: {
          invoke: {
            src: "warmRunQueue",
            input: ({ context }) => context,
            onDone: {
              target: "warmingRegistry",
              actions: "rememberRunQueue",
            },
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        warmingRegistry: {
          invoke: {
            src: "warmRegistry",
            input: ({ context }) => context,
            onDone: {
              target: "startingReconcile",
              actions: ["rememberRegistry", "logInterruptedThreads"],
            },
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        startingReconcile: {
          invoke: {
            src: "startReconcile",
            input: ({ context }) => context,
            onDone: [
              {
                guard: "needsDiscord",
                target: "resolvingDiscordSecrets",
                actions: "rememberReconcileLoop",
              },
              {
                target: "running",
                actions: "rememberReconcileLoop",
              },
            ],
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        resolvingDiscordSecrets: {
          invoke: {
            src: "resolveDiscordSecrets",
            input: ({ context }) => context,
            onDone: {
              target: "warmingPiSession",
              actions: "rememberDiscordSecrets",
            },
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        warmingPiSession: {
          invoke: {
            src: "warmPiSession",
            input: ({ context }) => context,
            onDone: {
              target: "connectingDiscord",
              actions: "rememberPiSessionRuntime",
            },
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        connectingDiscord: {
          invoke: {
            src: "startDiscordBot",
            input: ({ context }) => context,
            onDone: {
              target: "running",
              actions: "rememberDiscordBot",
            },
            onError: {
              target: "failing",
              actions: "rememberFailure",
            },
          },
        },
        running: {
          tags: ["running"],
          type: "parallel",
          states: {
            bot: {
              initial: "checking",
              states: {
                checking: {
                  always: [
                    { guard: "hasBotRole", target: "ready" },
                    { target: "disabled" },
                  ],
                },
                ready: {},
                disabled: {},
              },
            },
            worker: {
              initial: "checking",
              states: {
                checking: {
                  always: [
                    { guard: "hasWorkerRole", target: "ready" },
                    { target: "disabled" },
                  ],
                },
                ready: {},
                disabled: {},
              },
            },
            reconcile: {
              initial: "checking",
              states: {
                checking: {
                  always: [
                    { guard: "hasReconcileRole", target: "ready" },
                    { target: "disabled" },
                  ],
                },
                ready: {},
                disabled: {},
              },
            },
          },
        },
        draining: {
          on: {
            SIGINT: { actions: "logAlreadyDraining" },
            SIGTERM: { actions: "logAlreadyDraining" },
          },
          invoke: {
            src: "shutdown",
            input: ({ context }) => context,
            onDone: {
              target: "#appLifecycle.stopped",
              actions: "logStopped",
            },
            onError: {
              target: "#appLifecycle.failed",
              actions: "rememberFailure",
            },
          },
        },
        failing: {
          invoke: {
            src: "shutdown",
            input: ({ context }) => context,
            onDone: {
              target: "#appLifecycle.failed",
            },
            onError: {
              target: "#appLifecycle.failed",
              actions: "rememberFailure",
            },
          },
        },
      },
    },
    stopped: {
      tags: ["stopped"],
      type: "final",
    },
    failed: {
      tags: ["failed"],
      entry: "logFailed",
      type: "final",
    },
  },
});
