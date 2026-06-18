import { createMachine } from "xstate";
import type { ThreadRecord } from "./registry.js";

export type ThreadRunState =
  | "idle"
  | "starting"
  | "running"
  | "queuedFollowUp"
  | "interrupted"
  | "interruptedVisible"
  | "succeeded"
  | "error";

export type ThreadRunEvent =
  | { type: "PROMPT_REQUESTED" }
  | { type: "PLACEHOLDER_RENDERED" }
  | { type: "PI_BUSY" }
  | { type: "FOLLOW_UP_QUEUED" }
  | { type: "PI_DONE" }
  | { type: "PI_ERROR" }
  | { type: "BRIDGE_RESTART" }
  | { type: "STARTUP_RECONCILE" }
  | { type: "USER_CONTINUE" }
  | { type: "FINAL_RENDERED" }
  | { type: "USER_PROMPT" };

export const threadRunMachine = createMachine({
  id: "threadRun",
  initial: "idle",
  states: {
    idle: {
      on: {
        PROMPT_REQUESTED: "starting",
        BRIDGE_RESTART: "interrupted",
      },
    },
    starting: {
      on: {
        PLACEHOLDER_RENDERED: "running",
        PI_BUSY: "queuedFollowUp",
        PI_ERROR: "error",
        BRIDGE_RESTART: "interrupted",
      },
    },
    running: {
      on: {
        PROMPT_REQUESTED: "queuedFollowUp",
        PI_BUSY: "queuedFollowUp",
        PI_DONE: "succeeded",
        PI_ERROR: "error",
        BRIDGE_RESTART: "interrupted",
      },
    },
    queuedFollowUp: {
      on: {
        FOLLOW_UP_QUEUED: "running",
        PI_DONE: "succeeded",
        PI_ERROR: "error",
        BRIDGE_RESTART: "interrupted",
      },
    },
    interrupted: {
      on: {
        STARTUP_RECONCILE: "interruptedVisible",
        USER_CONTINUE: "starting",
        USER_PROMPT: "starting",
      },
    },
    interruptedVisible: {
      on: {
        USER_CONTINUE: "starting",
        USER_PROMPT: "starting",
      },
    },
    succeeded: {
      on: {
        FINAL_RENDERED: "idle",
        USER_PROMPT: "starting",
      },
    },
    error: {
      on: {
        USER_PROMPT: "starting",
      },
    },
  },
});

export type RuntimePromptDisposition =
  | { kind: "start" }
  | { kind: "queue"; mode: "steer" | "followUp"; reason: "runtime-streaming" | "registry-running" };

export function hasVisibleActiveRun(input: {
  registryStatus?: ThreadRecord["status"];
  hasRegistryActiveRun?: boolean;
}): boolean {
  return input.registryStatus === "running" && input.hasRegistryActiveRun === true;
}

export function decideRuntimePromptDisposition(input: {
  registryStatus?: ThreadRecord["status"];
  hasRegistryActiveRun?: boolean;
  runtimeStreaming?: boolean;
  requestedMode?: "steer" | "followUp";
}): RuntimePromptDisposition {
  const mode = input.requestedMode ?? "steer";
  if (input.runtimeStreaming && hasVisibleActiveRun(input)) {
    return { kind: "queue", mode, reason: "runtime-streaming" };
  }
  if (hasVisibleActiveRun(input)) {
    return { kind: "queue", mode, reason: "registry-running" };
  }
  return { kind: "start" };
}
