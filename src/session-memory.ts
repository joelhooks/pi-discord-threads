import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import type { AppConfig, SessionMemoryConfig } from "./config.js";
import type { ThreadRecord } from "./registry.js";

export interface SessionMemoryLink {
  label: string;
  brainPath: string;
  routePath: string;
  workstreamId: string;
  dataPath?: string;
  url?: string;
  verified: boolean;
  verificationStatus: "not_configured" | "verified" | "unverified" | "missing_brain" | "disabled";
  verificationError?: string;
  summary?: string;
}

interface SessionMemoryTurnRecord {
  createdAt: string;
  runId?: string;
  userEntryId?: string;
  assistantEntryId?: string;
  promptSummary: string;
  assistantSummary: string;
  sessionFile?: string;
}

interface SessionMemoryWorkstreamRecord {
  schemaVersion: 1;
  workstreamId: string;
  label: string;
  source: {
    kind: "discord-thread" | "discord-dm-workroom" | "unknown";
    threadKey: string;
    workspaceName?: string;
    cwdName: string;
  };
  portal: {
    brainPath: string;
    routePath: string;
  };
  createdAt: string;
  updatedAt: string;
  lastSummary: string;
  turns: SessionMemoryTurnRecord[];
}

interface SessionMemoryIndexRecord {
  schemaVersion: 1;
  updatedAt: string;
  portalBrainPath: string;
  portalRoutePath: string;
  workstreams: Array<{
    workstreamId: string;
    label: string;
    dataPath: string;
    brainPath: string;
    routePath: string;
    updatedAt: string;
    lastSummary: string;
  }>;
}

export interface WriteSessionMemoryInput {
  config: AppConfig;
  record: ThreadRecord;
  prompt: string;
  resultText: string;
  runId?: string;
  userEntryId?: string;
  assistantEntryId?: string;
}

