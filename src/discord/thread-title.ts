import type { ThreadChannel } from "discord.js";
import type { AppConfig } from "../config.js";
import type { RegistryPort, ThreadRecord, ThreadTitleState } from "../registry.js";
import { summarizeForThreadName } from "../render.js";
import { evaluateThreadTitle, normalizeTitle } from "../thread-title-evaluator.js";

const MAX_TITLE_EVIDENCE_TURNS = 12;
const TITLE_RENAME_CONFIDENCE_FLOOR = 0.72;

type ThreadTitleConfig = AppConfig["render"]["threadTitles"];

export async function maybeRenameThreadForPrompt(thread: ThreadChannel, record: ThreadRecord, prompt: string, registry: RegistryPort): Promise<void> {
  const desired = summarizeForThreadName(prompt);
  if (!shouldRenameThread(thread.name, desired)) return;
  const renamed = await thread.setName(desired, "Update Pi thread name from current task").then(() => true).catch(() => false);
  if (renamed) await registry.patchThread(record.threadId, { sessionName: desired }).catch(() => undefined);
}

export function shouldRenameThread(currentName: string, desiredName: string): boolean {
  if (!desiredName || currentName === desiredName) return false;
  const normalized = currentName.toLowerCase().trim();
  return normalized === "pi session"
    || normalized === "pi: pi session"
    || normalized === "π pi session"
    || normalized.startsWith("pi: workspace ")
    || normalized.startsWith("pi: fork of ")
    || normalized.startsWith("pi: resume ")
    || normalized.startsWith("🗂️ workspace ")
    || normalized.startsWith("π fork of ")
    || normalized.startsWith("π resume ");
}

export async function recordCompletedTitleTurn(registry: RegistryPort, record: ThreadRecord, userText: string, assistantText: string): Promise<ThreadRecord> {
  const latest = registry.getThread(record.threadId) ?? record;
  const previous: ThreadTitleState = latest.titleState ?? { turnCount: 0, recentTurns: [] };
  const nextState: ThreadTitleState = {
    ...previous,
    turnCount: previous.turnCount + 1,
    recentTurns: [
      ...previous.recentTurns,
      {
        user: clipTitleEvidence(userText),
        assistant: clipTitleEvidence(assistantText),
        createdAt: new Date().toISOString(),
      },
    ].slice(-MAX_TITLE_EVIDENCE_TURNS),
  };
  return registry.patchThread(record.threadId, { titleState: nextState }).catch(() => ({ ...latest, titleState: nextState }));
}

export async function maybeEvaluateThreadTitle(
  thread: ThreadChannel | undefined,
  record: ThreadRecord,
  options: {
    config: AppConfig;
    registry: RegistryPort;
    warn?: (message: string) => void;
  },
): Promise<void> {
  const config = options.config.render.threadTitles;
  if (!config.enabled) return;
  if (!thread) return;
  const state = record.titleState;
  if (!state || !shouldEvaluateThreadTitle(state, config)) return;

  const warn = options.warn ?? ((message: string) => console.warn(message));
  const evaluatedState: ThreadTitleState = {
    ...state,
    lastEvaluatedTurn: state.turnCount,
  };

  let proposal;
  try {
    proposal = await evaluateThreadTitle({
      cwd: record.cwd,
      agentDir: options.config.pi.agentDir,
      model: config.model,
      currentTitle: thread.name,
      workspaceName: record.workspaceName,
      turnCount: state.turnCount,
      recentTurns: state.recentTurns,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    warn(`thread title evaluator failed for ${record.threadId}: ${text}`);
    await options.registry.patchThread(record.threadId, { titleState: evaluatedState }).catch(() => undefined);
    return;
  }

  const desired = proposal?.title ? normalizeTitle(proposal.title) : undefined;
  if (!proposal?.shouldRename || !desired || !shouldApplyThreadTitleProposal(thread.name, desired, state, config, proposal.confidence)) {
    await options.registry.patchThread(record.threadId, { titleState: evaluatedState }).catch(() => undefined);
    return;
  }

  const renamed = await thread.setName(desired, `Pi thread title evaluator: ${proposal.reason ?? "theme update"}`).then(() => true).catch((error) => {
    const text = error instanceof Error ? error.message : String(error);
    warn(`failed to rename Discord thread ${record.threadId}: ${text}`);
    return false;
  });
  const nextState: ThreadTitleState = renamed
    ? {
      ...evaluatedState,
      lastRenamedTurn: state.turnCount,
      lastRenamedAt: new Date().toISOString(),
      lastSuggestedTitle: desired,
    }
    : evaluatedState;
  await options.registry.patchThread(record.threadId, {
    titleState: nextState,
    ...(renamed ? { sessionName: desired } : {}),
  }).catch(() => undefined);
}

export function shouldEvaluateThreadTitle(state: ThreadTitleState, config: ThreadTitleConfig): boolean {
  if (state.turnCount < config.firstEvaluationTurn) return false;
  if (!state.lastEvaluatedTurn) return true;
  return state.turnCount - state.lastEvaluatedTurn >= config.evaluationIntervalTurns;
}

export function shouldApplyThreadTitleProposal(
  currentName: string,
  desiredName: string,
  state: ThreadTitleState,
  config: ThreadTitleConfig,
  confidence: number | undefined,
): boolean {
  if (!desiredName || currentName.trim() === desiredName.trim()) return false;
  if ((confidence ?? 1) < TITLE_RENAME_CONFIDENCE_FLOOR) return false;
  if (!isBridgeManagedThreadTitle(currentName, state)) return false;
  if (state.lastRenamedAt && Date.now() - Date.parse(state.lastRenamedAt) < config.minRenameIntervalMs) return false;
  return true;
}

export function isBridgeManagedThreadTitle(currentName: string, state: ThreadTitleState): boolean {
  const normalized = currentName.trim();
  if (!normalized) return true;
  if (state.lastSuggestedTitle && normalized === state.lastSuggestedTitle) return true;
  return /^(🗂️|✨|🐛|🔎|📚|🧪|🚀|🧹|💬|π)\s/.test(normalized)
    || /^(pi|π)( session|:)/i.test(normalized);
}

export function clipTitleEvidence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 1_500) return compact;
  return `${compact.slice(0, 1_480)} …[truncated ${compact.length - 1_480} chars]`;
}
