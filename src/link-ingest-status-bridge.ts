import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Client,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { Inngest } from "inngest";
import { connect } from "inngest/connect";
import { expandPath, type AppConfig } from "./config.js";
import type { LinkIngestStatusUpdateRecord, RegistryPort } from "./registry.js";
import { SecretResolver } from "./secrets.js";

const STATUS_EVENTS = {
  accepted: "link/ingest.accepted",
  classified: "link/ingest.classified",
  archiveCompleted: "source/archive.completed",
  videoMetadataCompleted: "video/metadata.completed",
  videoMediaCompleted: "video/media.completed",
  videoAudioTranscriptCompleted: "video/audio-transcript.completed",
  articleExtractCompleted: "article/extract.completed",
  xSnapshotCompleted: "x/snapshot.completed",
  transcriptCompleted: "source/transcript.completed",
  summaryCompleted: "source/summary.completed",
  captureReady: "capture/item.ready",
  captureIndexCompleted: "capture/index.completed",
  captureFailed: "capture/item.failed",
  piWorkflowNeedsHuman: "pi/workflow.needs_human",
} as const;

export type LinkIngestStatus = "accepted" | "classified" | "archived" | "video_metadata" | "video_media" | "audio_transcript" | "article_extracted" | "x_snapshot" | "transcript_processed" | "summarized" | "ready" | "indexed" | "needs_human" | "failed";

export function shouldPostLinkIngestStatusToDiscord(status: LinkIngestStatus | string): boolean {
  return status === "indexed" || status === "needs_human" || status === "failed";
}

export type StopLinkIngestStatusBridge = () => Promise<void>;

export interface LinkIngestStatusBridgeOptions {
  client: Client;
  config: AppConfig;
  registry: RegistryPort;
  secrets?: SecretResolver;
}

interface NormalizedStatusEvent {
  eventName: string;
  status: LinkIngestStatus;
  statusKey: string;
  sourceId: string;
  mentionId: string;
  normalizedUrl?: string;
  brainPath?: string;
  manifestPath?: string;
  sourceType?: string;
  plannedNextEvent?: string;
  dispatchHold?: string;
  archiveStatus?: string;
  videoStatus?: string;
  mediaStatus?: string;
  audioTranscriptStatus?: string;
  videoTitle?: string;
  authorName?: string;
  thumbnailUrl?: string;
  articleStatus?: string;
  xStatus?: string;
  username?: string;
  postId?: string;
  transcriptStatus?: string;
  summaryStatus?: string;
  indexStatus?: string;
  failureStatus?: string;
  failedStep?: string;
  reason?: string;
  errorMessage?: string;
  errorName?: string;
  contextSummary?: string;
  question?: string;
  confidence?: string;
  assetDir?: string;
  mediaPath?: string;
  infoPath?: string;
  thumbnailPath?: string;
  itemPath?: string;
  aggregatePath?: string;
  jsonlPath?: string;
  textPath?: string;
  transcriptPath?: string;
  vttPath?: string;
  summaryPath?: string;
  metadataPath?: string;
  wordCount?: number;
  charCount?: number;
  bytes?: number;
  documentCount?: number;
  searchTextBytes?: number;
  pageCreated?: boolean;
  discord?: {
    guildId?: string;
    channelId?: string;
    threadId?: string;
    messageId?: string;
    interactionId?: string;
    authorId?: string;
  };
  occurredAt?: string;
}

type SendableChannel = {
  send(options: MessageCreateOptions): Promise<Message>;
};

