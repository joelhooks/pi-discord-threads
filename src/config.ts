import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export const runControlRoles = ["bot", "worker", "reconcile"] as const;
export type RunControlRole = typeof runControlRoles[number];

export interface RunControlConfig {
  enabled: boolean;
  redisUrlEnv: string;
  redisUrl?: string;
  keyPrefix: string;
  roles: RunControlRole[];
  workerId?: string;
  leaseTtlMs: number;
  heartbeatMs: number;
  staleRunMs: number;
  reconcileIntervalMs: number;
  commandTimeoutMs: number;
  maxConcurrentRuns: number;
  maxRetryLaterAttempts: number;
}

export interface DiscordContextChannelConfig {
  workspace?: string;
  cwd?: string;
}

export interface PersonalWorkroomConfig {
  enabled: boolean;
  workspace?: string;
  cwd?: string;
  sessionName: string;
  extensionPaths: string[];
}

export interface ThreadTitleConfig {
  enabled: boolean;
  model: string;
  firstEvaluationTurn: number;
  evaluationIntervalTurns: number;
  minRenameIntervalMs: number;
}

export interface LinkIngestConfig {
  enabled: boolean;
  inngestUrl: string;
  eventKeyEnv?: string;
  eventKeySecretName?: string;
  eventKeyLeaseTtl: string;
  signingKeyEnv?: string;
  signingKeySecretName?: string;
  signingKeyLeaseTtl: string;
  statusBridgeEnabled: boolean;
  brainRoot?: string;
  defaultVisibility: string;
  defaultSite: string;
  wzrrdCandidate: boolean;
  requestTimeoutMs: number;
}

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
    contextChannels: Record<string, DiscordContextChannelConfig>;
    personalWorkroom: PersonalWorkroomConfig;
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
    hud: {
      enabled: boolean;
      model: string;
      updateIntervalMs: number;
    };
    threadTitles: ThreadTitleConfig;
  };
  attachments: {
    enabled: boolean;
    maxBytes: number;
    allowedContentTypePrefixes: string[];
    allowedExtensions: string[];
  };
  linkIngest: LinkIngestConfig;
  runControl: RunControlConfig;
}

export type ReleaseCommand = "snapshot" | "list" | "activate" | "canary" | "deploy" | "rollback";

export interface CliOptions {
  command: "start" | "init-config" | "doctor" | "reconcile" | "daily-post" | "install-launch-agent" | "uninstall-launch-agent" | "launch-agent-status" | "release" | "help";
  configPath: string;
  dailyPostRequestPath?: string;
  roles?: RunControlRole[];
  reconcileApply: boolean;
  launchAgentStart: boolean;
  launchAgentRestart: boolean;
  force: boolean;
  releaseCommand?: ReleaseCommand;
  releaseTarget?: string;
  releaseAllowDirty: boolean;
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
      contextChannels: {},
      personalWorkroom: {
        enabled: false,
        sessionName: "Personal Workroom",
        extensionPaths: [],
      },
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
      hud: {
        enabled: true,
        model: "openai-codex/gpt-5.5",
        updateIntervalMs: 5_000,
      },
      threadTitles: {
        enabled: true,
        model: "openai-codex/gpt-5.4-mini",
        firstEvaluationTurn: 2,
        evaluationIntervalTurns: 8,
        minRenameIntervalMs: 30 * 60_000,
      },
    },
    attachments: {
      enabled: true,
      maxBytes: 25 * 1024 * 1024,
      allowedContentTypePrefixes: ["text/", "image/", "audio/", "video/", "application/json", "application/pdf"],
      allowedExtensions: [
        ".txt", ".md", ".json", ".log", ".csv", ".tsv", ".srt", ".vtt",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".svg",
        ".mp3", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac",
        ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg",
        ".pdf",
      ],
    },
    linkIngest: {
      enabled: true,
      inngestUrl: "http://127.0.0.1:8288",
      eventKeyEnv: "INNGEST_EVENT_KEY",
      eventKeySecretName: "inngest_event_key",
      eventKeyLeaseTtl: "12h",
      signingKeyEnv: "INNGEST_SIGNING_KEY",
      signingKeySecretName: "inngest_signing_key",
      signingKeyLeaseTtl: "12h",
      statusBridgeEnabled: true,
      brainRoot: process.env.LINK_INGEST_BRAIN_ROOT,
      defaultVisibility: "private",
      defaultSite: "joelclaw",
      wzrrdCandidate: false,
      requestTimeoutMs: 10_000,
    },
    runControl: {
      enabled: false,
      redisUrlEnv: "REDIS_URL",
      keyPrefix: "pi-discord-threads",
      roles: ["bot", "worker", "reconcile"],
      leaseTtlMs: 60_000,
      heartbeatMs: 10_000,
      staleRunMs: 10 * 60_000,
      reconcileIntervalMs: 60_000,
      commandTimeoutMs: 5_000,
      maxConcurrentRuns: 4,
      maxRetryLaterAttempts: 12,
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
      hud: {
        ...base.render.hud,
        ...(partial.render?.hud ?? {}),
      },
      threadTitles: {
        ...base.render.threadTitles,
        ...(partial.render?.threadTitles ?? {}),
      },
    },
    attachments: {
      ...base.attachments,
      ...(partial.attachments ?? {}),
    },
    linkIngest: {
      ...base.linkIngest,
      ...(partial.linkIngest ?? {}),
    },
    runControl: {
      ...base.runControl,
      ...(partial.runControl ?? {}),
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
      contextChannels: normalizeContextChannels(config.discord.contextChannels),
      personalWorkroom: normalizePersonalWorkroom(config.discord.personalWorkroom),
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
      hud: {
        enabled: config.render.hud?.enabled !== false,
        model: config.render.hud?.model?.trim() || "openai-codex/gpt-5.5",
        updateIntervalMs: Math.max(2_500, Math.min(30_000, config.render.hud?.updateIntervalMs || 5_000)),
      },
      threadTitles: normalizeThreadTitles(config.render.threadTitles),
    },
    attachments: {
      enabled: config.attachments.enabled !== false,
      maxBytes: Math.max(1_024, Math.min(100 * 1024 * 1024, config.attachments.maxBytes || 25 * 1024 * 1024)),
      allowedContentTypePrefixes: [...new Set(config.attachments.allowedContentTypePrefixes.map((value) => value.trim()).filter(Boolean))],
      allowedExtensions: [...new Set(config.attachments.allowedExtensions.map((value) => value.trim().toLowerCase()).filter(Boolean))],
    },
    linkIngest: normalizeLinkIngest(config.linkIngest),
    runControl: normalizeRunControl(config.runControl),
  };
}

