import {
  Client,
  EmbedBuilder,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { Inngest } from "inngest";
import { connect } from "inngest/connect";
import type { AppConfig } from "./config.js";
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
} as const;

type LinkIngestStatus = "accepted" | "classified" | "archived" | "video_metadata" | "video_media" | "audio_transcript" | "article_extracted" | "x_snapshot" | "transcript_processed" | "summarized" | "ready" | "indexed" | "failed";

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

      const posted = await step.run("post-discord-status", async () => {
        const channel = await options.client.channels.fetch(target.threadId);
        if (!isSendableChannel(channel)) {
          return { posted: false as const, reason: "thread-not-sendable", threadId: target.threadId };
        }

        const message = await channel.send(buildStatusPayload(statusEvent));
        return {
          posted: true as const,
          threadId: target.threadId,
          discordMessageId: message.id,
        };
      });

      if (!posted.posted) return posted;

      await step.run("record-discord-status", async () => {
        const postedAt = statusEvent.occurredAt ?? new Date().toISOString();
        const update: LinkIngestStatusUpdateRecord = {
          statusKey: statusEvent.statusKey,
          eventName: statusEvent.eventName,
          sourceId: statusEvent.sourceId,
          mentionId: statusEvent.mentionId,
          status: statusEvent.status,
          discordMessageId: posted.discordMessageId,
          ...(statusEvent.brainPath ? { brainPath: statusEvent.brainPath } : {}),
          ...(statusEvent.manifestPath ? { manifestPath: statusEvent.manifestPath } : {}),
          ...(statusEvent.sourceType ? { sourceType: statusEvent.sourceType } : {}),
          postedAt,
        };
        if (target.record) {
          await options.registry.recordLinkIngestStatusUpdate(update);
          await options.registry.recordMessage({
            discordMessageId: posted.discordMessageId,
            threadId: posted.threadId,
            direction: "assistant",
            createdAt: postedAt,
          });
        }
      });

      return {
        posted: true,
        status: statusEvent.status,
        sourceId: statusEvent.sourceId,
        mentionId: statusEvent.mentionId,
        threadId: posted.threadId,
        discordMessageId: posted.discordMessageId,
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
  if (eventName === STATUS_EVENTS.captureFailed || status === "failed") return "failed";
  return undefined;
}