export async function startLinkIngestStatusBridge(
  options: LinkIngestStatusBridgeOptions,
): Promise<StopLinkIngestStatusBridge> {
  if (!options.config.linkIngest.enabled || !options.config.linkIngest.statusBridgeEnabled) {
    return async () => undefined;
  }

  await prepareInngestConnectEnv(options.config, options.secrets ?? new SecretResolver());
  const inngest = new Inngest({ id: "pi-discord-threads-link-ingest-status" });
  const functions = [
    createStatusFunction(inngest, STATUS_EVENTS.accepted, "link-ingest-accepted-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.classified, "link-ingest-classified-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.archiveCompleted, "source-archive-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.videoMetadataCompleted, "video-metadata-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.videoMediaCompleted, "video-media-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.videoAudioTranscriptCompleted, "video-audio-transcript-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.articleExtractCompleted, "article-extract-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.xSnapshotCompleted, "x-snapshot-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.transcriptCompleted, "source-transcript-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.summaryCompleted, "source-summary-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.captureReady, "capture-item-ready-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.captureIndexCompleted, "capture-index-completed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.captureFailed, "capture-item-failed-discord-status", options),
    createStatusFunction(inngest, STATUS_EVENTS.piWorkflowNeedsHuman, "pi-workflow-needs-human-discord-status", options),
  ];

  const connection = await connect({
    apps: [{ client: inngest, functions }],
    gatewayUrl: process.env.INNGEST_CONNECT_GATEWAY_URL,
    handleShutdownSignals: [],
  });

  console.log("link ingest status bridge connected to Central Inngest");
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await connection.close();
  };
}

function createStatusFunction(
  inngest: Inngest,
  eventName: string,
  functionId: string,
  options: LinkIngestStatusBridgeOptions,
) {
  return inngest.createFunction(
    {
      id: functionId,
      retries: 3,
      triggers: { event: eventName },
    },
    async ({ event, step }) => {
      const statusEvent = normalizeStatusEvent(event);
      if (!statusEvent) return { ignored: true, reason: "unsupported status event" };

      const target = await step.run("resolve-discord-target", async () => {
        const existing = options.registry.getLinkIngestStatusUpdate(statusEvent.mentionId, statusEvent.statusKey);
        if (existing) return { skip: true as const, reason: "already-posted", discordMessageId: existing.discordMessageId };

        const record = options.registry.getLinkIngest(statusEvent.mentionId)
          ?? await recoverLinkIngestRecord(options.registry, statusEvent);
        const threadId = record?.threadId ?? statusEvent.discord?.threadId;
        if (!threadId) return { skip: true as const, reason: "missing-thread" };

        return {
          skip: false as const,
          threadId,
          record,
        };
      });

      if (target.skip) return target;

      const posted = await step.run("post-or-skip-discord-status", async () => {
        if (!shouldPostLinkIngestStatusToDiscord(statusEvent.status)) {
          return {
            posted: false as const,
            reason: "progress-event-recorded-only",
            threadId: target.threadId,
          };
        }

        const channel = await options.client.channels.fetch(target.threadId);
        if (!isSendableChannel(channel)) {
          throw new Error(`terminal link-ingest status target is not sendable: ${target.threadId}`);
        }

        const message = await channel.send(await buildStatusPayload(statusEvent, options.config));
        return {
          posted: true as const,
          threadId: target.threadId,
          discordMessageId: message.id,
        };
      });

      await step.run("record-discord-status", async () => {
        const postedAt = statusEvent.occurredAt ?? new Date().toISOString();
        const update: LinkIngestStatusUpdateRecord = {
          statusKey: statusEvent.statusKey,
          eventName: statusEvent.eventName,
          sourceId: statusEvent.sourceId,
          mentionId: statusEvent.mentionId,
          status: statusEvent.status,
          ...(posted.posted ? { discordMessageId: posted.discordMessageId } : { discordPostSkippedReason: posted.reason }),
          ...(statusEvent.brainPath ? { brainPath: statusEvent.brainPath } : {}),
          ...(statusEvent.manifestPath ? { manifestPath: statusEvent.manifestPath } : {}),
          ...(statusEvent.sourceType ? { sourceType: statusEvent.sourceType } : {}),
          postedAt,
        };
        if (target.record) {
          await options.registry.recordLinkIngestStatusUpdate(update);
          if (posted.posted) {
            await options.registry.recordMessage({
              discordMessageId: posted.discordMessageId,
              threadId: posted.threadId,
              direction: "assistant",
              createdAt: postedAt,
            });
          }
        }
      });

      return {
        posted: posted.posted,
        recorded: Boolean(target.record),
        status: statusEvent.status,
        sourceId: statusEvent.sourceId,
        mentionId: statusEvent.mentionId,
        threadId: posted.threadId,
        ...(posted.posted ? { discordMessageId: posted.discordMessageId } : { reason: posted.reason }),
      };
    },
  );
}

