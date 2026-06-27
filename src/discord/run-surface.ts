import type { Client, Message, MessageCreateOptions } from "discord.js";
import type { RegistryPort, ThreadRecord } from "../registry.js";
import { DiscordMessageRenderer } from "./message-renderer.js";
import { buildArchivedHudPayload } from "./payloads.js";
import type { ProgressHudSnapshot } from "./progress-hud-machine.js";
import type { SessionMemoryLink } from "../session-memory.js";

export type PromptChannel = {
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping(): Promise<void>;
  messages: {
    fetch(messageId: string): Promise<Message>;
  };
  isThread?: () => boolean;
};

export async function resolvePromptChannel(client: Client, record: ThreadRecord): Promise<PromptChannel> {
  if (record.kind === "discord-dm-workroom") {
    if (!record.discordUserId) throw new Error(`DM workroom ${record.threadId} has no Discord user id`);
    const user = await client.users.fetch(record.discordUserId);
    return await user.createDM();
  }

  const channel = await client.channels.fetch(record.threadId);
  if (!channel || !isPromptChannelLike(channel)) {
    throw new Error(`Discord channel ${record.threadId} is not sendable for Pi run ${record.activeRun?.runId ?? "unknown"}`);
  }
  return channel;
}

function isPromptChannelLike(value: unknown): value is PromptChannel {
  const channel = value as Partial<PromptChannel> | undefined;
  return Boolean(channel
    && typeof channel.send === "function"
    && typeof channel.sendTyping === "function"
    && typeof channel.messages?.fetch === "function");
}

export async function fetchPromptChannelMessage(channel: PromptChannel, messageId: string): Promise<Message> {
  const withMessages = channel as PromptChannel & { messages?: { fetch(messageId: string): Promise<Message> } };
  if (!withMessages.messages) throw new Error("Prompt channel cannot fetch Discord messages");
  return withMessages.messages.fetch(messageId);
}

export async function fetchPlaceholderMessage(channel: PromptChannel, messageId: string): Promise<Message> {
  return fetchPromptChannelMessage(channel, messageId);
}

export async function sendFinalResponseMessages(
  channel: PromptChannel,
  record: ThreadRecord,
  registry: RegistryPort,
  chunks: string[],
  assistantEntryId: string | undefined,
): Promise<void> {
  let firstMessageId: string | undefined;
  for (const chunk of chunks) {
    const sent = await channel.send({ content: chunk });
    await registry.recordMessage({
      discordMessageId: sent.id,
      threadId: record.threadId,
      direction: "assistant",
      createdAt: new Date().toISOString(),
    });
    firstMessageId ??= sent.id;
  }
  if (firstMessageId) {
    await registry.recordMessageEntry(firstMessageId, assistantEntryId);
  }
}

export async function archiveWorkingHud(
  placeholder: Message,
  record: ThreadRecord,
  snapshot?: ProgressHudSnapshot,
  sessionMemory?: SessionMemoryLink,
): Promise<void> {
  // Archive is best-effort after final text posts. Do not turn a posted final answer
  // into a run-control failure just because Discord refused the terminal HUD edit;
  // once activeRun clears, stale ESC clicks are still rejected by expectedMessageId.
  const renderer = new DiscordMessageRenderer(placeholder, {
    onError(error) {
      console.warn(`failed to archive run HUD ${placeholder.id}: ${error.message}`);
    },
  });
  await renderer.deactivate(buildArchivedHudPayload(snapshot?.record ?? record, { ...snapshot, sessionMemory }));
}
