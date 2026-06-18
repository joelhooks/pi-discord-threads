import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expandPath, loadConfig, type AppConfig } from "../src/config.js";
import { Registry, type ActiveRunRecord } from "../src/registry.js";
import { SecretResolver } from "../src/secrets.js";

const execFileAsync = promisify(execFile);
const DISCORD_API_BASE = "https://discord.com/api/v10";

interface Args {
  execute: boolean;
  channelId?: string;
  configPath: string;
  timeoutMs: number;
  keepOpen: boolean;
}

interface DiscordMessage {
  id: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  components?: unknown[];
}

interface DiscordThread {
  id: string;
  guild_id?: string;
  parent_id?: string;
  name?: string;
}

const args = parseArgs(process.argv.slice(2));
if (!args.execute) {
  console.error("Refusing to touch live Discord/LaunchAgent without --execute.");
  console.error("Usage: npm run smoke:recovery-live -- --execute [--channel <id>] [--keep-open] [--timeout-ms <ms>]");
  process.exit(2);
}

const config = await loadConfig(args.configPath);
const channelId = args.channelId ?? defaultSmokeChannelId(config);
if (!channelId) throw new Error("No smoke channel configured. Pass --channel <discord-channel-id>.");

const secrets = new SecretResolver();
const token = await secrets.resolveRequired({
  envName: config.discord.tokenEnv,
  secretName: config.discord.tokenSecretName,
  ttl: config.discord.tokenLeaseTtl,
  label: "Discord bot token",
});

const runId = `recovery-smoke-${randomUUID()}`;
const registry = new Registry(join(expandPath(config.dataDir), "registry.json"));
await registry.load();

const seed = await discord<DiscordMessage>(token, `/channels/${channelId}/messages`, {
  method: "POST",
  body: JSON.stringify({
    content: `pi-discord recovery smoke ${runId}`,
    allowed_mentions: { parse: [] },
  }),
});
const thread = await discord<DiscordThread>(token, `/channels/${channelId}/messages/${seed.id}/threads`, {
  method: "POST",
  body: JSON.stringify({
    name: `recovery smoke ${runId.slice(-8)}`,
    auto_archive_duration: 60,
  }),
});
const placeholder = await discord<DiscordMessage>(token, `/channels/${thread.id}/messages`, {
  method: "POST",
  body: JSON.stringify({
    content: `SMOKE frozen working placeholder ${runId}`,
    allowed_mentions: { parse: [] },
  }),
});

const now = new Date().toISOString();
const activeRun: ActiveRunRecord = {
  sourceDiscordMessageId: seed.id,
  placeholderDiscordMessageId: placeholder.id,
  prompt: `recovery smoke prompt ${runId}`,
  promptPreview: `recovery smoke prompt ${runId}`,
  startedAt: now,
  updatedAt: now,
};

await registry.upsertThread({
  threadId: thread.id,
  kind: "discord-thread",
  guildId: thread.guild_id ?? seed.guild_id ?? config.discord.guildIds[0],
  parentChannelId: channelId,
  cwd: config.pi.defaultCwd,
  sessionName: `🧪 Recovery Smoke ${runId.slice(-6)}`,
  status: "running",
  activeRun,
});
await registry.recordMessage({
  discordMessageId: seed.id,
  threadId: thread.id,
  direction: "user",
  createdAt: now,
});
await registry.recordMessage({
  discordMessageId: placeholder.id,
  threadId: thread.id,
  direction: "assistant",
  createdAt: now,
});

await restartLaunchAgent(args.configPath);
const observed = await waitForRecovery({
  token,
  registry,
  threadId: thread.id,
  placeholderId: placeholder.id,
  timeoutMs: args.timeoutMs,
});

await registry.patchThread(thread.id, { status: "idle", activeRun: undefined }).catch(() => undefined);
if (!args.keepOpen) {
  await discord(token, `/channels/${thread.id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true, locked: false }),
  }).catch(() => undefined);
}

console.log(JSON.stringify({
  ok: true,
  runId,
  channelId,
  threadId: thread.id,
  seedMessageId: seed.id,
  placeholderMessageId: placeholder.id,
  threadUrl: discordChannelUrl(thread.guild_id ?? seed.guild_id ?? config.discord.guildIds[0], thread.id),
  placeholderUrl: discordMessageUrl(thread.guild_id ?? seed.guild_id ?? config.discord.guildIds[0], thread.id, placeholder.id),
  observed,
  archived: !args.keepOpen,
}, null, 2));

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    execute: false,
    configPath: "~/.config/pi-discord-threads/config.json",
    timeoutMs: 90_000,
    keepOpen: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
    } else if (arg === "--channel") {
      parsed.channelId = requiredArg(argv[++index], "--channel");
    } else if (arg === "--config") {
      parsed.configPath = requiredArg(argv[++index], "--config");
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requiredArg(argv[++index], "--timeout-ms"));
    } else if (arg === "--keep-open") {
      parsed.keepOpen = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return parsed;
}

function requiredArg(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} needs a value`);
  return value;
}

function defaultSmokeChannelId(config: AppConfig): string | undefined {
  for (const [channelId, context] of Object.entries(config.discord.contextChannels)) {
    if (context.workspace === "pi-discord-threads") return channelId;
  }
  return config.discord.channelIds[0] ?? Object.keys(config.discord.contextChannels)[0];
}

async function restartLaunchAgent(configPath: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "dist/index.js",
    "install-launch-agent",
    "--config",
    expandPath(configPath),
    "--restart",
  ], { timeout: 60_000 });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.warn(stderr.trim());
}

async function waitForRecovery(input: {
  token: string;
  registry: Registry;
  threadId: string;
  placeholderId: string;
  timeoutMs: number;
}): Promise<{ registryStatus: string; activeRunPresent: boolean; placeholderInterrupted: boolean }> {
  const started = Date.now();
  let lastRegistryStatus = "unknown";
  let lastActiveRunPresent = false;
  let lastPlaceholderInterrupted = false;

  while (Date.now() - started < input.timeoutMs) {
    await input.registry.load();
    const record = input.registry.getThread(input.threadId);
    lastRegistryStatus = record?.status ?? "missing";
    lastActiveRunPresent = Boolean(record?.activeRun);

    const message = await discord<DiscordMessage>(input.token, `/channels/${input.threadId}/messages/${input.placeholderId}`);
    const componentText = JSON.stringify(message.components ?? []);
    lastPlaceholderInterrupted = componentText.includes("run interrupted")
      || componentText.includes("Bridge restarted before Discord received a final answer")
      || componentText.includes("terminal card; no live Pi turn is running");

    if (lastRegistryStatus === "interrupted" && lastActiveRunPresent && lastPlaceholderInterrupted) {
      return {
        registryStatus: lastRegistryStatus,
        activeRunPresent: lastActiveRunPresent,
        placeholderInterrupted: lastPlaceholderInterrupted,
      };
    }

    await sleep(1_500);
  }

  throw new Error(`Recovery smoke timed out: registry=${lastRegistryStatus} activeRun=${lastActiveRunPresent} placeholderInterrupted=${lastPlaceholderInterrupted}`);
}

async function discord<A>(token: string, path: string, init: RequestInit = {}): Promise<A> {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<A>;
}

function discordChannelUrl(guildId: string | undefined, channelId: string): string | undefined {
  return guildId ? `https://discord.com/channels/${guildId}/${channelId}` : undefined;
}

function discordMessageUrl(guildId: string | undefined, channelId: string, messageId: string): string | undefined {
  return guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