async function recoverLinkIngestRecord(
  registry: RegistryPort,
  event: NormalizedStatusEvent,
) {
  const discord = event.discord;
  if (!discord?.threadId || !event.normalizedUrl) return undefined;

  const now = event.occurredAt ?? new Date().toISOString();
  await registry.upsertLinkIngest({
    sourceId: event.sourceId,
    mentionId: event.mentionId,
    eventId: `recovered:${event.mentionId}`,
    eventName: "link/ingest.requested",
    url: event.normalizedUrl,
    normalizedUrl: event.normalizedUrl,
    threadId: discord.threadId,
    channelId: discord.channelId ?? discord.threadId,
    ...(discord.guildId ? { guildId: discord.guildId } : {}),
    ...(discord.messageId ? { discordMessageId: discord.messageId } : {}),
    ...(discord.interactionId ? { interactionId: discord.interactionId } : {}),
    ...(discord.authorId ? { authorId: discord.authorId } : {}),
    status: event.status,
    createdAt: now,
    updatedAt: now,
  });
  return registry.getLinkIngest(event.mentionId);
}

async function prepareInngestConnectEnv(config: AppConfig, secrets: SecretResolver): Promise<void> {
  const eventKey = await secrets.resolveRequired({
    envName: config.linkIngest.eventKeyEnv,
    secretName: config.linkIngest.eventKeySecretName,
    ttl: config.linkIngest.eventKeyLeaseTtl,
    label: "Inngest event key",
  });
  const signingKey = await secrets.resolveRequired({
    envName: config.linkIngest.signingKeyEnv,
    secretName: config.linkIngest.signingKeySecretName,
    ttl: config.linkIngest.signingKeyLeaseTtl,
    label: "Inngest signing key",
  });

  process.env.INNGEST_EVENT_KEY = eventKey.trim();
  process.env.INNGEST_SIGNING_KEY = signingKey.trim();
  process.env.INNGEST_BASE_URL = config.linkIngest.inngestUrl;
  process.env.INNGEST_DEV = process.env.INNGEST_DEV ?? "0";
}

function normalizeStatusEvent(event: { name?: string; data?: unknown }): NormalizedStatusEvent | undefined {
  const data = isRecord(event.data) ? event.data : {};
  const eventName = event.name ?? "";
  const status = statusFromEvent(eventName, optionalString(data.status));
  if (!status) return undefined;

  const sourceId = optionalString(data.sourceId);
  const mentionId = optionalString(data.mentionId);
  if (!sourceId || !mentionId) return undefined;

  const sourceType = optionalString(data.sourceType) || optionalString(asRecord(data.classification)?.sourceType);
  const occurredAt = optionalString(data.acceptedAt) || optionalString(data.classifiedAt) || optionalString(data.completedAt);
  return {
    eventName,
    status,
    statusKey: `${eventName}:${mentionId}`,
    sourceId,
    mentionId,
    normalizedUrl: optionalString(data.normalizedUrl),
    brainPath: optionalString(data.brainPath),
    manifestPath: optionalString(data.manifestPath),
    sourceType,
    plannedNextEvent: optionalString(data.plannedNextEvent),
    dispatchHold: optionalString(data.dispatchHold),
    archiveStatus: optionalString(data.archiveStatus),
    videoStatus: optionalString(data.videoStatus),
    mediaStatus: optionalString(data.mediaStatus),
    audioTranscriptStatus: optionalString(data.audioTranscriptStatus),
    videoTitle: optionalString(data.title),
    authorName: optionalString(data.authorName),
    thumbnailUrl: optionalString(data.thumbnailUrl),
    articleStatus: optionalString(data.articleStatus),
    xStatus: optionalString(data.xStatus),
    username: optionalString(data.username),
    postId: optionalString(data.postId),
    transcriptStatus: optionalString(data.transcriptStatus),
    summaryStatus: optionalString(data.summaryStatus),
    indexStatus: optionalString(data.indexStatus),
    failureStatus: optionalString(data.failureStatus),
    failedStep: optionalString(data.failedStep),
    reason: optionalString(data.reason),
    errorMessage: optionalString(data.errorMessage),
    errorName: optionalString(data.errorName),
    contextSummary: optionalString(data.contextSummary),
    question: optionalString(data.question),
    confidence: optionalString(data.confidence),
    assetDir: optionalString(data.assetDir),
    mediaPath: optionalString(data.mediaPath),
    infoPath: optionalString(data.infoPath),
    thumbnailPath: optionalString(data.thumbnailPath),
    itemPath: optionalString(data.itemPath),
    aggregatePath: optionalString(data.aggregatePath),
    jsonlPath: optionalString(data.jsonlPath),
    textPath: optionalString(data.textPath),
    transcriptPath: optionalString(data.transcriptPath),
    vttPath: optionalString(data.vttPath),
    summaryPath: optionalString(data.summaryPath),
    metadataPath: optionalString(data.metadataPath),
    wordCount: finiteNumber(data.wordCount),
    charCount: finiteNumber(data.charCount),
    bytes: typeof data.bytes === "number" && Number.isFinite(data.bytes) ? data.bytes : undefined,
    documentCount: finiteNumber(data.documentCount),
    searchTextBytes: finiteNumber(data.searchTextBytes),
    pageCreated: typeof data.pageCreated === "boolean" ? data.pageCreated : undefined,
    discord: normalizeDiscord(data.discord),
    occurredAt,
  };
}

