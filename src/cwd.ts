import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "./config.js";

export interface WorkspaceResolution {
  name: string;
  cwd: string;
}

export async function resolveCwdInput(input: string | undefined, fallbackCwd: string): Promise<string> {
  const candidate = normalizeCwdInput(input, fallbackCwd);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error(`cwd does not exist: ${candidate}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`cwd is not a directory: ${candidate}`);
  }

  return realpath(candidate);
}

export function normalizeCwdInput(input: string | undefined, fallbackCwd: string): string {
  const raw = input?.trim();
  if (!raw) return fallbackCwd;

  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));

  if (raw.startsWith("@")) {
    const withoutAt = raw.slice(1);
    if (!withoutAt) return fallbackCwd;
    return isAbsolute(withoutAt) ? withoutAt : resolve(homedir(), withoutAt);
  }

  if (isAbsolute(raw)) return raw;
  return resolve(fallbackCwd, raw);
}

export function listWorkspaces(config: AppConfig): WorkspaceResolution[] {
  return Object.entries(config.pi.workspaces)
    .map(([name, cwd]) => ({ name, cwd }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveWorkspaceInput(input: string, config: AppConfig): Promise<WorkspaceResolution> {
  const name = normalizeWorkspaceName(input);
  if (!name) {
    throw new Error(workspaceUsage(config));
  }

  const cwdInput = config.pi.workspaces[name];
  if (!cwdInput) {
    const known = listWorkspaces(config).map((workspace) => workspace.name);
    throw new Error(
      known.length > 0
        ? `Unknown workspace: ${input.trim()}. Known workspaces: ${known.join(", ")}`
        : "No workspaces are configured yet. Add pi.workspaces to the config file.",
    );
  }

  return {
    name,
    cwd: await resolveCwdInput(cwdInput, config.pi.defaultCwd),
  };
}

export function parseWorkspaceCommand(input: string): { name?: string; prompt: string } | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(/^workspace(?:\s+("[^"]+"|'[^']+'|\S+))?\s*(.*)$/is);
  if (!match) return undefined;
  return {
    name: match[1] ? unquote(match[1]).trim() : undefined,
    prompt: (match[2] ?? "").trim(),
  };
}

export function workspaceUsage(config: AppConfig): string {
  const known = listWorkspaces(config).map((workspace) => workspace.name);
  return known.length > 0
    ? `Usage: workspace <name> [prompt]. Known workspaces: ${known.join(", ")}`
    : "No workspaces are configured yet. Add pi.workspaces to the config file.";
}

function normalizeWorkspaceName(input: string): string {
  return input.trim().toLowerCase();
}

export function parseLeadingCwdFlag(input: string): { cwdInput?: string; prompt: string } {
  const trimmed = input.trim();
  const equalsMatch = trimmed.match(/^--cwd=("[^"]+"|'[^']+'|\S+)\s*(.*)$/s);
  if (equalsMatch) {
    return {
      cwdInput: unquote(equalsMatch[1] ?? ""),
      prompt: (equalsMatch[2] ?? "").trim(),
    };
  }

  const spaceMatch = trimmed.match(/^--cwd\s+("[^"]+"|'[^']+'|\S+)\s*(.*)$/s);
  if (spaceMatch) {
    return {
      cwdInput: unquote(spaceMatch[1] ?? ""),
      prompt: (spaceMatch[2] ?? "").trim(),
    };
  }

  return { prompt: trimmed };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