function normalizeContextChannels(channels: Record<string, DiscordContextChannelConfig> | undefined): Record<string, DiscordContextChannelConfig> {
  const normalized: Record<string, DiscordContextChannelConfig> = {};
  for (const [rawChannelId, value] of Object.entries(channels ?? {})) {
    const channelId = rawChannelId.trim();
    const workspace = value.workspace?.trim().toLowerCase();
    const cwd = value.cwd?.trim();
    if (!channelId || (!workspace && !cwd)) continue;
    normalized[channelId] = {
      ...(workspace ? { workspace } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  return normalized;
}

function normalizePersonalWorkroom(workroom: PersonalWorkroomConfig | undefined): PersonalWorkroomConfig {
  return {
    enabled: workroom?.enabled === true,
    workspace: workroom?.workspace?.trim().toLowerCase() || undefined,
    cwd: workroom?.cwd?.trim() ? expandPath(workroom.cwd) : undefined,
    sessionName: workroom?.sessionName?.trim() || "Personal Workroom",
    extensionPaths: [...new Set((workroom?.extensionPaths ?? []).map((value) => value.trim()).filter(Boolean).map(expandPath))],
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

function normalizeThreadTitles(threadTitles: ThreadTitleConfig | undefined): ThreadTitleConfig {
  const defaults = defaultConfig().render.threadTitles;
  const merged = { ...defaults, ...(threadTitles ?? {}) };
  return {
    enabled: merged.enabled !== false,
    model: merged.model?.trim() || defaults.model,
    firstEvaluationTurn: Math.floor(clampNumber(merged.firstEvaluationTurn, 1, 20, defaults.firstEvaluationTurn)),
    evaluationIntervalTurns: Math.floor(clampNumber(merged.evaluationIntervalTurns, 1, 50, defaults.evaluationIntervalTurns)),
    minRenameIntervalMs: clampNumber(merged.minRenameIntervalMs, 0, 24 * 60 * 60_000, defaults.minRenameIntervalMs),
  };
}

function normalizeRunControl(runControl: RunControlConfig | undefined): RunControlConfig {
  const defaults = defaultConfig().runControl;
  const merged = { ...defaults, ...(runControl ?? {}) };
  const roles = normalizeRunControlRoles(merged.roles);
  const leaseTtlMs = clampNumber(merged.leaseTtlMs, 5_000, 10 * 60_000, defaults.leaseTtlMs);
  const heartbeatMs = clampNumber(merged.heartbeatMs, 1_000, Math.max(1_000, Math.floor(leaseTtlMs / 2)), defaults.heartbeatMs);
  const staleRunMs = clampNumber(merged.staleRunMs, leaseTtlMs, 24 * 60 * 60_000, defaults.staleRunMs);
  return {
    enabled: merged.enabled === true,
    redisUrlEnv: merged.redisUrlEnv?.trim() || defaults.redisUrlEnv,
    redisUrl: merged.redisUrl?.trim() || undefined,
    keyPrefix: merged.keyPrefix?.trim() || defaults.keyPrefix,
    roles,
    workerId: merged.workerId?.trim() || undefined,
    leaseTtlMs,
    heartbeatMs,
    staleRunMs,
    reconcileIntervalMs: clampNumber(merged.reconcileIntervalMs, 5_000, 60 * 60_000, defaults.reconcileIntervalMs),
    commandTimeoutMs: clampNumber(merged.commandTimeoutMs, 1_000, 60_000, defaults.commandTimeoutMs),
    maxConcurrentRuns: Math.floor(clampNumber(merged.maxConcurrentRuns, 1, 16, defaults.maxConcurrentRuns)),
    maxRetryLaterAttempts: Math.floor(clampNumber(merged.maxRetryLaterAttempts, 1, 100, defaults.maxRetryLaterAttempts)),
  };
}

function normalizeLinkIngest(linkIngest: LinkIngestConfig | undefined): LinkIngestConfig {
  const defaults = defaultConfig().linkIngest;
  const merged = { ...defaults, ...(linkIngest ?? {}) };
  const inngestUrl = (merged.inngestUrl || defaults.inngestUrl).trim().replace(/\/+$/u, "");
  return {
    enabled: merged.enabled !== false,
    inngestUrl: inngestUrl || defaults.inngestUrl,
    eventKeyEnv: merged.eventKeyEnv?.trim() || defaults.eventKeyEnv,
    eventKeySecretName: merged.eventKeySecretName?.trim() || undefined,
    eventKeyLeaseTtl: merged.eventKeyLeaseTtl?.trim() || defaults.eventKeyLeaseTtl,
    signingKeyEnv: merged.signingKeyEnv?.trim() || defaults.signingKeyEnv,
    signingKeySecretName: merged.signingKeySecretName?.trim() || undefined,
    signingKeyLeaseTtl: merged.signingKeyLeaseTtl?.trim() || defaults.signingKeyLeaseTtl,
    statusBridgeEnabled: merged.statusBridgeEnabled !== false,
    brainRoot: merged.brainRoot?.trim() || undefined,
    defaultVisibility: merged.defaultVisibility?.trim() || defaults.defaultVisibility,
    defaultSite: merged.defaultSite?.trim() || defaults.defaultSite,
    wzrrdCandidate: merged.wzrrdCandidate === true,
    requestTimeoutMs: clampNumber(merged.requestTimeoutMs, 1_000, 120_000, defaults.requestTimeoutMs),
  };
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  const numeric = Number.isFinite(value) ? Number(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeRunControlRoles(values: RunControlRole[] | undefined): RunControlRole[] {
  const roles: RunControlRole[] = [];
  for (const value of values ?? []) {
    try {
      roles.push(parseRunControlRole(value));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Ignoring invalid run-control role in config: ${message}`);
    }
  }
  const unique = [...new Set(roles)];
  return unique.length > 0 ? unique : ["bot", "worker", "reconcile"];
}

function parseRunControlRoles(value: string): RunControlRole[] {
  return [...new Set(value.split(/[,\s]+/).filter(Boolean).map((role) => parseRunControlRole(role)))];
}

function parseRunControlRole(value: string): RunControlRole {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bot" || normalized === "worker" || normalized === "reconcile") return normalized;
  throw new Error(`Unknown run-control role: ${value}`);
}

export function parseCliArgs(argv: string[]): CliOptions {
  const [maybeCommand, ...rest] = argv;
  const command = maybeCommand && !maybeCommand.startsWith("-")
    ? maybeCommand
    : "start";
  const args = command === maybeCommand ? rest : argv;

  if (command === "release") return parseReleaseCliArgs(args);

  let configPath = defaultConfigPath;
  let reconcileApply = false;
  let launchAgentStart = false;
  let launchAgentRestart = false;
  let force = false;
  let dailyPostRequestPath: string | undefined;
  let roles: RunControlRole[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      const next = args[i + 1];
      if (!next) throw new Error("--config requires a path");
      configPath = next;
      i++;
      continue;
    }
    if (arg === "--request") {
      const next = args[i + 1];
      if (!next) throw new Error("--request requires a path");
      dailyPostRequestPath = next;
      i++;
      continue;
    }
    if (arg.startsWith("--request=")) {
      dailyPostRequestPath = arg.slice("--request=".length);
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return baseCliOptions("help", { configPath, reconcileApply, launchAgentStart, launchAgentRestart, force });
    }
    if (arg === "--dry-run") {
      reconcileApply = false;
      continue;
    }
    if (arg === "--apply") {
      reconcileApply = true;
      continue;
    }
    if (arg === "--start") {
      launchAgentStart = true;
      continue;
    }
    if (arg === "--restart") {
      launchAgentStart = true;
      launchAgentRestart = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--role") {
      const next = args[i + 1];
      if (!next) throw new Error("--role requires bot, worker, or reconcile");
      roles = [...(roles ?? []), parseRunControlRole(next)];
      i++;
      continue;
    }
    if (arg.startsWith("--role=")) {
      roles = [...(roles ?? []), parseRunControlRole(arg.slice("--role=".length))];
      continue;
    }
    if (arg === "--roles") {
      const next = args[i + 1];
      if (!next) throw new Error("--roles requires a comma-separated role list");
      roles = parseRunControlRoles(next);
      i++;
      continue;
    }
    if (arg.startsWith("--roles=")) {
      roles = parseRunControlRoles(arg.slice("--roles=".length));
      continue;
    }
  }

  if (!["start", "init-config", "doctor", "reconcile", "daily-post", "install-launch-agent", "uninstall-launch-agent", "launch-agent-status", "help"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  return baseCliOptions(command as CliOptions["command"], {
    configPath,
    ...(dailyPostRequestPath ? { dailyPostRequestPath } : {}),
    ...(roles ? { roles } : {}),
    reconcileApply,
    launchAgentStart,
    launchAgentRestart,
    force,
  });
}

function parseReleaseCliArgs(args: string[]): CliOptions {
  let configPath = defaultConfigPath;
  let releaseCommand: ReleaseCommand | undefined;
  let releaseTarget: string | undefined;
  let releaseAllowDirty = false;

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
    if (arg === "--allow-dirty") {
      releaseAllowDirty = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return baseCliOptions("help", { configPath });
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown release option: ${arg}`);
    }
    if (!releaseCommand) {
      releaseCommand = parseReleaseCommand(arg);
      continue;
    }
    if ((releaseCommand === "activate" || releaseCommand === "canary" || releaseCommand === "rollback") && !releaseTarget) {
      releaseTarget = arg;
      continue;
    }
    throw new Error(`Unexpected release argument: ${arg}`);
  }

  if (!releaseCommand) {
    throw new Error("release requires a subcommand: snapshot, list, activate, canary, deploy, or rollback");
  }
  if (releaseAllowDirty && releaseCommand !== "snapshot") {
    throw new Error("--allow-dirty is only valid for release snapshot");
  }
  if ((releaseCommand === "activate" || releaseCommand === "canary" || releaseCommand === "rollback") && !releaseTarget) {
    throw new Error(`release ${releaseCommand} requires a release id, commit, or current`);
  }

  return baseCliOptions("release", {
    configPath,
    releaseCommand,
    ...(releaseTarget ? { releaseTarget } : {}),
    releaseAllowDirty,
  });
}

function parseReleaseCommand(value: string): ReleaseCommand {
  const normalized = value.trim().toLowerCase();
  if (normalized === "snapshot" || normalized === "list" || normalized === "activate" || normalized === "canary" || normalized === "deploy" || normalized === "rollback") return normalized;
  throw new Error(`Unknown release subcommand: ${value}`);
}

function baseCliOptions(command: CliOptions["command"], options: Partial<Omit<CliOptions, "command">>): CliOptions {
  return {
    command,
    configPath: options.configPath ?? defaultConfigPath,
    ...(options.dailyPostRequestPath ? { dailyPostRequestPath: options.dailyPostRequestPath } : {}),
    ...(options.roles ? { roles: options.roles } : {}),
    reconcileApply: options.reconcileApply ?? false,
    launchAgentStart: options.launchAgentStart ?? false,
    launchAgentRestart: options.launchAgentRestart ?? false,
    force: options.force ?? false,
    ...(options.releaseCommand ? { releaseCommand: options.releaseCommand } : {}),
    ...(options.releaseTarget ? { releaseTarget: options.releaseTarget } : {}),
    releaseAllowDirty: options.releaseAllowDirty ?? false,
  };
}