function statusFromEvent(eventName: string, status: string | undefined): LinkIngestStatus | undefined {
  if (eventName === STATUS_EVENTS.accepted || status === "accepted") return "accepted";
  if (eventName === STATUS_EVENTS.classified || status === "classified") return "classified";
  if (eventName === STATUS_EVENTS.archiveCompleted || status === "archived") return "archived";
  if (eventName === STATUS_EVENTS.videoMetadataCompleted || status === "video_metadata") return "video_metadata";
  if (eventName === STATUS_EVENTS.videoMediaCompleted || status === "video_media") return "video_media";
  if (eventName === STATUS_EVENTS.videoAudioTranscriptCompleted || status === "audio_transcript") return "audio_transcript";
  if (eventName === STATUS_EVENTS.articleExtractCompleted || status === "article_extracted") return "article_extracted";
  if (eventName === STATUS_EVENTS.xSnapshotCompleted || status === "x_snapshot") return "x_snapshot";
  if (eventName === STATUS_EVENTS.transcriptCompleted || status === "transcript_processed") return "transcript_processed";
  if (eventName === STATUS_EVENTS.summaryCompleted || status === "summarized") return "summarized";
  if (eventName === STATUS_EVENTS.captureReady || status === "ready") return "ready";
  if (eventName === STATUS_EVENTS.captureIndexCompleted || status === "indexed") return "indexed";
  if (eventName === STATUS_EVENTS.piWorkflowNeedsHuman || status === "needs_human") return "needs_human";
  if (eventName === STATUS_EVENTS.captureFailed || status === "failed") return "failed";
  return undefined;
}

async function buildStatusPayload(event: NormalizedStatusEvent, config: AppConfig): Promise<MessageCreateOptions> {
  const manifest = event.status === "indexed" ? await readCompletionManifest(event, config) : undefined;
  return {
    content: renderLinkIngestCompletionMessage(toCompletionMessageInput(event, manifest)),
    allowedMentions: { parse: [] },
  };
}

export interface LinkIngestCompletionMessageInput {
  status: LinkIngestStatus;
  title?: string;
  sourceType?: string;
  normalizedUrl?: string;
  summary?: string;
  highlights?: string[];
  brainPath?: string;
  manifestPath?: string;
  reason?: string;
  errorMessage?: string;
  errorName?: string;
  failedStep?: string;
  contextSummary?: string;
  question?: string;
  confidence?: string;
}