function buildStatusPayload(event: NormalizedStatusEvent): MessageCreateOptions {
  const isFailed = event.status === "failed";
  const isClassified = event.status === "classified";
  const isArchived = event.status === "archived";
  const isVideoMetadata = event.status === "video_metadata";
  const isVideoMedia = event.status === "video_media";
  const isAudioTranscript = event.status === "audio_transcript";
  const isArticleExtracted = event.status === "article_extracted";
  const isXSnapshot = event.status === "x_snapshot";
  const isTranscriptProcessed = event.status === "transcript_processed";
  const isSummarized = event.status === "summarized";
  const isReady = event.status === "ready";
  const isIndexed = event.status === "indexed";
  const embed = new EmbedBuilder()
    .setColor(isFailed ? 0xed4245 : isIndexed ? 0x57f287 : isReady ? 0x57f287 : isSummarized ? 0x57f287 : isTranscriptProcessed ? 0x57f287 : isAudioTranscript ? 0x57f287 : isVideoMedia ? 0x57f287 : isXSnapshot ? 0x57f287 : isArticleExtracted ? 0x57f287 : isVideoMetadata ? 0x57f287 : isArchived ? 0xfee75c : isClassified ? 0x57f287 : 0x5865f2)
    .setTitle(isFailed ? "Capture failed" : isIndexed ? "Capture indexed" : isReady ? "Capture ready" : isSummarized ? "Summary written" : isTranscriptProcessed ? "Transcript processed" : isAudioTranscript ? "Audio transcription processed" : isVideoMedia ? "Video media downloaded" : isXSnapshot ? "X snapshot captured" : isArticleExtracted ? "Article text extracted" : isVideoMetadata ? "Video metadata captured" : isArchived ? "Source archived" : isClassified ? "Link classified" : "Link ingest worker accepted")
    .setDescription(isFailed
      ? "Central marked this capture failed and wrote the failure receipt to the Brain manifest."
      : isIndexed
      ? "The ready capture was written into the Brain capture index for search and future projection."
      : isReady
      ? "The capture reached ready and the Brain capture page has been updated."
      : isSummarized
      ? "A summary artifact is stored beside the capture assets and linked from the Brain manifest."
      : isTranscriptProcessed
      ? "Transcript processing finished. Captions are stored beside the capture assets when available; otherwise the manifest records the degraded reason."
      : isAudioTranscript
      ? "Audio transcription from the downloaded media finished or degraded with an explicit tool/runtime receipt."
      : isVideoMedia
      ? "The media artifact is stored beside the capture assets and linked from the Brain manifest."
      : isXSnapshot
      ? "X snapshot metadata and text are stored beside the source archive when available. Degraded access is recorded in the Brain manifest."
      : isArticleExtracted
      ? "Readable article text and metadata are stored beside the source archive and linked from the Brain manifest."
      : isVideoMetadata
      ? "YouTube metadata is stored beside the source archive and linked from the Brain manifest. Transcript/download are still pending."
      : isArchived
      ? "The first bounded source snapshot is stored outside `.brain` and linked from the manifest."
      : isClassified
      ? "The Brain manifest/page exists and the router picked the next processing lane."
      : "The Inngest worker picked up the request and wrote the first Brain receipt.")
    .addFields(
      { name: "sourceId", value: inlineCode(event.sourceId) },
      { name: "mentionId", value: inlineCode(event.mentionId) },
    );

  if (event.sourceType) embed.addFields({ name: "type", value: inlineCode(event.sourceType), inline: true });
  if (event.archiveStatus) embed.addFields({ name: "archive", value: inlineCode(event.archiveStatus), inline: true });
  if (event.videoStatus) embed.addFields({ name: "video", value: inlineCode(event.videoStatus), inline: true });
  if (event.mediaStatus) embed.addFields({ name: "media", value: inlineCode(event.mediaStatus), inline: true });
  if (event.audioTranscriptStatus) embed.addFields({ name: "audio transcript", value: inlineCode(event.audioTranscriptStatus), inline: true });
  if (event.articleStatus) embed.addFields({ name: "article", value: inlineCode(event.articleStatus), inline: true });
  if (event.xStatus) embed.addFields({ name: "x", value: inlineCode(event.xStatus), inline: true });
  if (event.transcriptStatus) embed.addFields({ name: "transcript", value: inlineCode(event.transcriptStatus), inline: true });
  if (event.summaryStatus) embed.addFields({ name: "summary", value: inlineCode(event.summaryStatus), inline: true });
  if (event.indexStatus) embed.addFields({ name: "index", value: inlineCode(event.indexStatus), inline: true });
  if (event.failureStatus) embed.addFields({ name: "failure", value: inlineCode(event.failureStatus), inline: true });
  if (event.failedStep) embed.addFields({ name: "failed step", value: inlineCode(event.failedStep), inline: true });
  if (typeof event.bytes === "number") embed.addFields({ name: "bytes", value: inlineCode(String(event.bytes)), inline: true });
  if (typeof event.wordCount === "number") embed.addFields({ name: "words", value: inlineCode(String(event.wordCount)), inline: true });
  if (typeof event.charCount === "number") embed.addFields({ name: "chars", value: inlineCode(String(event.charCount)), inline: true });
  if (typeof event.documentCount === "number") embed.addFields({ name: "documents", value: inlineCode(String(event.documentCount)), inline: true });
  if (typeof event.searchTextBytes === "number") embed.addFields({ name: "search bytes", value: inlineCode(String(event.searchTextBytes)), inline: true });
  if (event.plannedNextEvent) embed.addFields({ name: "next", value: inlineCode(event.plannedNextEvent), inline: true });
  if (event.videoTitle) embed.addFields({ name: "title", value: truncateForEmbed(event.videoTitle, 900) });
  if (event.authorName) embed.addFields({ name: "author", value: inlineCode(event.authorName), inline: true });
  if (event.username) embed.addFields({ name: "username", value: inlineCode(event.username), inline: true });
  if (event.postId) embed.addFields({ name: "post", value: inlineCode(event.postId), inline: true });
  if (event.thumbnailUrl) embed.addFields({ name: "thumbnail", value: truncateForEmbed(event.thumbnailUrl, 900) });
  if (event.assetDir) embed.addFields({ name: "assetDir", value: inlineCode(event.assetDir) });
  if (event.mediaPath) embed.addFields({ name: "mediaPath", value: inlineCode(event.mediaPath) });
  if (event.infoPath) embed.addFields({ name: "info", value: inlineCode(event.infoPath) });
  if (event.thumbnailPath) embed.addFields({ name: "thumbnailPath", value: inlineCode(event.thumbnailPath) });
  if (event.itemPath) embed.addFields({ name: "index item", value: inlineCode(event.itemPath) });
  if (event.aggregatePath) embed.addFields({ name: "index aggregate", value: inlineCode(event.aggregatePath) });
  if (event.jsonlPath) embed.addFields({ name: "index jsonl", value: inlineCode(event.jsonlPath) });
  if (event.textPath) embed.addFields({ name: "text", value: inlineCode(event.textPath) });
  if (event.transcriptPath) embed.addFields({ name: "transcriptPath", value: inlineCode(event.transcriptPath) });
  if (event.vttPath) embed.addFields({ name: "vtt", value: inlineCode(event.vttPath) });
  if (event.summaryPath) embed.addFields({ name: "summaryPath", value: inlineCode(event.summaryPath) });
  if (event.metadataPath) embed.addFields({ name: "metadata", value: inlineCode(event.metadataPath) });
  if (event.brainPath) embed.addFields({ name: "brain", value: inlineCode(event.brainPath) });
  if (event.manifestPath) embed.addFields({ name: "manifest", value: inlineCode(event.manifestPath) });
  if (event.normalizedUrl) embed.addFields({ name: "url", value: truncateForEmbed(event.normalizedUrl, 900) });
  if (event.dispatchHold) embed.addFields({ name: "dispatch", value: truncateForEmbed(event.dispatchHold, 900) });
  if (event.reason) embed.addFields({ name: "reason", value: truncateForEmbed(event.reason, 900) });
  if (event.errorMessage) embed.addFields({ name: event.errorName ? `error: ${event.errorName}` : "error", value: truncateForEmbed(event.errorMessage, 900) });

  embed.setFooter({ text: event.pageCreated === false ? "canonical Brain page already existed" : "status from Central Inngest" });
  return { embeds: [embed] };
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

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function truncateForEmbed(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