export async function writeSessionMemory(input: WriteSessionMemoryInput): Promise<SessionMemoryLink | undefined> {
  const memoryConfig = input.config.render.sessionMemory;
  if (memoryConfig.enabled === false) {
    return buildDisabledLink(input.record, memoryConfig);
  }

  const brainRoot = join(input.record.cwd, ".brain");
  if (!existsSync(brainRoot)) return undefined;

  const portalBrainPath = normalizeBrainPath(memoryConfig.portalBrainPath);
  const portalFullPath = join(input.record.cwd, portalBrainPath);
  const routePath = brainPathToNotesRoute(portalBrainPath);
  if (!existsSync(portalFullPath)) {
    return {
      label: "Project Memory Portal",
      brainPath: portalBrainPath,
      routePath,
      workstreamId: createWorkstreamId(input.record),
      verified: false,
      verificationStatus: "missing_brain",
      verificationError: "Portal Brain page is missing",
      summary: summarizeForMemoryCard(input.resultText),
    };
  }

  const now = new Date().toISOString();
  const workstreamId = createWorkstreamId(input.record);
  const label = createWorkstreamLabel(input.record);
  const dataDir = join(brainRoot, "data", "session-memory");
  const workstreamsDir = join(dataDir, "workstreams");
  await mkdir(workstreamsDir, { recursive: true });

  const dataPath = `.brain/data/session-memory/workstreams/${workstreamId}.json`;
  const fullDataPath = join(input.record.cwd, dataPath);
  const existing = await readJson<SessionMemoryWorkstreamRecord>(fullDataPath).catch(() => undefined);
  const assistantSummary = summarizeForMemoryCard(input.resultText);
  const turn: SessionMemoryTurnRecord = {
    createdAt: now,
    runId: input.runId,
    userEntryId: input.userEntryId,
    assistantEntryId: input.assistantEntryId,
    promptSummary: summarizeForMemoryCard(input.prompt, 180),
    assistantSummary,
    sessionFile: input.record.sessionFile ?? input.record.activeRun?.sessionFile,
  };
  const turns = upsertTurn(existing?.turns ?? [], turn).slice(-memoryConfig.maxTurnsPerWorkstream);
  const workstream: SessionMemoryWorkstreamRecord = {
    schemaVersion: 1,
    workstreamId,
    label,
    source: {
      kind: input.record.kind ?? "unknown",
      threadKey: shortHash(input.record.threadId),
      workspaceName: input.record.workspaceName ? sanitizeMemoryText(input.record.workspaceName, 120) : undefined,
      cwdName: basename(input.record.cwd),
    },
    portal: {
      brainPath: portalBrainPath,
      routePath,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSummary: assistantSummary,
    turns,
  };
  await writeJson(fullDataPath, workstream);
  await updateSessionMemoryIndex({
    dataDir,
    portalBrainPath,
    routePath,
    item: {
      workstreamId,
      label,
      dataPath,
      brainPath: portalBrainPath,
      routePath,
      updatedAt: now,
      lastSummary: assistantSummary,
    },
  });

  const verification = await verifyPortalUrl(memoryConfig, routePath);
  return {
    label,
    brainPath: portalBrainPath,
    routePath,
    workstreamId,
    dataPath,
    url: verification.url,
    verified: verification.verified,
    verificationStatus: verification.status,
    verificationError: verification.error,
    summary: assistantSummary,
  };
}

export function appendSessionMemoryLink(text: string, link: SessionMemoryLink | undefined): string {
  if (!link || link.verificationStatus === "disabled") return text;
  const memoryLine = formatSessionMemoryLine(link);
  if (!memoryLine) return text;
  if (text.includes(memoryLine)) return text;
  return `${text.trimEnd()}\n\n${memoryLine}`;
}

export function formatSessionMemoryLine(link: SessionMemoryLink): string | undefined {
  if (link.url && link.verified) return `Session memory: ${link.url}`;
  if (link.brainPath) return `Session memory: ${link.brainPath} (no verified phone-safe URL yet)`;
  return undefined;
}

export function brainPathToNotesRoute(brainPath: string): string {
  const normalized = normalizeBrainPath(brainPath).replace(/^\.brain\//u, "").replace(/\.svx$/u, "");
  if (normalized === "index") return "/notes";
  return `/notes/${normalized}`;
}

export function summarizeForMemoryCard(text: string, maxChars = 220): string {
  const clean = sanitizeMemoryText(text, maxChars * 2)
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[(.*?)\]\([^)]*\)/gu, "$1")
    .replace(/[#*_>~]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return "Turn finished.";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeMemoryText(text: string, maxChars = 500): string {
  const redacted = text
    .replace(/https?:\/\/(?:canary\.)?discord(?:app)?\.com\/channels\/\d{6,20}\/\d{6,20}(?:\/\d{6,20})?/giu, "[discord-message-link]")
    .replace(/<[@#][!&]?\d{6,20}>/gu, "[discord-ref]")
    .replace(/\b\d{17,20}\b/gu, "[discord-id]")
    .replace(/\s+/gu, " ")
    .trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildDisabledLink(record: ThreadRecord, config: SessionMemoryConfig): SessionMemoryLink {
  const brainPath = normalizeBrainPath(config.portalBrainPath);
  return {
    label: createWorkstreamLabel(record),
    brainPath,
    routePath: brainPathToNotesRoute(brainPath),
    workstreamId: createWorkstreamId(record),
    verified: false,
    verificationStatus: "disabled",
  };
}

function upsertTurn(existing: SessionMemoryTurnRecord[], next: SessionMemoryTurnRecord): SessionMemoryTurnRecord[] {
  const key = turnDedupeKey(next);
  if (!key) return [...existing, next];
  return [...existing.filter((turn) => turnDedupeKey(turn) !== key), next];
}

function turnDedupeKey(turn: SessionMemoryTurnRecord): string | undefined {
  if (turn.assistantEntryId) return `assistant:${turn.assistantEntryId}`;
  if (turn.runId) return `run:${turn.runId}`;
  return undefined;
}

async function updateSessionMemoryIndex(input: {
  dataDir: string;
  portalBrainPath: string;
  routePath: string;
  item: SessionMemoryIndexRecord["workstreams"][number];
}): Promise<void> {
  const indexPath = join(input.dataDir, "index.json");
  const existing = await readJson<SessionMemoryIndexRecord>(indexPath).catch(() => undefined);
  const workstreams = new Map<string, SessionMemoryIndexRecord["workstreams"][number]>();
  for (const item of existing?.workstreams ?? []) workstreams.set(item.workstreamId, item);
  workstreams.set(input.item.workstreamId, input.item);
  const sorted = [...workstreams.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await writeJson(indexPath, {
    schemaVersion: 1,
    updatedAt: input.item.updatedAt,
    portalBrainPath: input.portalBrainPath,
    portalRoutePath: input.routePath,
    workstreams: sorted,
  } satisfies SessionMemoryIndexRecord);
}

function validatePhoneSafeBaseUrl(base: string): { ok: true } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { ok: false, error: "Invalid portal base URL" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") return { ok: false, error: "Portal base URL must use HTTPS" };
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return { ok: false, error: "Portal base URL must not be localhost" };
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::1" || hostname.startsWith("127.")) {
    return { ok: false, error: "Portal base URL must not be loopback" };
  }
  if (isIP(hostname) !== 0) return { ok: false, error: "Portal base URL must use a hostname, not a raw IP" };
  return { ok: true };
}

async function verifyPortalUrl(config: SessionMemoryConfig, routePath: string): Promise<{
  url?: string;
  verified: boolean;
  status: SessionMemoryLink["verificationStatus"];
  error?: string;
}> {
  const base = config.tailnetBaseUrl?.trim().replace(/\/+$/u, "");
  if (!base) return { verified: false, status: "not_configured" };
  const baseValidation = validatePhoneSafeBaseUrl(base);
  if (!baseValidation.ok) return { verified: false, status: "unverified", error: baseValidation.error };
  const url = `${base}${routePath}`;
  if (config.verifyTailnetUrl === false) return { verified: false, status: "unverified", error: "URL verification disabled" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.verificationTimeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.ok) return { url, verified: true, status: "verified" };
    return { url, verified: false, status: "unverified", error: `HTTP ${response.status}` };
  } catch (error) {
    return { url, verified: false, status: "unverified", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createWorkstreamId(record: ThreadRecord): string {
  const label = slugify(createWorkstreamLabel(record));
  return `${label}-${shortHash(record.threadId)}`;
}

function createWorkstreamLabel(record: ThreadRecord): string {
  const candidates = [record.workspaceName, record.sessionName, basename(record.cwd), "Pi workstream"];
  const value = candidates
    .map((candidate) => candidate?.trim())
    .find((candidate) => candidate && !isDiscordDefaultLabel(candidate));
  return sanitizeMemoryText(value || "Pi workstream", 120);
}

function isDiscordDefaultLabel(value: string): boolean {
  return /^Discord\s+\d{6,20}$/iu.test(value.trim());
}

function normalizeBrainPath(path: string): string {
  const trimmed = path.trim().replace(/\\/gu, "/").replace(/^\/+/, "");
  if (!trimmed) return ".brain/projects/project-memory-portal.svx";
  return trimmed.startsWith(".brain/") ? trimmed : `.brain/${trimmed.replace(/^brain\//u, "")}`;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "workstream";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