export function renderLinkIngestCompletionMessage(input: LinkIngestCompletionMessageInput): string {
  if (input.status === "failed") return renderLinkIngestFailureMessage(input);
  if (input.status === "needs_human") return renderLinkIngestNeedsHumanMessage(input);

  const title = displayTitle(input);
  const summary = cleanSentence(input.summary)
    || "Captured and indexed. No useful summary came back, so treat this as a saved source, not a finished recommendation.";
  const highlights = normalizedHighlights(input.highlights, summary).slice(0, 3);
  const lines = [
    `✅ Captured: ${title}`,
    "",
    truncateForDiscord(summary, 420),
    "",
    "**Why it's interesting**",
    ...highlights.map((highlight) => `- ${truncateForDiscord(highlight, 220)}`),
    "",
    "**How you can use it**",
    `- ${usageLine(input)}`,
    "",
    `**Should you ${watchVerb(input)} it?**`,
    `- ${recommendationLine(input)}`,
    "",
    receiptLine(input),
  ].filter((line) => line !== undefined);

  return truncateForDiscord(lines.join("\n"), 1_900);
}

function renderLinkIngestNeedsHumanMessage(input: LinkIngestCompletionMessageInput): string {
  const title = displayTitle(input);
  const summary = cleanSentence(input.contextSummary) || cleanSentence(input.summary) || cleanSentence(input.reason) || "The ingest hit an ambiguous source and needs a human nudge.";
  const question = cleanSentence(input.question) || "What should I preserve from this source?";
  const confidence = cleanSentence(input.confidence);
  const lines = [
    `🤔 Capture needs a nudge: ${title}`,
    "",
    truncateForDiscord(summary, 520),
    confidence ? `Confidence: ${confidence}` : undefined,
    "",
    "**Question**",
    `- ${truncateForDiscord(question, 400)}`,
    "",
    "**What to do**",
    "- Reply with the missing context, paste the useful bit, or say `skip` if this is not worth saving.",
    receiptLine(input),
  ].filter((line): line is string => Boolean(line));
  return truncateForDiscord(lines.join("\n"), 1_900);
}

function renderLinkIngestFailureMessage(input: LinkIngestCompletionMessageInput): string {
  const title = displayTitle(input);
  const reason = cleanSentence(input.reason) || cleanSentence(input.errorMessage) || "Central marked this capture failed.";
  const failedStep = cleanSentence(input.failedStep);
  const lines = [
    `❌ Capture failed: ${title}`,
    "",
    failedStep ? `Failed at: ${failedStep}` : undefined,
    truncateForDiscord(reason, 600),
    "",
    "**What to do**",
    "- If the source needs login, weird JS, or a flaky media tool, try the URL again or paste the important bit directly.",
    receiptLine(input),
  ].filter((line): line is string => Boolean(line));
  return truncateForDiscord(lines.join("\n"), 1_900);
}

function toCompletionMessageInput(event: NormalizedStatusEvent, manifest: Record<string, unknown> | undefined): LinkIngestCompletionMessageInput {
  const summary = asRecord(manifest?.summary);
  const video = asRecord(manifest?.video);
  const article = asRecord(manifest?.article);
  const x = asRecord(manifest?.x);
  return {
    status: event.status,
    title: optionalString(manifest?.title)
      || optionalString(video?.title)
      || optionalString(article?.title)
      || optionalString(x?.text)
      || event.videoTitle,
    sourceType: optionalString(manifest?.sourceType) || event.sourceType,
    normalizedUrl: optionalString(manifest?.normalizedUrl) || event.normalizedUrl,
    summary: optionalString(summary?.summary),
    highlights: arrayOfStrings(summary?.highlights),
    brainPath: optionalString(manifest?.brainPath) || event.brainPath,
    manifestPath: optionalString(manifest?.manifestPath) || event.manifestPath,
    reason: event.reason,
    errorMessage: event.errorMessage,
    errorName: event.errorName,
    failedStep: event.failedStep,
    contextSummary: event.contextSummary,
    question: event.question,
    confidence: event.confidence,
  };
}

