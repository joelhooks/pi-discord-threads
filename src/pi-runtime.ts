import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import { DISCORD_SYSTEM_PROMPT } from "./discord-system-prompt.js";
import type { Registry, ThreadRecord } from "./registry.js";

interface ManagedRuntime {
  runtime: AgentSessionRuntime;
  disposeTimer?: NodeJS.Timeout;
}

export interface PromptResult {
  text: string;
  sessionFile: string | undefined;
  userEntryId?: string;
  assistantEntryId?: string;
}

export interface QueueMessageResult {
  queued: boolean;
  mode?: "steer" | "followUp";
  pendingMessageCount?: number;
}

export interface PromptProgress {
  phase: "starting" | "thinking" | "streaming" | "tool" | "compaction" | "retry" | "done";
  title: string;
  detail?: string;
  textPreview?: string;
  toolName?: string;
  isError?: boolean;
  sessionFile?: string;
  elapsedMs?: number;
}

export type PromptProgressHandler = (progress: PromptProgress) => void | Promise<void>;

export class PiRuntimeManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly agentDir: string;

  constructor(
    private readonly config: AppConfig,
    private readonly registry: Registry,
  ) {
    this.agentDir = config.pi.agentDir ?? getAgentDir();
  }

  async enqueuePrompt(thread: ThreadRecord, text: string, onProgress?: PromptProgressHandler): Promise<PromptResult> {
    return this.enqueueOperation(thread.threadId, () => this.prompt(thread, text, onProgress));
  }

  async queueMessageDuringActive(threadId: string, text: string, mode: "steer" | "followUp" = "steer"): Promise<QueueMessageResult> {
    const managed = this.runtimes.get(threadId);
    const session = managed?.runtime.session;
    if (!session?.isStreaming) return { queued: false };

    if (mode === "followUp") {
      await session.followUp(text);
    } else {
      await session.steer(text);
    }

    return {
      queued: true,
      mode,
      pendingMessageCount: session.pendingMessageCount,
    };
  }

  async enqueueReload(thread: ThreadRecord, onProgress?: PromptProgressHandler): Promise<void> {
    await this.enqueueOperation(thread.threadId, () => this.reload(thread, onProgress));
  }

  isActive(threadId: string): boolean {
    const managed = this.runtimes.get(threadId);
    return Boolean(this.queues.has(threadId) || managed?.runtime.session.isStreaming);
  }

  async abort(threadId: string): Promise<void> {
    const managed = this.runtimes.get(threadId);
    if (!managed) return;
    await managed.runtime.session.abort();
  }

  async disposeAll(): Promise<void> {
    const runtimes = [...this.runtimes.entries()];
    this.runtimes.clear();
    for (const [, managed] of runtimes) {
      if (managed.disposeTimer) clearTimeout(managed.disposeTimer);
      await managed.runtime.dispose();
    }
  }

  private async reload(thread: ThreadRecord, onProgress?: PromptProgressHandler): Promise<void> {
    this.publishProgress(onProgress, {
      phase: "tool",
      title: "Reloading Pi resources",
      detail: "Reloading settings, skills, prompts, extensions, and system prompt",
    });

    const managed = await this.getOrCreateRuntime(thread);
    await this.registry.patchThread(thread.threadId, { status: "running" });
    try {
      await managed.runtime.session.reload();
      await this.registry.patchThread(thread.threadId, {
        status: "idle",
        sessionFile: managed.runtime.session.sessionFile,
        sessionName: managed.runtime.session.sessionManager.getSessionName() ?? thread.sessionName,
      });
    } finally {
      this.scheduleDispose(thread.threadId, managed);
    }

    this.publishProgress(onProgress, {
      phase: "done",
      title: "Reloaded Pi resources",
    });
  }

  private async prompt(thread: ThreadRecord, text: string, onProgress?: PromptProgressHandler): Promise<PromptResult> {
    this.publishProgress(onProgress, {
      phase: "starting",
      title: "Starting Pi session",
      detail: thread.sessionFile ? "Rehydrating existing session" : "Creating a durable Pi session",
      sessionFile: thread.sessionFile,
    });

    const managed = await this.getOrCreateRuntime(thread);
    const session = managed.runtime.session;
    const beforeCount = session.sessionManager.getEntries().length;
    let assistantText = "";

    this.publishProgress(onProgress, {
      phase: "thinking",
      title: "Prompt accepted",
      detail: "Pi is preparing context and choosing tools",
      sessionFile: session.sessionFile,
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: "Agent running",
          detail: "Pi is reasoning over the prompt",
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: "Thinking",
          detail: "Reasoning stream is active",
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        assistantText += event.assistantMessageEvent.delta;
        this.publishProgress(onProgress, {
          phase: "streaming",
          title: "Writing response",
          textPreview: tail(assistantText, 700),
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "tool_execution_start") {
        const activity = describeToolUse(event.toolName, event.args);
        this.publishProgress(onProgress, {
          phase: "tool",
          title: activity.title,
          detail: activity.detail,
          toolName: event.toolName,
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "tool_execution_end") {
        this.publishProgress(onProgress, {
          phase: "tool",
          title: `${event.isError ? "Tool errored" : "Finished"}: ${event.toolName}`,
          toolName: event.toolName,
          isError: event.isError,
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "compaction_start") {
        this.publishProgress(onProgress, {
          phase: "compaction",
          title: "Compacting context",
          detail: event.reason,
          sessionFile: session.sessionFile,
        });
      }

      if (event.type === "auto_retry_start") {
        this.publishProgress(onProgress, {
          phase: "retry",
          title: `Retrying provider request (${event.attempt}/${event.maxAttempts})`,
          detail: event.errorMessage,
          sessionFile: session.sessionFile,
        });
      }
    });

    await this.registry.patchThread(thread.threadId, { status: "running" });
    try {
      await session.prompt(text);
    } finally {
      unsubscribe();
    }

    const sessionFile = session.sessionFile;
    const entryIds = this.getNewMessageEntryIds(session.sessionManager.getEntries(), beforeCount);
    await this.registry.patchThread(thread.threadId, {
      sessionFile,
      status: "idle",
      sessionName: session.sessionManager.getSessionName() ?? thread.sessionName,
    });
    this.scheduleDispose(thread.threadId, managed);

    const finalText = assistantText.trim() || session.getLastAssistantText() || "";
    this.publishProgress(onProgress, {
      phase: "done",
      title: "Done",
      textPreview: tail(finalText, 700),
      sessionFile,
    });

    return {
      text: finalText,
      sessionFile,
      userEntryId: entryIds.userEntryId,
      assistantEntryId: entryIds.assistantEntryId,
    };
  }

  private async getOrCreateRuntime(thread: ThreadRecord): Promise<ManagedRuntime> {
    const existing = this.runtimes.get(thread.threadId);
    if (existing) {
      this.scheduleDispose(thread.threadId, existing);
      return existing;
    }

    const sessionManager = thread.sessionFile
      ? SessionManager.open(thread.sessionFile)
      : SessionManager.create(thread.cwd, this.config.pi.sessionDir);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.agentDir,
        resourceLoaderOptions: {
          appendSystemPromptOverride: (base) => [...base, DISCORD_SYSTEM_PROMPT],
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: thread.cwd,
      agentDir: this.agentDir,
      sessionManager,
    });

    await runtime.session.bindExtensions({});

    if (!thread.sessionName) {
      runtime.session.setSessionName(`Discord ${thread.threadId}`);
    }

    const managed: ManagedRuntime = { runtime };
    this.runtimes.set(thread.threadId, managed);
    await this.registry.patchThread(thread.threadId, {
      sessionFile: runtime.session.sessionFile,
      sessionName: runtime.session.sessionManager.getSessionName() ?? thread.sessionName,
      status: "idle",
    });
    this.scheduleDispose(thread.threadId, managed);
    return managed;
  }

  private enqueueOperation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation);
    this.queues.set(threadId, next.finally(() => {
      if (this.queues.get(threadId) === next) {
        this.queues.delete(threadId);
      }
    }));
    return next;
  }

  private scheduleDispose(threadId: string, managed: ManagedRuntime): void {
    if (managed.disposeTimer) clearTimeout(managed.disposeTimer);
    managed.disposeTimer = setTimeout(() => {
      void this.disposeThread(threadId);
    }, this.config.pi.idleTtlMs);
    managed.disposeTimer.unref();
  }

  private async disposeThread(threadId: string): Promise<void> {
    const managed = this.runtimes.get(threadId);
    if (!managed) return;
    this.runtimes.delete(threadId);
    if (managed.disposeTimer) clearTimeout(managed.disposeTimer);
    await managed.runtime.dispose();
  }

  private publishProgress(handler: PromptProgressHandler | undefined, progress: PromptProgress): void {
    if (!handler) return;
    void Promise.resolve(handler(progress)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`progress handler failed: ${message}`);
    });
  }

  private getNewMessageEntryIds(entries: unknown[], beforeCount: number): { userEntryId?: string; assistantEntryId?: string } {
    const newEntries = entries.slice(beforeCount) as Array<{
      type?: string;
      id?: string;
      message?: { role?: string };
    }>;

    const userEntry = [...newEntries].reverse().find((entry) => entry.type === "message" && entry.message?.role === "user");
    const assistantEntry = [...newEntries]
      .reverse()
      .find((entry) => entry.type === "message" && entry.message?.role === "assistant");

    return {
      userEntryId: userEntry?.id,
      assistantEntryId: assistantEntry?.id,
    };
  }
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(value.length - maxChars)}`;
}

function describeToolUse(toolName: string, args: unknown): { title: string; detail?: string } {
  if (!args || typeof args !== "object") return { title: `Using ${toolName}` };
  const input = args as Record<string, unknown>;
  const path = typeof input.path === "string" ? shortenPath(input.path) : undefined;

  switch (toolName) {
    case "read":
      return { title: path ? `Reading ${path}` : "Reading file" };
    case "edit":
      return {
        title: path ? `Editing ${path}` : "Editing file",
        detail: Array.isArray(input.edits) ? `${input.edits.length} edit block(s)` : undefined,
      };
    case "write":
      return { title: path ? `Writing ${path}` : "Writing file" };
    case "bash": {
      const command = typeof input.command === "string" ? input.command.replace(/\s+/g, " ").trim() : "";
      const first = command.split(" ")[0] || "command";
      return { title: `Running ${first}`, detail: command ? tail(command, 180) : undefined };
    }
    case "web_search":
      return { title: "Searching web", detail: typeof input.query === "string" ? tail(input.query, 160) : undefined };
    case "url_to_markdown":
      return { title: "Reading web page", detail: typeof input.url === "string" ? tail(input.url, 160) : undefined };
    case "mcq":
      return { title: "Waiting for input" };
    case "workflow":
      return { title: "Running workflow" };
    default:
      if (path) return { title: `Using ${toolName}`, detail: path };
      if (typeof input.command === "string") return { title: `Using ${toolName}`, detail: tail(input.command.replace(/\s+/g, " ").trim(), 180) };
      return { title: `Using ${toolName}` };
  }
}

function shortenPath(path: string): string {
  const home = process.env.HOME || "";
  const normalized = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}
