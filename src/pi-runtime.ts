import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { InlineImageContent } from "./attachments.js";
import type { AppConfig } from "./config.js";
import { DISCORD_SYSTEM_PROMPT } from "./discord-system-prompt.js";
import type { Registry, ThreadRecord } from "./registry.js";
import type { RunFeedEvent } from "./run-hud.js";

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

export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  sessionFile: string | undefined;
}

interface PiCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

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

  async enqueuePrompt(thread: ThreadRecord, text: string, images: InlineImageContent[] = [], onProgress?: PromptProgressHandler): Promise<PromptResult> {
    return this.enqueueOperation(thread.threadId, () => this.prompt(thread, text, images, onProgress));
  }

  async queueMessageDuringActive(threadId: string, text: string, mode: "steer" | "followUp" = "steer", images: InlineImageContent[] = []): Promise<QueueMessageResult> {
    const managed = this.runtimes.get(threadId);
    const session = managed?.runtime.session;
    if (!session?.isStreaming) return { queued: false };

    if (mode === "followUp") {
      await session.followUp(text, images);
    } else {
      await session.steer(text, images);
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

  async enqueueCompact(thread: ThreadRecord, customInstructions?: string, onProgress?: PromptProgressHandler): Promise<CompactResult> {
    return this.enqueueOperation(thread.threadId, () => this.compact(thread, customInstructions, onProgress));
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

  private async compact(thread: ThreadRecord, customInstructions?: string, onProgress?: PromptProgressHandler): Promise<CompactResult> {
    const instructions = customInstructions?.trim() || undefined;
    this.publishProgress(onProgress, {
      phase: "compaction",
      title: "Compacting context",
      detail: instructions ? `Focus: ${instructions}` : "Creating a durable context checkpoint",
      sessionFile: thread.sessionFile,
    });

    const managed = await this.getOrCreateRuntime(thread);
    await this.registry.patchThread(thread.threadId, { status: "running" });
    try {
      const result = await managed.runtime.session.compact(instructions) as PiCompactionResult;
      const sessionFile = managed.runtime.session.sessionFile;
      await this.registry.patchThread(thread.threadId, {
        status: "idle",
        sessionFile,
        sessionName: managed.runtime.session.sessionManager.getSessionName() ?? thread.sessionName,
      });
      this.publishProgress(onProgress, {
        phase: "done",
        title: "Compacted context",
        detail: `${result.tokensBefore.toLocaleString()} tokens before compaction`,
        sessionFile,
      });
      return {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        sessionFile,
      };
    } catch (error) {
      await this.registry.patchThread(thread.threadId, {
        status: "idle",
        sessionFile: managed.runtime.session.sessionFile,
        sessionName: managed.runtime.session.sessionManager.getSessionName() ?? thread.sessionName,
      }).catch(() => undefined);
      throw error;
    } finally {
      this.scheduleDispose(thread.threadId, managed);
    }
  }

  private async prompt(thread: ThreadRecord, text: string, images: InlineImageContent[], onProgress?: PromptProgressHandler): Promise<PromptResult> {
    this.publishProgress(onProgress, {
      phase: "starting",
      title: "Starting Pi session",
      detail: thread.sessionFile ? "Rehydrating existing session" : "Creating a durable Pi session",
      sessionFile: thread.sessionFile,
      feedEvent: {
        type: "run_start",
        title: "Starting Pi session",
        detail: thread.sessionFile ? "Rehydrating existing session" : "Creating a durable Pi session",
        phase: "starting",
      },
    });

    const managed = await this.getOrCreateRuntime(thread);
    await this.reloadRuntimeAuth(managed);
    const authSnapshot = await this.getAuthFileSnapshot();
    const session = managed.runtime.session;
    if (repairDanglingAssistantLeaf(session.sessionManager)) {
      session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    }
    const beforeCount = session.sessionManager.getEntries().length;
    const beforeAssistantCount = countAssistantMessages(session.messages);
    let assistantText = "";

    this.publishProgress(onProgress, {
      phase: "thinking",
      title: "Prompt accepted",
      detail: "Pi is preparing context and choosing tools",
      sessionFile: session.sessionFile,
      feedEvent: {
        type: "prompt_accepted",
        title: "Prompt accepted",
        detail: "Pi is preparing context and choosing tools",
        phase: "thinking",
      },
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "session_info_changed") {
        void this.registry.patchThread(thread.threadId, {
          sessionName: event.name ?? thread.sessionName,
        }).catch(() => undefined);
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: event.name ? `Session: ${event.name}` : "Session renamed",
          detail: "Pi session name updated",
          sessionFile: session.sessionFile,
          sessionName: event.name,
          feedEvent: {
            type: "session_info_changed",
            title: event.name ? `Session: ${event.name}` : "Session renamed",
            detail: "Pi session name updated",
            phase: "thinking",
            data: { name: event.name },
          },
        });
      }

      if (event.type === "agent_start") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: "Agent running",
          detail: "Pi is reasoning over the prompt",
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "agent_start",
            title: "Agent running",
            detail: "Pi is reasoning over the prompt",
            phase: "thinking",
          },
        });
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: "Thinking",
          detail: "Reasoning stream is active",
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "thinking_delta",
            title: "Thinking",
            detail: "Reasoning stream is active",
            phase: "thinking",
            delta: String((event.assistantMessageEvent as { delta?: unknown }).delta ?? ""),
          },
        });
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        assistantText += event.assistantMessageEvent.delta;
        this.publishProgress(onProgress, {
          phase: "streaming",
          title: "Writing response",
          textPreview: tail(assistantText, 700),
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "text_delta",
            title: "Writing response",
            phase: "streaming",
            delta: event.assistantMessageEvent.delta,
            textPreview: tail(assistantText, 1_500),
          },
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
          feedEvent: {
            type: "tool_start",
            title: activity.title,
            detail: activity.detail,
            phase: "tool",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
          },
        });
      }

      if (event.type === "tool_execution_update") {
        this.publishProgress(onProgress, {
          phase: "tool",
          title: `Updating: ${event.toolName}`,
          toolName: event.toolName,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "tool_update",
            title: `Updating: ${event.toolName}`,
            phase: "tool",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            partialResult: event.partialResult,
          },
        });
      }

      if (event.type === "tool_execution_end") {
        this.publishProgress(onProgress, {
          phase: "tool",
          title: `${event.isError ? "Tool errored" : "Finished"}: ${event.toolName}`,
          toolName: event.toolName,
          isError: event.isError,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "tool_end",
            title: `${event.isError ? "Tool errored" : "Finished"}: ${event.toolName}`,
            phase: "tool",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            result: event.result,
            isError: event.isError,
          },
        });
      }

      if (event.type === "compaction_start") {
        this.publishProgress(onProgress, {
          phase: "compaction",
          title: "Compacting context",
          detail: event.reason,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "compaction_start",
            title: "Compacting context",
            detail: event.reason,
            phase: "compaction",
          },
        });
      }

      if (event.type === "auto_retry_start") {
        this.publishProgress(onProgress, {
          phase: "retry",
          title: `Retrying provider request (${event.attempt}/${event.maxAttempts})`,
          detail: event.errorMessage,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "auto_retry_start",
            title: `Retrying provider request (${event.attempt}/${event.maxAttempts})`,
            detail: event.errorMessage,
            phase: "retry",
            data: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
          },
        });
      }

      if (event.type === "queue_update") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: "Queued thread input",
          detail: `${event.steering.length} steering, ${event.followUp.length} follow-up`,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "queue_update",
            title: "Queued thread input",
            detail: `${event.steering.length} steering, ${event.followUp.length} follow-up`,
            data: { steering: event.steering, followUp: event.followUp },
          },
        });
      }

      if (event.type === "compaction_end") {
        this.publishProgress(onProgress, {
          phase: "compaction",
          title: event.aborted ? "Compaction aborted" : "Compaction finished",
          detail: event.errorMessage,
          isError: Boolean(event.errorMessage),
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "compaction_end",
            title: event.aborted ? "Compaction aborted" : "Compaction finished",
            detail: event.errorMessage,
            phase: "compaction",
            isError: Boolean(event.errorMessage),
            result: event.result,
            data: { aborted: event.aborted, willRetry: event.willRetry, reason: event.reason },
          },
        });
      }

      if (event.type === "auto_retry_end") {
        this.publishProgress(onProgress, {
          phase: "retry",
          title: event.success ? "Provider retry recovered" : "Provider retry failed",
          detail: event.finalError,
          isError: !event.success,
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "auto_retry_end",
            title: event.success ? "Provider retry recovered" : "Provider retry failed",
            detail: event.finalError,
            phase: "retry",
            isError: !event.success,
            data: { attempt: event.attempt, success: event.success },
          },
        });
      }

      if (event.type === "agent_end") {
        this.publishProgress(onProgress, {
          phase: "thinking",
          title: event.willRetry ? "Agent turn ended; retry pending" : "Agent turn ended",
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "agent_end",
            title: event.willRetry ? "Agent turn ended; retry pending" : "Agent turn ended",
            data: { willRetry: event.willRetry, messages: event.messages },
          },
        });
      }
    });

    const runPatch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">> = {
      status: "running",
      sessionFile: session.sessionFile,
    };
    const currentRecord = this.registry.getThread(thread.threadId);
    if (currentRecord?.activeRun) {
      runPatch.activeRun = {
        ...currentRecord.activeRun,
        sessionFile: session.sessionFile,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.registry.patchThread(thread.threadId, runPatch);
    try {
      await session.prompt(text, images.length > 0 ? { images } : undefined);
    } finally {
      unsubscribe();
      this.scheduleDispose(thread.threadId, managed);
    }

    const assistantError = getNewAssistantError(session.messages, beforeAssistantCount);
    if (assistantError) {
      const authSnapshotAfterError = await this.getAuthFileSnapshot();
      if (isOpenAiOAuthInvalidation(assistantError) && authSnapshot && authSnapshotAfterError && authSnapshotAfterError !== authSnapshot) {
        this.publishProgress(onProgress, {
          phase: "retry",
          title: "OpenAI auth changed; retrying",
          detail: "Reloading Pi auth from disk after OAuth refresh",
          sessionFile: session.sessionFile,
          feedEvent: {
            type: "auto_retry_start",
            title: "OpenAI auth changed; retrying",
            detail: "Reloading Pi auth from disk after OAuth refresh",
            phase: "retry",
            data: { reason: "openai_oauth_refreshed" },
          },
        });
        await this.reloadRuntimeAuth(managed);
        return this.prompt(thread, text, images, onProgress);
      }
      throw new Error(formatAssistantRunError(assistantError));
    }

    const sessionFile = session.sessionFile;
    const entryIds = this.getNewMessageEntryIds(session.sessionManager.getEntries(), beforeCount);
    await this.registry.patchThread(thread.threadId, {
      sessionFile,
      status: "idle",
      activeRun: undefined,
      sessionName: session.sessionManager.getSessionName() ?? thread.sessionName,
    });

    const finalText = assistantText.trim() || session.getLastAssistantText() || "";
    this.publishProgress(onProgress, {
      phase: "done",
      title: "Done",
      textPreview: tail(finalText, 700),
      sessionFile,
      feedEvent: {
        type: "run_done",
        title: "Done",
        phase: "done",
        textPreview: tail(finalText, 1_500),
      },
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
    const additionalExtensionPaths = [...new Set(
      (thread.extensionPaths ?? [])
        .map((extensionPath) => extensionPath.trim())
        .filter(Boolean),
    )];

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.agentDir,
        resourceLoaderOptions: {
          additionalExtensionPaths,
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
    const queued = next.finally(() => {
      if (this.queues.get(threadId) === queued) {
        this.queues.delete(threadId);
      }
    });
    this.queues.set(threadId, queued);
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

  private async reloadRuntimeAuth(managed: ManagedRuntime): Promise<void> {
    managed.runtime.services.authStorage.reload();
  }

  private async getAuthFileSnapshot(): Promise<string | undefined> {
    try {
      const stats = await stat(join(this.agentDir, "auth.json"));
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return undefined;
    }
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

type AssistantMessageLike = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function countAssistantMessages(messages: unknown[]): number {
  return messages.filter((message) => (message as AssistantMessageLike).role === "assistant").length;
}

function repairDanglingAssistantLeaf(sessionManager: SessionManager): boolean {
  const leaf = sessionManager.getLeafEntry();
  if (!leaf || leaf.type !== "message" || leaf.message.role !== "assistant") return false;
  if (leaf.message.stopReason === "stop") return false;
  if (leaf.parentId) {
    sessionManager.branch(leaf.parentId);
  } else {
    sessionManager.resetLeaf();
  }
  return true;
}

function getNewAssistantError(messages: unknown[], beforeAssistantCount: number): string | undefined {
  const assistants = messages.filter((message) => (message as AssistantMessageLike).role === "assistant") as AssistantMessageLike[];
  const newAssistants = assistants.slice(beforeAssistantCount);
  const error = [...newAssistants].reverse().find((message) => message.stopReason === "error");
  if (!error) return undefined;
  const contentText = (error.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();
  return error.errorMessage?.trim() || contentText || "Pi provider returned an error without details.";
}

function isOpenAiOAuthInvalidation(message: string): boolean {
  return /authentication token has been invalidated|try signing in again|invalidated.*token/i.test(message);
}

function formatAssistantRunError(message: string): string {
  if (isOpenAiOAuthInvalidation(message)) {
    return [
      "OpenAI OAuth rejected this Pi run: the token was invalidated by a global logout.",
      "The Discord bridge reloads `~/.pi/agent/auth.json` before every run, so after logging in with Pi you can retry from Discord without restarting the daemon.",
      `Provider error: ${message}`,
    ].join("\n\n");
  }
  return `Pi provider error: ${message}`;
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
