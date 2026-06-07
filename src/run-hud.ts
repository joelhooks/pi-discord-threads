import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface RunFeedEvent {
  type: string;
  title?: string;
  detail?: string;
  phase?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  delta?: string;
  textPreview?: string;
  data?: unknown;
}

export interface RunHudFrame {
  header: string;
  now: string;
  progress: string[];
  signals?: string;
  risk?: string;
  next?: string;
}

export interface RunHudNarratorOptions {
  cwd: string;
  agentDir?: string;
  model: string;
  updateIntervalMs: number;
  onFrame: (frame: RunHudFrame, options?: { immediate?: boolean }) => void;
  onError?: (error: Error) => void;
}

interface TimedRunFeedEvent extends RunFeedEvent {
  elapsedMs: number;
}

const MAX_FEED_EVENTS = 200;
const PROMPT_FEED_EVENTS = 80;

const HudFrameSchema = Type.Object({
  header: Type.String({ description: "Broad current status of the run, not a raw tool name. Keep under 70 chars." }),
  now: Type.String({ description: "What is happening right now, in human terms. Keep under 90 chars." }),
  progress: Type.Array(Type.String({ description: "One concise completed/current progress item." }), {
    minItems: 1,
    maxItems: 3,
    description: "Three stable journal lines. Use ✓ for completed items and → for the active thread of work.",
  }),
  signals: Type.Optional(Type.String({ description: "Compact signals: touched files, checks, model/tool state, or evidence." })),
  risk: Type.Optional(Type.String({ description: "Current risk, caveat, or thing being watched. Omit if none." })),
  next: Type.Optional(Type.String({ description: "Likely next step if more useful than risk. Omit if risk is present." })),
});

export class RunHudNarrator {
  private readonly agentDir: string;
  private readonly events: TimedRunFeedEvent[] = [];
  private session: AgentSession | undefined;
  private initPromise: Promise<AgentSession | undefined> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private prompting = false;
  private pending = false;
  private disposed = false;
  private startedAt = Date.now();
  private lastPromptAt = 0;
  private disabledUntil = 0;
  private latestFrame: RunHudFrame | undefined;

  constructor(private readonly options: RunHudNarratorOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
  }

  start(initial?: RunFeedEvent): void {
    this.startedAt = Date.now();
    if (initial) this.record(initial, { immediate: true });
  }

  record(event: RunFeedEvent, options: { immediate?: boolean } = {}): void {
    if (this.disposed) return;
    this.events.push({ ...event, elapsedMs: Date.now() - this.startedAt });
    if (this.events.length > MAX_FEED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_FEED_EVENTS);
    }
    this.schedule(options.immediate === true || isMajorEvent(event) ? 0 : this.options.updateIntervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const session = this.session;
    this.session = undefined;
    if (session) {
      void session.abort().catch(() => undefined).finally(() => session.dispose());
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now < this.disabledUntil) return;
    const earliest = this.lastPromptAt + this.options.updateIntervalMs;
    const dueIn = delayMs === 0 ? Math.max(0, earliest - now) : Math.max(delayMs, earliest - now);
    if (this.timer) {
      if (delayMs !== 0) return;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.narrate();
    }, dueIn);
    this.timer.unref();
  }

  private async narrate(): Promise<void> {
    if (this.disposed) return;
    if (this.prompting) {
      this.pending = true;
      return;
    }

    this.prompting = true;
    this.pending = false;
    this.lastPromptAt = Date.now();

    try {
      const session = await this.getSession();
      if (!session || this.disposed) return;
      session.agent.state.messages = [];
      await session.prompt(this.buildPrompt(), { expandPromptTemplates: false });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.disabledUntil = Date.now() + 15_000;
      this.options.onError?.(normalized);
    } finally {
      this.prompting = false;
      if (this.pending && !this.disposed) this.schedule(this.options.updateIntervalMs);
    }
  }

  private async getSession(): Promise<AgentSession | undefined> {
    if (this.session) return this.session;
    if (!this.initPromise) this.initPromise = this.createSession();
    const session = await this.initPromise;
    if (this.disposed) {
      if (session) {
        void session.abort().catch(() => undefined).finally(() => session.dispose());
      }
      return undefined;
    }
    this.session = session;
    return this.session;
  }

  private async createSession(): Promise<AgentSession | undefined> {
    const authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, join(this.agentDir, "models.json"));
    const [provider, ...modelParts] = this.options.model.split("/");
    const modelId = modelParts.join("/");
    const model = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
    if (!model) {
      this.options.onError?.(new Error(`Run HUD model not found: ${this.options.model}`));
      return undefined;
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const loader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => HUD_NARRATOR_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const setRunHudTool = defineTool({
      name: "set_run_hud",
      label: "Set Run HUD",
      description: "Update the active Discord run HUD for this run. This is your only job.",
      parameters: HudFrameSchema,
      execute: async (_toolCallId, params) => {
        const frame = normalizeFrame(params);
        this.latestFrame = frame;
        this.options.onFrame(frame, { immediate: isAttentionFrame(frame) });
        return {
          content: [{ type: "text", text: "Run HUD updated." }],
          details: frame,
        };
      },
    });

    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "minimal",
      tools: ["set_run_hud"],
      customTools: [setRunHudTool],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.options.cwd),
      settingsManager,
    });

    return session;
  }

  private buildPrompt(): string {
    const payload = {
      elapsedMs: Date.now() - this.startedAt,
      previousFrame: this.latestFrame,
      liveRunFeed: this.events.slice(-PROMPT_FEED_EVENTS).map((event) => boundValue(event)),
    };

    return [
      "Update the Discord Run HUD now.",
      "Call set_run_hud exactly once. Do not answer with prose.",
      "Do not recap the user's prompt. Describe the work being done, progress made, and current state.",
      "Keep the frame stable: only change the header when the broad work changes.",
      "Prefer useful intelligent summaries over raw event names. Be specific when the feed supports it.",
      "Use compact operator-facing language. No markdown code fences.",
      "Live feed JSON:",
      safeJson(payload),
    ].join("\n");
  }
}

