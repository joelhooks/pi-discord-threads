import { createHash } from "node:crypto";
import type { LinkIngestConfig } from "./config.js";
import { SecretResolver } from "./secrets.js";

export const LINK_INGEST_EVENT_NAME = "link/ingest.requested" as const;
export const LINK_INGEST_EVENT_VERSION = "2026-06-17.1";

export interface DiscordLinkIngestOrigin {
  guildId?: string;
  channelId: string;
  threadId: string;
  messageId?: string;
  interactionId?: string;
  authorId?: string;
}

export interface PreparedLinkIngest {
  sourceId: string;
  mentionId: string;
  eventId: string;
  url: string;
  normalizedUrl: string;
  context?: string;
  payload: {
    id: string;
    name: typeof LINK_INGEST_EVENT_NAME;
    v: typeof LINK_INGEST_EVENT_VERSION;
    data: Record<string, unknown>;
  };
}

export interface LinkIngestSendResult extends PreparedLinkIngest {
  inngestEventIds: string[];
  response: unknown;
}

export interface PreparedLinkIngestPostResult {
  inngestEventIds: string[];
  response: unknown;
}

export function prepareLinkIngest(input: {
  text: string;
  origin: DiscordLinkIngestOrigin;
  requestedBy?: string;
  config: LinkIngestConfig;
  createdAt?: string;
}): PreparedLinkIngest {
  const found = extractFirstUrl(input.text);
  if (!found) throw new Error("No URL found. Use `ingest https://...`.");

  const normalizedUrl = normalizeSourceUrl(found.url);
  const sourceId = sha256Hex(normalizedUrl);
  const originId = input.origin.messageId ?? input.origin.interactionId;
  if (!originId) throw new Error("Link ingest needs a Discord message or interaction id.");

  const mentionId = [
    "discord",
    input.origin.guildId ?? "dm",
    input.origin.channelId,
    originId,
  ].join(":");
  const eventId = `link-ingest:${mentionId}`;
  const context = found.context || undefined;
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    sourceId,
    mentionId,
    eventId,
    url: found.url,
    normalizedUrl,
    ...(context ? { context } : {}),
    payload: {
      id: eventId,
      name: LINK_INGEST_EVENT_NAME,
      v: LINK_INGEST_EVENT_VERSION,
      data: {
        url: found.url,
        normalizedUrl,
        sourceId,
        mentionId,
        text: input.text,
        ...(context ? { context } : {}),
        source: "discord",
        requestedBy: input.requestedBy ?? "joel",
        visibility: input.config.defaultVisibility,
        site: input.config.defaultSite,
        wzrrdCandidate: input.config.wzrrdCandidate,
        discord: {
          ...input.origin,
        },
        createdAt,
      },
    },
  };
}

export async function sendLinkIngest(input: {
  text: string;
  origin: DiscordLinkIngestOrigin;
  requestedBy?: string;
  config: LinkIngestConfig;
  secrets?: SecretResolver;
  createdAt?: string;
}): Promise<LinkIngestSendResult> {
  const prepared = prepareLinkIngest(input);
  const posted = await postPreparedLinkIngest({
    prepared,
    config: input.config,
    secrets: input.secrets,
  });
  return {
    ...prepared,
    ...posted,
  };
}

export async function postPreparedLinkIngest(input: {
  prepared: PreparedLinkIngest;
  config: LinkIngestConfig;
  secrets?: SecretResolver;
}): Promise<PreparedLinkIngestPostResult> {
  if (!input.config.enabled) {
    throw new Error("linkIngest is disabled in config.");
  }

  const eventKey = await resolveEventKey(input.config, input.secrets ?? new SecretResolver());
  const response = await postInngestEvent(input.config, eventKey, input.prepared.payload);
  return {
    inngestEventIds: extractInngestIds(response),
    response,
  };
}

export function extractFirstUrl(text: string): { url: string; context: string } | undefined {
  const match = text.match(/https?:\/\/[^\s<>"']+/iu);
  if (!match?.[0]) return undefined;
  const url = trimUrlPunctuation(match[0]);
  const before = text.slice(0, match.index).trim();
  const after = text.slice((match.index ?? 0) + match[0].length).trim();
  return {
    url,
    context: [before, after].filter(Boolean).join(" ").trim(),
  };
}

export function normalizeSourceUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/u, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveEventKey(config: LinkIngestConfig, secrets: SecretResolver): Promise<string> {
  const eventKey = await secrets.resolveRequired({
    envName: config.eventKeyEnv,
    secretName: config.eventKeySecretName,
    ttl: config.eventKeyLeaseTtl,
    label: "Inngest event key",
  });
  return eventKey.trim();
}

async function postInngestEvent(
  config: LinkIngestConfig,
  eventKey: string,
  payload: PreparedLinkIngest["payload"],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.inngestUrl}/e/${encodeURIComponent(eventKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    const parsed = parseJsonResponse(body);
    if (!response.ok) {
      const detail = typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : body.slice(0, 500);
      throw new Error(`Inngest event send failed (${response.status}): ${detail}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonResponse(body: string): unknown {
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { raw: body };
  }
}

function extractInngestIds(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const ids = (response as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}
