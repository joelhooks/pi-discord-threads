import type { RunFeedEvent } from "./run-hud.js";

export interface PromptProgress {
  phase: "starting" | "thinking" | "streaming" | "tool" | "compaction" | "retry" | "done";
  title: string;
  detail?: string;
  textPreview?: string;
  toolName?: string;
  isError?: boolean;
  sessionFile?: string;
  sessionName?: string;
  elapsedMs?: number;
  feedEvent?: RunFeedEvent;
}

export type PromptProgressHandler = (progress: PromptProgress) => void | Promise<void>;

export interface ProgressEventBusPort {
  publish: PromptProgressHandler;
  subscribe(handler: PromptProgressHandler): () => void;
}

export class ProgressEventBus implements ProgressEventBusPort {
  private readonly subscribers = new Set<PromptProgressHandler>();

  constructor(handlers: Array<PromptProgressHandler | undefined> = []) {
    for (const handler of handlers) {
      if (handler) this.subscribers.add(handler);
    }
  }

  subscribe(handler: PromptProgressHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  publish: PromptProgressHandler = async (progress) => {
    const handlers = [...this.subscribers];
    await Promise.all(handlers.map(async (handler) => {
      try {
        await handler(progress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`progress subscriber failed: ${message}`);
      }
    }));
  };
}

export function createProgressEventBus(...handlers: Array<PromptProgressHandler | undefined>): ProgressEventBus {
  return new ProgressEventBus(handlers);
}

export function publishProgressSafely(handler: PromptProgressHandler | undefined, progress: PromptProgress): void {
  if (!handler) return;
  void Promise.resolve(handler(progress)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`progress handler failed: ${message}`);
  });
}
