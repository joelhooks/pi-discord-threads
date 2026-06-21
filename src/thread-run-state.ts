import { createMachine } from "xstate";
import type { ActiveRunRecord, ThreadRecord } from "./registry.js";

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

export type QueueIntentMode = "steer" | "followUp";

export interface QueueIntent {
  text: string;
  mode: QueueIntentMode;
}

export type RuntimePromptDisposition =
  | { kind: "start" }
  | { kind: "queue"; mode: QueueIntentMode; reason: "runtime-streaming" | "registry-running" };

export const ACTIVE_RUN_PROMPT_LIMIT = 24_000;

export function parseQueueIntent(prompt: string): QueueIntent {
  const trimmed = prompt.trim();
  const followUpMatch = trimmed.match(/^(?:follow[- ]?up|after|later)\s*[:：]?\s+([\s\S]*)$/i);
  if (followUpMatch?.[1]?.trim()) {
    return { mode: "followUp", text: followUpMatch[1].trim() };
  }
  return { mode: "steer", text: prompt };
}

export function summarizeActiveRunPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 500);
}

export interface BuildActiveRunRecordOptions {
  now?: Date;
}

export function buildActiveRunRecord(
  sourceDiscordMessageId: string,
  placeholderDiscordMessageId: string,
  prompt: string,
  sessionFile: string | undefined,
  runId?: string,
  options: BuildActiveRunRecordOptions = {},
): ActiveRunRecord {
  const now = (options.now ?? new Date()).toISOString();
  const storedPrompt = prompt.length > ACTIVE_RUN_PROMPT_LIMIT
    ? `${prompt.slice(0, ACTIVE_RUN_PROMPT_LIMIT)}\n\n[truncated by pi-discord-threads active-run recovery metadata]`
    : prompt;
  return {
    runId,
    sourceDiscordMessageId,
    placeholderDiscordMessageId,
    prompt: storedPrompt,
    promptPreview: summarizeActiveRunPrompt(prompt),
    startedAt: now,
    updatedAt: now,
    sessionFile,
  };
}

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

export function isAssistantLeafContinueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot continue from message role: assistant");
}

export function isAlreadyProcessingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Agent is already processing") && message.includes("streamingBehavior");
}