async function readCompletionManifest(event: NormalizedStatusEvent, config: AppConfig): Promise<Record<string, unknown> | undefined> {
  const resolved = resolveManifestPath(event.manifestPath, config);
  if (!resolved) return undefined;
  try {
    const parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    console.warn(`link ingest completion summary unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function resolveManifestPath(value: string | undefined, config: AppConfig): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  const brainRoot = expandPath(config.linkIngest.brainRoot || process.env.LINK_INGEST_BRAIN_ROOT || "/Users/joel/Code/joelhooks/dark-wizard/.brain");
  const withoutBrainPrefix = value.replace(/^\.brain\//u, "");
  return path.join(brainRoot, withoutBrainPrefix);
}

function displayTitle(input: LinkIngestCompletionMessageInput): string {
  return truncateForDiscord(cleanSentence(input.title) || cleanSentence(input.normalizedUrl) || "saved source", 180);
}

function normalizedHighlights(highlights: string[] | undefined, summary: string): string[] {
  const clean = (highlights ?? [])
    .map(cleanSentence)
    .filter((item): item is string => Boolean(item));
  if (clean.length > 0) return clean;
  return [summary];
}

function usageLine(input: LinkIngestCompletionMessageInput): string {
  const type = normalizedSourceType(input);
  if (type === "video") return "Use the summary/transcript as the fast path; pull the video when you need tone, demo detail, or quotable context.";
  if (type === "x" || type === "x_post") return "Treat it like an idea seed: stash the phrasing, follow the links, and only expand it if it connects to active work.";
  if (type === "article") return "Use it as a reference source. The capture is indexed, so you can search it later instead of reopening browser-tab soup.";
  return "Use it as a saved source in the Brain. Search will find it later when the context matters.";
}

function recommendationLine(input: LinkIngestCompletionMessageInput): string {
  const type = normalizedSourceType(input);
  const hasSummary = Boolean(cleanSentence(input.summary));
  if (type === "video") return hasSummary
    ? "Skim the summary first. Watch only if the bullets hit something you're building or you need the original vibe."
    : "Probably watch it if you cared enough to drop it; the capture didn't produce a useful summary.";
  if (type === "article") return hasSummary
    ? "Read it only if you're going to cite it, teach from it, or turn it into work. Otherwise the summary is enough."
    : "Open it if you need the details. The ingest saved it, but didn't give us much signal.";
  if (type === "x" || type === "x_post") return "Probably don't camp on it. Use it as a pointer unless the thread/source is clearly part of current work.";
  return hasSummary ? "Skim the summary now; come back to the source only if it maps to active work." : "Open the source if this was important; the completion receipt is thin.";
}

function watchVerb(input: LinkIngestCompletionMessageInput): string {
  const type = normalizedSourceType(input);
  if (type === "video") return "watch";
  if (type === "article") return "read";
  if (type === "x" || type === "x_post") return "open";
  return "open";
}

function receiptLine(input: LinkIngestCompletionMessageInput): string {
  const brainPath = cleanSentence(input.brainPath);
  if (brainPath) return `Brain: \`${truncateForDiscord(brainPath.replace(/`/gu, "'"), 900)}\``;
  const manifestPath = cleanSentence(input.manifestPath);
  if (manifestPath) return `Manifest: \`${truncateForDiscord(manifestPath.replace(/`/gu, "'"), 900)}\``;
  return cleanSentence(input.normalizedUrl) || "Indexed in the capture registry.";
}

function normalizedSourceType(input: LinkIngestCompletionMessageInput): string {
  return (input.sourceType || "").trim().toLowerCase();
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function cleanSentence(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+/gu, " ").trim() || undefined;
}

function truncateForDiscord(value: string, maxChars: number): string {
  const clean = value.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (!channel || typeof channel !== "object") return false;
  return "send" in channel && typeof (channel as { send?: unknown }).send === "function";
}

function normalizeDiscord(value: unknown): NormalizedStatusEvent["discord"] {
  if (!isRecord(value)) return undefined;
  const discord: NonNullable<NormalizedStatusEvent["discord"]> = {};
  for (const key of ["guildId", "channelId", "threadId", "messageId", "interactionId", "authorId"] as const) {
    const item = optionalString(value[key]);
    if (item) discord[key] = item;
  }
  return Object.keys(discord).length > 0 ? discord : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
