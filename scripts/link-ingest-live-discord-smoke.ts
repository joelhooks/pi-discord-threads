import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { expandPath, loadConfig, type AppConfig } from "../src/config.js";
import { postPreparedLinkIngest, prepareLinkIngest } from "../src/link-ingest.js";
import { SecretResolver } from "../src/secrets.js";

interface Args {
  execute: boolean;
  channelId?: string;
  url?: string;
  note?: string;
  timeoutMs: number;
}

const args = parseArgs(process.argv.slice(2));
if (!args.execute) {
  console.error("Refusing to post to Discord without --execute.");
  console.error("Usage: npm run smoke:link-ingest-live-discord -- --execute [--channel <id>] [--url <url>] [--note <text>]");
  process.exit(2);
}

const config = await loadConfig("~/.config/pi-discord-threads/config.json");
const runId = `live-discord-smoke-${randomUUID()}`;
const channelId = args.channelId ?? defaultSmokeChannelId(config);
if (!channelId) throw new Error("No smoke channel configured. Pass --channel <discord-channel-id>.");

const url = args.url ?? `https://example.com/?pi_discord_live_smoke=${encodeURIComponent(runId)}`;
const note = args.note ?? `codex live Discord link-ingest smoke ${runId}`;
const ingestText = [url, note].filter(Boolean).join(" ");
const commandText = `${config.discord.commandPrefix} ingest ${ingestText}`;
const registryPath = join(expandPath(config.dataDir), "registry.json");

const secrets = new SecretResolver();
const token = await secrets.resolveRequired({
  envName: config.discord.tokenEnv,
  secretName: config.discord.tokenSecretName,
  ttl: config.discord.tokenLeaseTtl,
  label: "Discord bot token",
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

try {
  await client.login(token);
  await onceReady(client);

  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    throw new Error(`Channel is not sendable: ${channelId}`);
  }

  const seed = await channel.send(commandText) as Message;
  const thread = await startSmokeThread(seed, threadName(url));

  const prepared = prepareLinkIngest({
    text: ingestText,
    origin: {
      guildId: seed.guildId ?? undefined,
      channelId,
      threadId: thread.id,
      messageId: seed.id,
      authorId: client.user?.id,
    },
    config: config.linkIngest,
  });

  const posted = await postPreparedLinkIngest({
    prepared,
    config: config.linkIngest,
    secrets,
  });

  const observed = await waitForRegistryStatus(registryPath, prepared.mentionId, args.timeoutMs);
  console.log(JSON.stringify({
    runId,
    channelId,
    threadId: thread.id,
    seedMessageId: seed.id,
    sourceId: prepared.sourceId,
    mentionId: prepared.mentionId,
    eventId: prepared.eventId,
    inngestEventIds: posted.inngestEventIds,
    registryStatus: observed.status,
    statusUpdateCount: Object.keys(observed.statusUpdates ?? {}).length,
    statusKeys: Object.keys(observed.statusUpdates ?? {}).sort(),
    normalizedUrl: prepared.normalizedUrl,
  }, null, 2));
} finally {
  client.destroy();
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = { execute: false, timeoutMs: 180_000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
    } else if (arg === "--channel") {
      parsed.channelId = requiredArg(argv[++index], "--channel");
    } else if (arg === "--url") {
      parsed.url = requiredArg(argv[++index], "--url");
    } else if (arg === "--note") {
      parsed.note = requiredArg(argv[++index], "--note");
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requiredArg(argv[++index], "--timeout-ms"));
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
    if (context.workspace === "joelclaw-central") return channelId;
  }
  return config.discord.channelIds[0] ?? Object.keys(config.discord.contextChannels)[0];
}

async function onceReady(client: Client): Promise<void> {
  if (client.isReady()) return;
  await new Promise<void>((resolve) => {
    client.once("ready", () => resolve());
  });
}

async function startSmokeThread(seed: Message, name: string): Promise<ThreadChannel> {
  if (typeof seed.startThread === "function") {
    return seed.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: "joelclaw link ingest live smoke",
    });
  }

  const channel = seed.channel;
  if (channel.type !== ChannelType.GuildText || !("threads" in channel)) {
    throw new Error("Seed message channel cannot start threads");
  }
  return channel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    startMessage: seed.id,
    reason: "joelclaw link ingest live smoke",
  });
}

function threadName(url: string): string {
  try {
    const parsed = new URL(url);
    return `ingest smoke ${parsed.hostname.replace(/^www\./iu, "")}`.slice(0, 90);
  } catch {
    return "ingest smoke";
  }
}

async function waitForRegistryStatus(
  registryPath: string,
  mentionId: string,
  timeoutMs: number,
) {
  const started = Date.now();
  let lastRecord: Record<string, unknown> | undefined;
  while (Date.now() - started < timeoutMs) {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      linkIngests?: Record<string, Record<string, unknown>>;
    };
    const record = registry.linkIngests?.[mentionId];
    if (record) {
      lastRecord = record;
      const status = typeof record.status === "string" ? record.status : "";
      if (status === "indexed" || status === "failed") {
        return record;
      }
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for live Discord status bridge registry update for ${mentionId}; last=${JSON.stringify(lastRecord)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