export function fallbackHudFrame(progress: {
  title: string;
  detail?: string;
  phase?: string;
  toolName?: string;
  textPreview?: string;
  isError?: boolean;
}): RunHudFrame {
  const active = progress.textPreview
    ? "drafting the visible assistant response"
    : progress.detail || progress.title || "working";
  return {
    header: progress.isError ? "Run needs attention" : broadFallbackHeader(progress.phase, progress.toolName),
    now: active,
    progress: [
      "✓ run accepted by Pi",
      progress.toolName ? `→ using ${progress.toolName}` : `→ ${progress.title}`,
      progress.textPreview ? "· response text is streaming" : "· waiting for more live events",
    ],
    signals: progress.toolName ? `tool: ${progress.toolName}` : "live events active",
    risk: progress.isError ? "latest event reported an error" : undefined,
    next: progress.isError ? undefined : "continuing until final answer is ready",
  };
}

function normalizeFrame(input: RunHudFrame): RunHudFrame {
  const progress = Array.isArray(input.progress)
    ? input.progress.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : [];
  return {
    header: String(input.header || "Pi is working").trim() || "Pi is working",
    now: String(input.now || "working through the task").trim() || "working through the task",
    progress: progress.length > 0 ? progress : ["→ working"],
    signals: input.signals ? String(input.signals).trim() : undefined,
    risk: input.risk ? String(input.risk).trim() : undefined,
    next: input.next ? String(input.next).trim() : undefined,
  };
}

function isMajorEvent(event: RunFeedEvent): boolean {
  return event.isError === true
    || event.type === "run_start"
    || event.type === "agent_start"
    || event.type === "tool_end"
    || event.type === "compaction_start"
    || event.type === "auto_retry_start"
    || event.type === "queue_update";
}

function isAttentionFrame(frame: RunHudFrame): boolean {
  const text = `${frame.header} ${frame.now} ${frame.risk ?? ""}`.toLowerCase();
  return /error|failed|blocked|waiting|input|retry|aborted|attention/.test(text);
}

function broadFallbackHeader(phase: string | undefined, toolName: string | undefined): string {
  if (toolName) return "Working with project tools";
  switch (phase) {
    case "starting":
      return "Starting Pi run";
    case "thinking":
      return "Reasoning through the task";
    case "streaming":
      return "Writing the response";
    case "compaction":
      return "Compacting context";
    case "retry":
      return "Retrying provider request";
    default:
      return "Pi is working";
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(boundValue(String(value)), null, 2);
  }
}

function boundValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return clipString(value, depth === 0 ? 4_000 : 1_500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= 5) return "[max depth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, 30).map((item) => boundValue(item, depth + 1, seen));
    if (value.length > 30) items.push(`[${value.length - 30} more items]`);
    return items;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
  for (const [key, item] of entries) {
    output[key] = boundValue(item, depth + 1, seen);
  }
  const totalKeys = Object.keys(value as Record<string, unknown>).length;
  if (totalKeys > entries.length) output.__omittedKeys = totalKeys - entries.length;
  return output;
}

function clipString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keptChars = Math.max(0, maxChars - 20);
  return `${value.slice(0, keptChars)}\n…[truncated ${value.length - keptChars} chars]`;
}

const HUD_NARRATOR_SYSTEM_PROMPT = `You are the live Discord Run HUD narrator for Pi.

You are not the coding agent. You do not solve the user's task. You have exactly one job: call set_run_hud with the next fixed-height status frame for the active Discord placeholder.

You may use the full live run feed provided by the bridge. Turn that feed into useful operator awareness:
- broad current status in header
- what is happening now
- a compact, stable progress journal
- signals such as files touched, checks run, tool/model state, or evidence
- a risk/caveat only when useful

Do not recap the user's prompt. Do not dump raw JSON. Do not mention private bridge internals unless they matter to the work. Do not produce normal assistant prose; call set_run_hud exactly once.

The bridge controls fixed-height rendering. You control the intelligent language inside the semantic fields.`;
