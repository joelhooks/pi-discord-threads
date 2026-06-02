import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export interface AppConfig {
  dataDir: string;
  discord: {
    tokenEnv?: string;
    tokenSecretName?: string;
    tokenLeaseTtl: string;
    allowedUserIds: string[];
    allowedUserIdEnv?: string;
    allowedUserIdSecretName?: string;
    guildIds: string[];
    channelIds: string[];
    commandPrefix: string;
    respondToMentions: boolean;
  };
  pi: {
    defaultCwd: string;
    agentDir?: string;
    sessionDir?: string;
    idleTtlMs: number;
    workspaces: Record<string, string>;
  };
  render: {
    maxDiscordChars: number;
  };
  attachments: {
    enabled: boolean;
    maxBytes: number;
    allowedContentTypePrefixes: string[];
    allowedExtensions: string[];
  };
}

export interface CliOptions {
  command: "start" | "init-config" | "doctor" | "help";
  configPath: string;
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "@") return homedir();
  if (path.startsWith("@")) {
    const withoutAt = path.slice(1);
    return isAbsolute(withoutAt) ? withoutAt : resolve(homedir(), withoutAt);
  }
  return resolve(path);
}

export const defaultConfigPath = "~/.config/pi-discord-threads/config.json";

export function defaultConfig(): AppConfig {
  return {
    dataDir: "~/.local/share/pi-discord-threads",
    discord: {
      tokenEnv: "DISCORD_BOT_TOKEN",
      tokenSecretName: "discord_bot_token",
      tokenLeaseTtl: "12h",
      allowedUserIds: [],
      allowedUserIdEnv: "DISCORD_ALLOWED_USER_ID",
      allowedUserIdSecretName: "discord_allowed_user_id",
      guildIds: [],
      channelIds: [],
      commandPrefix: "!pi",
      respondToMentions: true,
    },
    pi: {
      defaultCwd: "~",
      idleTtlMs: 20 * 60 * 1000,
      workspaces: {},
    },
    render: {
      maxDiscordChars: 1900,
    },
    attachments: {
      enabled: true,
      maxBytes: 2 * 1024 * 1024,
      allowedContentTypePrefixes: ["text/", "image/", "application/json"],
      allowedExtensions: [".txt", ".md", ".json", ".log", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"],
    },
  };
}

function mergeConfig(base: AppConfig, partial: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...partial,
    discord: {
      ...base.discord,
      ...(partial.discord ?? {}),
    },
    pi: {
      ...base.pi,
      ...(partial.pi ?? {}),
    },
    render: {
      ...base.render,
      ...(partial.render ?? {}),
    },
    attachments: {
      ...base.attachments,
      ...(partial.attachments ?? {}),
    },
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const resolved = expandPath(configPath);
  const base = defaultConfig();
  if (!existsSync(resolved)) {
    const config = normalizeConfig(base);
    return config;
  }

  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  return normalizeConfig(mergeConfig(base, parsed));
}

export async function writeDefaultConfig(configPath: string): Promise<void> {
  const resolved = expandPath(configPath);
  await mkdir(dirname(resolved), { recursive: true });
  const config = defaultConfig();
  await writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    dataDir: expandPath(config.dataDir),
    discord: {
      ...config.discord,
      allowedUserIds: [...new Set(config.discord.allowedUserIds.map((id) => id.trim()).filter(Boolean))],
      guildIds: [...new Set(config.discord.guildIds.map((id) => id.trim()).filter(Boolean))],
      channelIds: [...new Set(config.discord.channelIds.map((id) => id.trim()).filter(Boolean))],
      commandPrefix: config.discord.commandPrefix || "!pi",
      tokenLeaseTtl: config.discord.tokenLeaseTtl || "12h",
    },
    pi: {
      ...config.pi,
      defaultCwd: expandPath(config.pi.defaultCwd),
      agentDir: config.pi.agentDir ? expandPath(config.pi.agentDir) : undefined,
      sessionDir: config.pi.sessionDir ? expandPath(config.pi.sessionDir) : undefined,
      idleTtlMs: Math.max(60_000, config.pi.idleTtlMs || 20 * 60 * 1000),
      workspaces: normalizeWorkspaces(config.pi.workspaces),
    },
    render: {
      maxDiscordChars: Math.max(500, Math.min(1900, config.render.maxDiscordChars || 1900)),
    },
    attachments: {
      enabled: config.attachments.enabled !== false,
      maxBytes: Math.max(1_024, Math.min(25 * 1024 * 1024, config.attachments.maxBytes || 2 * 1024 * 1024)),
      allowedContentTypePrefixes: [...new Set(config.attachments.allowedContentTypePrefixes.map((value) => value.trim()).filter(Boolean))],
      allowedExtensions: [...new Set(config.attachments.allowedExtensions.map((value) => value.trim().toLowerCase()).filter(Boolean))],
    },
  };
}

function normalizeWorkspaces(workspaces: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawName, rawPath] of Object.entries(workspaces ?? {})) {
    const name = rawName.trim().toLowerCase();
    const path = rawPath.trim();
    if (!name || !path) continue;
    normalized[name] = expandPath(path);
  }
  return normalized;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const [maybeCommand, ...rest] = argv;
  const command = maybeCommand && !maybeCommand.startsWith("-")
    ? maybeCommand
    : "start";
  const args = command === maybeCommand ? rest : argv;

  let configPath = defaultConfigPath;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      const next = args[i + 1];
      if (!next) throw new Error("--config requires a path");
      configPath = next;
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", configPath };
    }
  }

  if (!["start", "init-config", "doctor", "help"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  return { command: command as CliOptions["command"], configPath };
}
