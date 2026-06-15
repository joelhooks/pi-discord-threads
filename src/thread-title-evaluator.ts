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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ThreadTitleTurnEvidence {
  user: string;
  assistant: string;
  createdAt: string;
}

export interface ThreadTitleEvaluationInput {
  cwd: string;
  agentDir?: string;
  model: string;
  currentTitle: string;
  workspaceName?: string;
  turnCount: number;
  recentTurns: ThreadTitleTurnEvidence[];
}

export interface ThreadTitleProposal {
  shouldRename: boolean;
  title?: string;
  confidence?: number;
  reason?: string;
}

const ThreadTitleProposalSchema = Type.Object({
  shouldRename: Type.Boolean({ description: "True only when the current Discord thread title is stale or misleading enough to update." }),
  title: Type.Optional(Type.String({ description: "Proposed Discord thread title, including one useful category emoji when renaming." })),
  confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1 that this rename improves durable thread findability." })),
  reason: Type.Optional(Type.String({ description: "Concise operator-facing reason for the rename decision." })),
});

export async function evaluateThreadTitle(input: ThreadTitleEvaluationInput): Promise<ThreadTitleProposal | undefined> {
  const agentDir = input.agentDir ?? getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const [provider, ...modelParts] = input.model.split("/");
  const modelId = modelParts.join("/");
  const model = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
  if (!model) throw new Error(`Thread title evaluator model not found: ${input.model}`);

  let proposal: ThreadTitleProposal | undefined;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });

  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => THREAD_TITLE_EVALUATOR_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const proposeThreadTitleTool = defineTool({
    name: "propose_thread_title",
    label: "Propose Thread Title",
    description: "Return the thread-title decision. This is your only job.",
    parameters: ThreadTitleProposalSchema,
    execute: async (_toolCallId, params) => {
      proposal = normalizeProposal(params);
      return {
        content: [{ type: "text", text: "Thread title proposal recorded." }],
        details: proposal,
      };
    },
  });

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "minimal",
    tools: ["propose_thread_title"],
    customTools: [proposeThreadTitleTool],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
  });

  try {
    await session.prompt(buildThreadTitlePrompt(input), { expandPromptTemplates: false });
    return proposal;
  } finally {
    await session.abort().catch(() => undefined);
    session.dispose();
  }
}

function normalizeProposal(input: ThreadTitleProposal): ThreadTitleProposal {
  const shouldRename = input.shouldRename === true;
  const title = input.title ? normalizeTitle(input.title) : undefined;
  const confidence = Number.isFinite(input.confidence) ? clamp(Number(input.confidence), 0, 1) : undefined;
  return {
    shouldRename: shouldRename && Boolean(title),
    ...(title ? { title } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(input.reason ? { reason: String(input.reason).trim().slice(0, 220) } : {}),
  };
}

export function normalizeTitle(value: string): string {
  return value
    .replace(/<@!?\d+>/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 95)
    .trim();
}

function buildThreadTitlePrompt(input: ThreadTitleEvaluationInput): string {
  const payload = {
    currentTitle: input.currentTitle,
    workspaceName: input.workspaceName,
    cwd: input.cwd,
    turnCount: input.turnCount,
    recentTurns: input.recentTurns.map((turn) => ({
      createdAt: turn.createdAt,
      user: clipString(turn.user, 900),
      assistant: clipString(turn.assistant, 900),
    })),
  };

  return [
    "Evaluate whether this Discord thread title should be renamed.",
    "Call propose_thread_title exactly once. Do not answer with prose.",
    "Rename only when the current title is stale, misleading, placeholder-ish, or the durable theme has materially changed.",
    "Do not chase transient substeps, tool names, current status, exact file paths, elapsed time, or tiny implementation details.",
    "Good titles are 3-7 words, mobile-readable, useful after the run completes, and may start with one category emoji.",
    "Prefer category emoji semantics: 🗂️ setup, ✨ implementation, 🐛 debugging, 🔎 research/review, 📚 docs/plans, 🧪 tests, 🚀 deploy/publish, 🧹 cleanup, 💬 Discord/thread work, π general Pi.",
    "If the current title is still good enough, set shouldRename false.",
    "Evidence JSON:",
    safeJson(payload),
  ].join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify(String(value));
  }
}

function clipString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keptChars = Math.max(0, maxChars - 20);
  return `${value.slice(0, keptChars)}\n…[truncated ${value.length - keptChars} chars]`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const THREAD_TITLE_EVALUATOR_SYSTEM_PROMPT = `You are the Discord thread title evaluator for Pi.

You are not the coding agent. You do not solve the user's task. You have exactly one job: call propose_thread_title with a conservative rename decision for the Discord thread.

Discord thread titles are durable labels for async operator work. They should describe the broad workstream or theme, not the initial prompt fragment and not the current tool/status.

Important boundaries:
- Evaluate Discord thread titles independently from Pi session names.
- Prefer no rename unless the evidence shows a better durable theme.
- Preserve human intent. Do not overwrite a good explicit title.
- Never include private local paths, IDs, secrets, raw prompt fragments, or bridge internals.
- Keep the title compact: one useful emoji plus 3-7 words is ideal.

Call propose_thread_title exactly once. Do not produce normal assistant prose.`;
