import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chunkForDiscord } from "../render.js";
import type { RegistryPort, ThreadRecord } from "../registry.js";

export type StopAsyncSubagentResultBridge = () => void;

export interface AsyncSubagentResultBridgeOptions {
  registry: RegistryPort;
  maxDiscordChars: number;
  publish(record: ThreadRecord, chunks: string[]): Promise<void>;
  resultsDir?: string;
  scanIntervalMs?: number;
  warn?: (message: string) => void;
}

export interface AsyncSubagentResultFile {
  id?: string;
  runId?: string;
  agent?: string;
  mode?: string;
  success?: boolean;
  state?: string;
  summary?: string;
  timestamp?: number;
  durationMs?: number;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  asyncDir?: string;
  results?: Array<{
    agent?: string;
    output?: string;
    error?: string;
    success?: boolean;
    sessionFile?: string;
  }>;
}

interface ResolvedAsyncSubagentResultBridgeOptions extends AsyncSubagentResultBridgeOptions {
  resultsDir: string;
  warn: (message: string) => void;
}

export function startAsyncSubagentResultBridge(options: AsyncSubagentResultBridgeOptions): StopAsyncSubagentResultBridge {
  const resolved = resolveOptions(options);
  const seen = new Set<string>();
  let scanning = false;

  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const files = await readdir(resolved.resultsDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      await Promise.all(files
        .filter((file) => file.endsWith(".json"))
        .map((file) => processAsyncSubagentResultFile(resolved, file, seen)));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      resolved.warn(`async subagent Discord bridge scan failed: ${text}`);
    } finally {
      scanning = false;
    }
  };

  void scan();
  const interval = setInterval(() => void scan(), options.scanIntervalMs ?? 3_000);
  interval.unref();
  return () => clearInterval(interval);
}

export async function processAsyncSubagentResultFile(
  options: AsyncSubagentResultBridgeOptions,
  file: string,
  seen: Set<string> = new Set(),
): Promise<void> {
  const resolved = resolveOptions(options);
  const resultPath = join(resolved.resultsDir, file);
  let parsed: AsyncSubagentResultFile;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8")) as AsyncSubagentResultFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    resolved.warn(`failed to read async subagent result ${resultPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const runId = parsed.runId ?? parsed.id ?? basename(file, ".json");
  const seenKey = asyncSubagentSeenKey(parsed, runId);
  if (seen.has(seenKey)) return;

  const record = findThreadForAsyncSubagentResult(resolved.registry, parsed);
  if (!record) return;
  seen.add(seenKey);

  try {
    const content = formatAsyncSubagentResultMessage(parsed, runId);
    const chunks = chunkForDiscord(content, resolved.maxDiscordChars);
    await resolved.publish(record, chunks);
    await unlink(resultPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  } catch (error) {
    seen.delete(seenKey);
    const text = error instanceof Error ? error.message : String(error);
    resolved.warn(`failed to publish async subagent result ${runId} to Discord: ${text}`);
  }
}

export function findThreadForAsyncSubagentResult(registry: RegistryPort, result: AsyncSubagentResultFile): ThreadRecord | undefined {
  const sessionId = result.sessionId?.trim();
  const sessionFile = result.sessionFile?.trim();
  const candidates = registry.listThreads().filter((record) => {
    const knownSessionFiles = [record.sessionFile, record.activeRun?.sessionFile].filter(Boolean);
    if (sessionId && knownSessionFiles.includes(sessionId)) return true;
    if (sessionFile && knownSessionFiles.includes(sessionFile)) return true;
    return false;
  });

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find((record) => record.status === "running") ?? candidates[0];
  }
  return undefined;
}

export function formatAsyncSubagentResultMessage(result: AsyncSubagentResultFile, runId: string): string {
  const status = result.state === "paused"
    ? "paused"
    : result.success === false || result.state === "failed"
      ? "failed"
      : "completed";
  const icon = status === "completed" ? "✅" : status === "paused" ? "⏸️" : "❌";
  const agent = result.agent ?? inferAsyncSubagentAgent(result) ?? "subagent";
  const summary = formatAsyncSubagentSummary(result);
  const duration = typeof result.durationMs === "number" ? ` · ${formatElapsed(result.durationMs)}` : "";
  return [
    `${icon} Background subagent ${status}: **${truncateForDiscordLine(agent, 120)}**`,
    `-# run ${runId}${duration}`,
    "",
    summary,
  ].join("\n").trim();
}

export function inferAsyncSubagentAgent(result: AsyncSubagentResultFile): string | undefined {
  if (!result.results?.length) return undefined;
  if (result.results.length === 1) return result.results[0]?.agent;
  return result.mode === "parallel"
    ? `parallel:${result.results.map((item) => item.agent ?? "subagent").join("+")}`
    : `chain:${result.results.map((item) => item.agent ?? "subagent").join("->")}`;
}

export function formatAsyncSubagentSummary(result: AsyncSubagentResultFile): string {
  const summary = result.summary?.trim();
  if (summary) return summary;
  const children = result.results ?? [];
  if (children.length === 0) return "(no output)";
  return children.map((child, index) => {
    const label = child.agent ?? `step-${index + 1}`;
    const body = child.success === false && child.error
      ? `${child.error}${child.output ? `\n\n${child.output}` : ""}`
      : child.output ?? child.error ?? "(no output)";
    return `**${label}**\n${body}`;
  }).join("\n\n");
}

export function resolveSubagentResultsDir(): string {
  return join(tmpdir(), `pi-subagents-${resolveTempScopeId()}`, "async-subagent-results");
}

export function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return home ? `home-${sanitizeTempScopeSegment(home)}` : "shared";
}

export function sanitizeTempScopeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function truncateForDiscordLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function asyncSubagentSeenKey(result: AsyncSubagentResultFile, runId: string): string {
  return `${runId}:${result.timestamp ?? "unknown"}:${result.sessionId ?? result.cwd ?? "unknown"}`;
}

function resolveOptions(options: AsyncSubagentResultBridgeOptions): ResolvedAsyncSubagentResultBridgeOptions {
  return {
    ...options,
    resultsDir: options.resultsDir ?? resolveSubagentResultsDir(),
    warn: options.warn ?? ((message: string) => console.warn(message)),
  };
}
