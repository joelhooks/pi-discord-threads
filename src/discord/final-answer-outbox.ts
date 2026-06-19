import { createHash } from "node:crypto";
import type { Message, MessageCreateOptions } from "discord.js";
import type { RegistryPort, ThreadRecord } from "../registry.js";
import type { RunControlStorePort, RunRecord } from "../run-control/types.js";

const FINAL_OUTBOX_BLIND_NONCE_WINDOW_MS = 2 * 60_000;

export interface FinalAnswerOutboxChannel {
  send(options: MessageCreateOptions): Promise<Message>;
  messages: {
    fetch(messageId: string): Promise<Message>;
  };
}

export interface DeliverFinalAnswerOutboxInput {
  channel: FinalAnswerOutboxChannel;
  record: ThreadRecord;
  registry: RegistryPort;
  store: RunControlStorePort;
  run: RunRecord;
  chunks: string[];
  assistantEntryId: string | undefined;
}

export function finalAnswerOutboxNonce(runId: string, index: number): string {
  const digest = createHash("sha1").update(`${runId}:${index}`).digest("hex").slice(0, 16);
  return `fa:${digest}:${index}`.slice(0, 25);
}

export async function deliverFinalAnswerOutbox(input: DeliverFinalAnswerOutboxInput): Promise<void> {
  const messages = await ensureFinalAnswerReservations(input);
  const messageIds = messages.map((message) => message.id);

  for (let index = 0; index < input.chunks.length; index++) {
    await messages[index].edit({ content: input.chunks[index] });
    await input.registry.recordMessage({
      discordMessageId: messages[index].id,
      threadId: input.record.threadId,
      direction: "assistant",
      createdAt: new Date().toISOString(),
    });
  }

  const firstMessageId = messageIds[0];
  if (firstMessageId) {
    await input.registry.recordMessageEntry(firstMessageId, input.assistantEntryId);
  }

  await input.store.patchRun(input.run.runId, {
    finalDiscordMessageIds: messageIds,
    finalDiscordChunkCount: input.chunks.length,
    finalDiscordPostedAt: new Date().toISOString(),
  }, { preserveTerminal: true });
  await input.store.appendRunEvent(input.run.runId, "final_outbox_posted", {
    messageIds,
    chunkCount: input.chunks.length,
  }).catch(() => undefined);
}

async function ensureFinalAnswerReservations(input: DeliverFinalAnswerOutboxInput): Promise<Message[]> {
  const latestRun = await input.store.getRun(input.run.runId).catch(() => undefined);
  const messageIds = [...(latestRun?.finalDiscordMessageIds ?? input.run.finalDiscordMessageIds ?? [])];
  const startedAt = latestRun?.finalDiscordOutboxStartedAt ?? new Date().toISOString();
  const reservedAt = latestRun?.finalDiscordReservedAt ?? startedAt;
  const startedAtMs = Date.parse(startedAt);
  const blindNonceExpired = Number.isFinite(startedAtMs) && Date.now() - startedAtMs > FINAL_OUTBOX_BLIND_NONCE_WINDOW_MS;
  const expectedChunkCount = latestRun?.finalDiscordChunkCount ?? input.run.finalDiscordChunkCount ?? input.chunks.length;
  const messages: Message[] = [];

  if (blindNonceExpired && messageIds.length < input.chunks.length) {
    throw new Error(`final answer outbox ${input.run.runId} has only ${messageIds.length}/${input.chunks.length} message id(s) after nonce recovery window; refusing blind send`);
  }

  if (!latestRun?.finalDiscordOutboxStartedAt || latestRun?.finalDiscordChunkCount !== input.chunks.length) {
    await input.store.patchRun(input.run.runId, {
      finalDiscordOutboxStartedAt: startedAt,
      finalDiscordChunkCount: expectedChunkCount,
    }, { preserveTerminal: true });
  }

  for (let index = 0; index < input.chunks.length; index++) {
    const existing = messageIds[index] ? await fetchOutboxMessage(input.channel, messageIds[index]) : undefined;
    if (existing) {
      messages.push(existing);
      continue;
    }

    const reserved = await input.channel.send({
      content: reservationContent(index, input.chunks.length),
      nonce: finalAnswerOutboxNonce(input.run.runId, index),
      enforceNonce: true,
    });
    messageIds[index] = reserved.id;
    messages.push(reserved);
    await input.store.patchRun(input.run.runId, {
      finalizeAttemptedAt: startedAt,
      finalDiscordOutboxStartedAt: startedAt,
      finalDiscordMessageIds: messageIds.slice(0, index + 1),
      finalDiscordChunkCount: expectedChunkCount,
      finalDiscordReservedAt: reservedAt,
    }, { preserveTerminal: true });
    await input.store.appendRunEvent(input.run.runId, "final_outbox_reserved", {
      messageId: reserved.id,
      index,
      chunkCount: input.chunks.length,
    }).catch(() => undefined);
  }

  return messages;
}

async function fetchOutboxMessage(channel: FinalAnswerOutboxChannel, messageId: string): Promise<Message | undefined> {
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (isUnknownDiscordMessageError(error)) return undefined;
    throw error;
  }
}

function isUnknownDiscordMessageError(error: unknown): boolean {
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown } | undefined;
  return candidate?.code === 10008
    || candidate?.status === 404
    || /Unknown Message/i.test(String(candidate?.message ?? ""));
}

function reservationContent(index: number, total: number): string {
  const suffix = total > 1 ? ` ${index + 1}/${total}` : "";
  return `⏳ Reserving final answer slot${suffix}…`;
}
