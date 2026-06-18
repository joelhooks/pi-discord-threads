import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from "discord.js";
import { DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { appendAttachmentContext, type InlineImageContent } from "./attachments.js";
import type { AppConfig, RunControlRole } from "./config.js";
import type { PiRuntimePort } from "./pi-runtime.js";
import { createProgressEventBus } from "./progress-events.js";
import type { ActiveRunRecord, LinkIngestRecord, RegistryPort, ThreadRecord } from "./registry.js";
import {
  listWorkspaces,
  parseLeadingCwdFlag,
  parseWorkspaceCommand,
  resolveContextChannelDefault,
  resolveCwdInput,
  resolveWorkspaceInput,
  workspaceUsage,
} from "./cwd.js";
import { applicationCommands, askPiMessageCommandName } from "./discord-commands.js";
import { DISCORD_SYSTEM_PROMPT_URL } from "./discord-system-prompt.js";
import { chunkForDiscord, stripBotMention, stripCommandPrefix, summarizeForThreadName } from "./render.js";
import { startAsyncSubagentResultBridge } from "./discord/async-subagent-result-bridge.js";
import { DiscordMessageRenderer } from "./discord/message-renderer.js";
import { createProgressHudController, type ProgressHudSnapshot } from "./discord/progress-hud-machine.js";
import {
  buildArchivedHudPayload,
  buildErrorPayload,
  buildFinalizingBusyPayload,
  buildInterruptedRunPayload,
  buildQueuedPayload,
  buildQueuedRunPayload,
  buildWorkingPayload,
  formatQueuedText,
  type RichPayload,
} from "./discord/payloads.js";
import { maybeEvaluateThreadTitle, maybeRenameThreadForPrompt, recordCompletedTitleTurn } from "./discord/thread-title.js";
import type { QueuedRunInput, RunControlExecutionResult, RunControlStorePort, RunRecord } from "./run-control/types.js";
import { RunControlWorker, type RunControlWorkerAdapter } from "./run-control/worker.js";
import { createForkedSessionFile, forkWorkGraph, formatWorkGraphEmbedDescription, formatWorkGraphStatus, rootWorkGraph } from "./work-graph.js";
import { isBridgeRecoveryPrompt, recoverableInterruptedPrompt } from "./recovery-prompt.js";
import { startupRecoveryEnabled } from "./startup-recovery.js";
import { extractFirstUrl, postPreparedLinkIngest, prepareLinkIngest, type LinkIngestSendResult, type PreparedLinkIngest } from "./link-ingest.js";
import { buildLinkIngestCommandText, linkIngestAcceptedTitle, linkIngestUsage, parsePrefixLinkIngestCommand, type LinkIngestCommandMode } from "./link-ingest-command.js";
import { startLinkIngestStatusBridge, type StopLinkIngestStatusBridge } from "./link-ingest-status-bridge.js";

export interface RunBotOptions {
  config: AppConfig;
  token: string;
  allowedUserIds: string[];
  registry: RegistryPort;
  runtimeManager: PiRuntimePort;
  runControlStore?: RunControlStorePort;
  runControlRoles?: RunControlRole[];
  runControlWorkerId?: string;
  runControlStopReconcileLoop?: () => void;
}

export interface BotRuntimeHandle {
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

type PromptChannel = {
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping(): Promise<void>;
  isThread?: () => boolean;
};

export function startBot(options: RunBotOptions): BotRuntimeHandle {
  const allowedUsers = new Set(options.allowedUserIds.filter(Boolean));
  const roles = options.runControlRoles ?? ["bot"];
  const botIngressEnabled = roles.includes("bot");
  let runControlWorker: RunControlWorker | undefined;
  let stopAsyncSubagentBridge: (() => void) | undefined;
  let stopLinkIngestStatusBridge: StopLinkIngestStatusBridge | undefined;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  let readySettled = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    rejectReady = (error: unknown) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });

  client.once(Events.ClientReady, async () => {
    try {
      console.log(`pi-discord-threads logged in as ${client.user?.tag ?? "unknown bot"}`);
      if (allowedUsers.size > 0) {
        console.log(`allowlist enabled for ${allowedUsers.size} Discord user id(s)`);
      }
      if (botIngressEnabled) {
        await registerSlashCommands(client, options.config);
      }
      if (options.config.runControl.enabled && options.runControlStore && roles.includes("worker")) {
        runControlWorker = new RunControlWorker(
          options.runControlStore,
          createRunControlWorkerAdapter(client, options),
          options.config,
          options.runControlWorkerId ?? `${process.pid}`,
        );
        runControlWorker.start();
      }
      if (botIngressEnabled) {
        stopAsyncSubagentBridge = startAsyncSubagentResultBridge({
          registry: options.registry,
          maxDiscordChars: options.config.render.maxDiscordChars,
          publish: async (record, chunks) => {
            const channel = await resolvePromptChannel(client, record);
            await sendFinalResponseMessages(channel, record, options.registry, chunks, undefined);
          },
        });
        try {
          stopLinkIngestStatusBridge = await startLinkIngestStatusBridge({
            client,
            config: options.config,
            registry: options.registry,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          console.warn(`link ingest status bridge unavailable: ${text}`);
        }
        if (startupRecoveryEnabled()) {
          await autoResumeInterruptedThreads(client, options);
        } else {
          await reconcileInterruptedThreadPlaceholders(client, options);
        }
      }
      resolveReady();
    } catch (error) {
      rejectReady(error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!botIngressEnabled) return;
    try {
      if (interaction.isAutocomplete() && interaction.commandName === "pi") {
        await handlePiAutocomplete(interaction, options.config, options.registry);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith("pi:")) {
        await handlePiButton(interaction, options, allowedUsers);
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("pi:")) {
        await handlePiSelectMenu(interaction, options, allowedUsers);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith("pi:")) {
        await handlePiModal(interaction, options, allowedUsers);
        return;
      }

      if (interaction.isMessageContextMenuCommand() && interaction.commandName === askPiMessageCommandName) {
        await handleAskPiMessageContext(interaction, options, allowedUsers);
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "aih-triage") {
        await handleAihTriageInteraction(interaction, options, allowedUsers);
        return;
      }
      if (interaction.commandName !== "pi") return;
      await handlePiInteraction(interaction, options, allowedUsers);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`interaction failed: ${text}`);
      if (interaction.isChatInputCommand()) {
        await safeInteractionReply(interaction, `Pi bridge error: ${text}`);
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit() || interaction.isMessageContextMenuCommand()) {
        await replyEphemeral(interaction, `Pi bridge error: ${text}`).catch(() => undefined);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!botIngressEnabled) return;
    try {
      await handleMessage(message, client, options, allowedUsers);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`message handling failed: ${text}`);
      if (!message.author.bot) {
        await safeReply(message, `Pi bridge error: ${text}`);
      }
    }
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!readySettled) rejectReady(new Error("Discord bot stopped before ready"));
    options.runControlStopReconcileLoop?.();
    stopAsyncSubagentBridge?.();
    await stopLinkIngestStatusBridge?.();
    await runControlWorker?.stop();
    client.destroy();
  };

  void client.login(options.token).then(() => undefined).catch((error) => {
    rejectReady(error);
  });

  return { ready, stop };
}

export async function runBot(options: RunBotOptions): Promise<void> {
  const bot = startBot(options);
  await bot.ready;
}

async function registerSlashCommands(client: Client, config: AppConfig): Promise<void> {
  const guildIds = config.discord.guildIds.length > 0
    ? config.discord.guildIds
    : client.guilds.cache.map((guild) => guild.id);

  if (guildIds.length === 0) {
    console.warn("slash commands not registered: bot is not in any cached guilds");
    return;
  }

  const commandData = applicationCommands();
  for (const guildId of guildIds) {
    try {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      const commands = await guild.commands.fetch();
      for (const command of commandData) {
        const commandType = command.type ?? 1;
        const existing = commands.find((existingCommand) => existingCommand.name === command.name && existingCommand.type === commandType);
        if (existing) {
          await existing.edit(command);
        } else {
          await guild.commands.create(command);
        }
      }
      console.log(`registered ${commandData.length} command(s) in guild ${guildId}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`failed to register commands in guild ${guildId}: ${text}`);
    }
  }
}

async function autoResumeInterruptedThreads(client: Client, options: RunBotOptions): Promise<void> {
  const interrupted = options.registry.listThreads()
    .filter((record) => record.status === "interrupted" && record.activeRun?.placeholderDiscordMessageId && record.kind !== "discord-dm-workroom");
  if (interrupted.length === 0) return;

  let resumed = 0;
  let reconciled = 0;
  for (const record of interrupted) {
    try {
      const channel = await client.channels.fetch(record.threadId);
      if (!channel || typeof (channel as { isThread?: unknown }).isThread !== "function" || !(channel as { isThread: () => boolean }).isThread()) {
        continue;
      }
      const thread = channel as ThreadChannel;
      const placeholder = await thread.messages.fetch(record.activeRun?.placeholderDiscordMessageId ?? "");
      if (!record.activeRun?.prompt?.trim()) {
        await placeholder.edit(buildInterruptedRunPayload(record));
        reconciled++;
        continue;
      }

      const persistedFinal = getPersistedFinalAssistant(record);
      if (persistedFinal) {
        const chunks = chunkForDiscord(persistedFinal.text, options.config.render.maxDiscordChars);
        await sendFinalResponseMessages(thread, record, options.registry, chunks, persistedFinal.entryId);
        await archiveWorkingHud(placeholder, record);
        await options.registry.patchThread(record.threadId, { status: "idle", activeRun: undefined }).catch(() => undefined);
        reconciled++;
        continue;
      }

      if (options.config.runControl.enabled && options.runControlStore && record.activeRun.runId) {
        await options.runControlStore.markTerminal(record.activeRun.runId, "interrupted", {
          error: "bridge startup auto-resume superseded interrupted registry run",
        }).catch(() => undefined);
        await options.runControlStore.clearActiveIfMatches(record.threadId, record.activeRun.runId).catch(() => undefined);
      }

      if (isBridgeRecoveryPrompt(record.activeRun.prompt)) {
        console.warn(`skipping recursive auto-resume recovery prompt for interrupted thread ${record.threadId}`);
        await placeholder.edit(buildInterruptedRunPayload(record)).catch(() => undefined);
        await options.registry.patchThread(record.threadId, { status: "interrupted", activeRun: undefined }).catch(() => undefined);
        reconciled++;
        continue;
      }

      const prompt = buildRecoveryPrompt(record, "continue");
      await placeholder.edit(buildWorkingPayload(record, prompt, {
        phase: "starting",
        title: "Auto-resuming interrupted Pi session",
        detail: "Bridge restarted before the final Discord answer",
      })).catch(() => undefined);
      void runPromptWithPlaceholder(thread, record.activeRun.sourceDiscordMessageId, placeholder, record, prompt, options)
        .catch(async (error) => {
          const text = error instanceof Error ? error.message : String(error);
          console.warn(`auto-resume failed for interrupted thread ${record.threadId}: ${text}`);
          await placeholder.edit(buildErrorPayload(record, `Auto-resume failed: ${text}`)).catch(() => undefined);
        });
      resumed++;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`failed to auto-resume interrupted thread ${record.threadId}: ${text}`);
    }
  }

  if (resumed > 0) {
    console.log(`auto-resumed ${resumed} interrupted Pi thread(s)`);
  }
  if (reconciled > 0) {
    console.log(`reconciled ${reconciled} interrupted Pi thread placeholder(s) without resumable prompts`);
  }
}

async function reconcileInterruptedThreadPlaceholders(client: Client, options: RunBotOptions): Promise<void> {
  const interrupted = options.registry.listThreads()
    .filter((record) => record.status === "interrupted" && record.activeRun?.placeholderDiscordMessageId && record.kind !== "discord-dm-workroom");
  if (interrupted.length === 0) return;

  let reconciled = 0;
  for (const record of interrupted) {
    try {
      const channel = await client.channels.fetch(record.threadId);
      if (!channel || typeof (channel as { isThread?: unknown }).isThread !== "function" || !(channel as { isThread: () => boolean }).isThread()) {
        continue;
      }
      const thread = channel as ThreadChannel;
      const placeholder = await thread.messages.fetch(record.activeRun?.placeholderDiscordMessageId ?? "");

      const persistedFinal = getPersistedFinalAssistant(record);
      if (persistedFinal) {
        const chunks = chunkForDiscord(persistedFinal.text, options.config.render.maxDiscordChars);
        await sendFinalResponseMessages(thread, record, options.registry, chunks, persistedFinal.entryId);
        await archiveWorkingHud(placeholder, record);
        await options.registry.patchThread(record.threadId, { status: "idle", activeRun: undefined }).catch(() => undefined);
        reconciled++;
        continue;
      }

      if (options.config.runControl.enabled && options.runControlStore && record.activeRun?.runId) {
        await options.runControlStore.markTerminal(record.activeRun.runId, "interrupted", {
          error: "bridge restarted before Discord received a final answer",
        }).catch(() => undefined);
        await options.runControlStore.clearActiveIfMatches(record.threadId, record.activeRun.runId).catch(() => undefined);
      }

      await placeholder.edit(buildInterruptedRunPayload(record)).catch(() => undefined);
      reconciled++;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`failed to reconcile interrupted thread ${record.threadId}: ${text}`);
    }
  }

  if (reconciled > 0) {
    console.log(`reconciled ${reconciled} interrupted Pi thread placeholder(s) without auto-resume`);
  }
}

function getPersistedFinalAssistant(record: ThreadRecord): { entryId: string; text: string } | undefined {
  const sessionFile = record.sessionFile ?? record.activeRun?.sessionFile;
  if (!sessionFile) return undefined;
  try {
    const manager = SessionManager.open(sessionFile, undefined, record.cwd);
    const leaf = manager.getLeafEntry();
    if (!leaf || leaf.type !== "message" || leaf.message.role !== "assistant") return undefined;
    if (leaf.message.stopReason !== "stop") return undefined;
    const text = assistantTextContent(leaf.message.content).trim();
    if (!text) return undefined;
    return { entryId: leaf.id, text };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(`failed to inspect persisted assistant for ${record.threadId}: ${text}`);
    return undefined;
  }
}

function assistantTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const typed = item as { type?: string; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function handlePiAutocomplete(interaction: AutocompleteInteraction, config: AppConfig, registry: RegistryPort): Promise<void> {
  const focusedOption = interaction.options.getFocused(true);
  const focused = String(focusedOption.value).toLowerCase();
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand === "workspace") {
    const matches = listWorkspaces(config)
      .filter((workspace) => workspace.name.includes(focused) || workspace.cwd.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((workspace) => ({
        name: `${workspace.name} - ${homeRelative(workspace.cwd)}`.slice(0, 100),
        value: workspace.name,
      }));
    await interaction.respond(matches);
    return;
  }

  if (subcommand === "resume") {
    const matches = recentThreads(registry)
      .filter((record) => formatSessionChoice(record).toLowerCase().includes(focused) || record.threadId.includes(focused))
      .slice(0, 25)
      .map((record) => ({
        name: formatSessionChoice(record).slice(0, 100),
        value: record.threadId,
      }));
    await interaction.respond(matches);
    return;
  }

  const skills = await listSkillChoices(config);
  const matches = skills
    .filter((skill) => skill.name.includes(focused) || skill.description.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((skill) => ({
      name: `${skill.name} - ${skill.description}`.slice(0, 100),
      value: skill.name,
    }));

  await interaction.respond(matches);
}

let skillCache: { key: string; expiresAt: number; skills: Array<{ name: string; description: string }> } | undefined;

async function listSkillChoices(config: AppConfig): Promise<Array<{ name: string; description: string }>> {
  const key = `${config.pi.defaultCwd}:${config.pi.agentDir ?? getAgentDir()}`;
  if (skillCache && skillCache.key === key && skillCache.expiresAt > Date.now()) {
    return skillCache.skills;
  }

  const loader = new DefaultResourceLoader({
    cwd: config.pi.defaultCwd,
    agentDir: config.pi.agentDir ?? getAgentDir(),
  });
  await loader.reload();
  const skills = loader.getSkills().skills
    .map((skill) => ({ name: skill.name, description: skill.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  skillCache = { key, expiresAt: Date.now() + 60_000, skills };
  return skills;
}

async function handlePiInteraction(
  interaction: ChatInputCommandInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "help") {
    await replyEphemeral(interaction, helpText(options.config.discord.commandPrefix));
    return;
  }

  if (subcommand === "skill") {
    const name = interaction.options.getString("name", true).trim();
    const args = interaction.options.getString("args")?.trim();
    const prompt = `/skill:${name}${args ? ` ${args}` : ""}`;
    await runInteractionPrompt(interaction, prompt, options, interaction.options.getString("cwd") ?? undefined);
    return;
  }

  if (subcommand === "workspace") {
    const name = interaction.options.getString("name")?.trim();
    const prompt = interaction.options.getString("prompt")?.trim();
    await runWorkspaceInteraction(interaction, name, prompt, options);
    return;
  }

  if (subcommand === "workspaces") {
    await interaction.reply(buildWorkspaceListPayload(options.config));
    return;
  }

  if (subcommand === "ingest" || subcommand === "capture") {
    const mode = subcommand as LinkIngestCommandMode;
    const url = interaction.options.getString("url", true);
    const note = interaction.options.getString("note");
    await ingestLinkInteraction(interaction, options, buildLinkIngestCommandText({ url, note }), mode);
    return;
  }

  if (subcommand === "sessions") {
    await replyEphemeral(interaction, formatRecentSessions(options.registry));
    return;
  }

  if (subcommand === "resume") {
    await resumeInteraction(
      interaction,
      interaction.options.getString("session", true).trim(),
      interaction.options.getString("prompt")?.trim(),
      options,
    );
    return;
  }

  if (subcommand === "fork") {
    await forkInteraction(interaction, interaction.options.getString("prompt")?.trim(), options);
    return;
  }

  if (subcommand === "compose") {
    await showComposeModal(interaction);
    return;
  }

  if (subcommand === "status") {
    await sendStatusInteraction(interaction, options.registry);
    return;
  }

  if (subcommand === "debug") {
    await sendDebugInteraction(interaction, options);
    return;
  }

  if (subcommand === "reload") {
    await reloadInteraction(interaction, options);
    return;
  }

  if (subcommand === "compact") {
    await compactInteraction(interaction, options);
    return;
  }

  if (subcommand === "abort" || subcommand === "esc") {
    await abortInteraction(interaction, options.runtimeManager);
    return;
  }

  if (subcommand !== "ask") {
    await replyEphemeral(interaction, `Unknown /pi subcommand: ${subcommand}`);
    return;
  }

  const prompt = interaction.options.getString("prompt", true).trim();
  if (!prompt) {
    await replyEphemeral(interaction, "Prompt cannot be empty.");
    return;
  }

  await runInteractionPrompt(interaction, prompt, options, interaction.options.getString("cwd") ?? undefined);
}

async function handleAihTriageInteraction(
  interaction: ChatInputCommandInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  const note = interaction.options.getString("note")?.trim();
  const prompt = buildAihTriagePrompt(note);
  try {
    const workspace = await resolveWorkspaceInput("aihero", options.config);
    await runInteractionPrompt(interaction, prompt, options, workspace.cwd, workspace.name);
    return;
  } catch {
    await runInteractionPrompt(
      interaction,
      prompt,
      options,
      "/Users/joel/Code/badass-courses/aihero-support",
      "aihero",
    );
  }
}

function buildAihTriagePrompt(note?: string): string {
  const parts = [
    "Run the standard AI Hero fresh support triage workflow.",
    "Fresh Front run, full current thread research, prior Front/contact history for every thread, and purchase/access/Kit/CRM/source checks where relevant.",
    "Routine high-confidence replies and archives are pre-approved after full-thread review, source checks, stale guard, and duplicate-send guard. If a thread is sensitive or you feel nervous, stop for review.",
    "Do full public and Brain research for sponsor, vendor, partnership, and Matt-time threads, assign an S-F sponsor tier, and archive by default unless it is a current AI Coding team-sale lead or a clear blocker.",
    "Publish a noindex wzrrd review or summary page that expires in 6 hours. Include concise instructions on that page for invoking this workflow with /aih-triage from Discord.",
    "The final Discord summary must include an Automated actions summary with conversation IDs, action types, reasons, send message IDs, archive verification, receipt paths, sponsor tiers, and kept-open blockers.",
  ];
  if (note) parts.push(`Extra operator note: ${note}`);
  return parts.join("\n\n");
}

async function handlePiButton(
  interaction: ButtonInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedComponentInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  const [, action, ...threadIdParts] = interaction.customId.split(":");
  const rawTarget = threadIdParts.join(":");
  const [threadId, expectedMessageId] = splitControlTarget(rawTarget);
  if (!action) {
    await replyEphemeral(interaction, "Malformed Pi control button.");
    return;
  }

  if (action === "compose") {
    await showComposeModal(interaction);
    return;
  }

  if (action === "workspaces") {
    await interaction.reply(buildWorkspacePickerPayload(options.config));
    return;
  }

  if (!threadId) {
    await replyEphemeral(interaction, "Malformed Pi control button.");
    return;
  }

  const record = options.registry.getThread(threadId);
  if (!record) {
    await replyEphemeral(interaction, "No Pi session is registered for this thread.");
    return;
  }

  if (action === "status") {
    await replyEphemeral(interaction, formatStatus(record));
    return;
  }

  if (action === "abort") {
    if (!isCurrentAbortControl(interaction, record, expectedMessageId)) {
      await replyEphemeral(interaction, "Stale ESC ignored. Use the ESC button on the active Pi card.");
      return;
    }
    await options.runtimeManager.abort(threadId);
    await replyEphemeral(interaction, "ESC requested for this Pi session.");
    return;
  }

  if (action === "fork") {
    await forkFromRecordInteraction(interaction, record, undefined, options);
    return;
  }

  await replyEphemeral(interaction, `Unknown Pi action: ${action}`);
}

function splitControlTarget(rawTarget: string): [threadId: string, expectedMessageId: string | undefined] {
  const delimiterIndex = rawTarget.lastIndexOf("|");
  if (delimiterIndex === -1) return [rawTarget, undefined];
  return [rawTarget.slice(0, delimiterIndex), rawTarget.slice(delimiterIndex + 1) || undefined];
}

function isCurrentAbortControl(interaction: ButtonInteraction, record: ThreadRecord, expectedMessageId: string | undefined): boolean {
  if (!expectedMessageId) return false;
  if (interaction.message.id !== expectedMessageId) return false;
  return record.activeRun?.placeholderDiscordMessageId === expectedMessageId;
}

async function handlePiSelectMenu(
  interaction: StringSelectMenuInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedComponentInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  const [, action] = interaction.customId.split(":");
  if (action !== "workspace-select") {
    await replyEphemeral(interaction, `Unknown Pi select menu: ${action ?? "missing"}`);
    return;
  }

  const workspaceName = interaction.values[0];
  if (!workspaceName) {
    await replyEphemeral(interaction, "No workspace selected.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const workspace = await resolveWorkspaceInput(workspaceName, options.config);
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await interaction.editReply("DM support is not implemented yet. Use workspace selection in a server channel or thread.");
    return;
  }

  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromChannelObject(channel, `workspace ${workspace.name}`);
  const record = await ensureThreadRecord(thread, options, `workspace ${workspace.name}`, workspace.cwd, workspace.name);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  const readyMessage = await thread.send(buildWorkspaceReadyPayload(record));
  await options.registry.recordMessage({
    discordMessageId: readyMessage.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`Workspace \`${workspace.name}\` ready in <#${thread.id}>.\ncwd: \`${workspace.cwd.replace(/`/g, "'")}\``);
}

async function handlePiModal(
  interaction: ModalSubmitInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedComponentInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  if (!interaction.customId.startsWith("pi:compose")) {
    await replyEphemeral(interaction, `Unknown Pi modal: ${interaction.customId}`);
    return;
  }

  const prompt = interaction.fields.getTextInputValue("prompt").trim();
  const workspaceInput = interaction.fields.getTextInputValue("workspace").trim();
  const cwdInput = interaction.fields.getTextInputValue("cwd").trim();
  const title = interaction.fields.getTextInputValue("title").trim();
  if (!prompt) {
    await replyEphemeral(interaction, "Prompt cannot be empty.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await interaction.editReply("DM support is not implemented yet. Use compose in a server channel or thread.");
    return;
  }

  let cwd = options.config.pi.defaultCwd;
  let workspaceName: string | undefined;
  const existing = channel.isThread() ? options.registry.getThread(channel.id) : undefined;
  if (workspaceInput) {
    const workspace = await resolveWorkspaceInput(workspaceInput, options.config);
    cwd = workspace.cwd;
    workspaceName = workspace.name;
  } else if (cwdInput) {
    cwd = await resolveCwdInput(cwdInput, options.config.pi.defaultCwd);
  } else if (existing) {
    cwd = existing.cwd;
    workspaceName = existing.workspaceName;
  } else {
    const channelContext = await resolveContextForChannel(channel, options.config);
    cwd = channelContext?.cwd ?? cwd;
    workspaceName = channelContext?.workspaceName;
  }

  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromChannelObject(channel, prompt, title || undefined);
  const record = await ensureThreadRecord(thread, options, title || prompt, cwd, workspaceName);
  const promptToRun = buildRecoveryPrompt(record, prompt);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  if (channel.isThread() && await queueIfActiveForInteraction(interaction, record, promptToRun, options)) return;

  const placeholder = await thread.send(buildWorkingPayload(record, promptToRun, {
    phase: "starting",
    title: record.status === "interrupted" ? "Recovering interrupted Pi session" : "Starting Pi session",
    detail: "Queued from compose modal",
  }));
  await interaction.editReply(`Prompt started in <#${thread.id}>.`);
  await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, promptToRun, options);
}

async function handleAskPiMessageContext(
  interaction: MessageContextMenuCommandInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedComponentInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const targetMessage = interaction.targetMessage;
  const basePrompt = buildMessageContextPrompt(targetMessage);
  const channel = targetMessage.channel;
  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromMessage(targetMessage, basePrompt);
  if (!thread) {
    await interaction.editReply("I can only create Pi threads from server text, announcement, or registered thread channels right now.");
    return;
  }

  const existing = options.registry.getThread(thread.id);
  const channelContext = existing ? undefined : await resolveContextForChannel(thread, options.config);
  const record = existing ?? await ensureThreadRecord(
    thread,
    options,
    basePrompt,
    channelContext?.cwd ?? options.config.pi.defaultCwd,
    channelContext?.workspaceName,
  );
  const attachmentContext = await appendAttachmentContext(basePrompt, targetMessage, options.config, thread.id);
  const promptToRun = buildRecoveryPrompt(record, attachmentContext.prompt);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  if (channel.isThread() && await queueIfActiveForInteraction(interaction, record, promptToRun, options, attachmentContext.images)) return;

  await interaction.editReply(`Asked Pi about the selected message in <#${thread.id}>.`);
  await runPromptInThread(thread, interaction.id, record, promptToRun, options, attachmentContext.images);
}

async function resumeInteraction(
  interaction: ChatInputCommandInteraction,
  sourceThreadId: string,
  prompt: string | undefined,
  options: RunBotOptions,
): Promise<void> {
  const source = options.registry.getThread(sourceThreadId);
  if (!source) {
    await replyEphemeral(interaction, `Unknown session: ${sourceThreadId}`);
    return;
  }
  if (!source.sessionFile) {
    await replyEphemeral(interaction, "That session has no Pi session file yet.");
    return;
  }

  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await replyEphemeral(interaction, "DM support is not implemented yet. Use `/pi resume` in a server channel or thread.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromChannelObject(channel, source.sessionName ?? `resume ${sourceThreadId}`);
  const record = await options.registry.upsertThread({
    threadId: thread.id,
    kind: "discord-thread",
    guildId: thread.guildId,
    parentChannelId: thread.parentId ?? undefined,
    cwd: source.cwd,
    workspaceName: source.workspaceName,
    sessionFile: source.sessionFile,
    sessionName: source.sessionName ?? summarizeForThreadName(prompt ?? "resumed Pi session"),
    status: "idle",
    workGraph: source.workGraph ?? rootWorkGraph(thread.id),
  });
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });

  if (prompt) {
    if (channel.isThread() && await queueIfActiveForInteraction(interaction, record, prompt, options)) return;

    const placeholder = await thread.send(buildWorkingPayload(record, prompt, {
      phase: "starting",
      title: "Resuming Pi session",
      detail: "Queued from /pi resume",
    }));
    await interaction.editReply(`Resumed session in <#${thread.id}> and started the prompt.`);
    await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, prompt, options);
    return;
  }

  const readyMessage = await thread.send(buildWorkspaceReadyPayload(record));
  await options.registry.recordMessage({
    discordMessageId: readyMessage.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`Resumed session in <#${thread.id}>.`);
}

async function forkInteraction(
  interaction: ChatInputCommandInteraction,
  prompt: string | undefined,
  options: RunBotOptions,
): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  if (!threadId) {
    await replyEphemeral(interaction, "Use `/pi fork` inside a registered Pi thread.");
    return;
  }
  const source = options.registry.getThread(threadId);
  if (!source) {
    await replyEphemeral(interaction, "This Discord thread is not registered to a Pi session yet.");
    return;
  }
  await forkFromRecordInteraction(interaction, source, prompt, options);
}

async function forkFromRecordInteraction(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  source: ThreadRecord,
  prompt: string | undefined,
  options: RunBotOptions,
): Promise<void> {
  const currentThread = interaction.channel?.isThread() ? (interaction.channel as ThreadChannel) : undefined;
  const parent = currentThread?.parent;
  if (!parent) {
    await replyEphemeral(interaction, "Cannot find the parent channel for this thread.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const forkPrompt = prompt ?? `Fork of ${source.sessionName ?? source.threadId}`;
  const thread = await createThreadFromChannelObject(parent, forkPrompt);
  const forkSessionFile = createForkedSessionFile(source, options.config);
  const record = await options.registry.upsertThread({
    threadId: thread.id,
    kind: "discord-thread",
    guildId: thread.guildId,
    parentChannelId: thread.parentId ?? undefined,
    cwd: source.cwd,
    workspaceName: source.workspaceName,
    sessionFile: forkSessionFile,
    sessionName: summarizeForThreadName(forkPrompt),
    status: "idle",
    workGraph: forkWorkGraph(source, thread.id, source.sessionFile),
  });
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });

  if (prompt) {
    const placeholder = await thread.send(buildWorkingPayload(record, prompt, {
      phase: "starting",
      title: "Starting forked Pi session",
      detail: `Forked from thread ${source.threadId}`,
    }));
    await interaction.editReply(`${forkSessionFile ? "Pi fork" : "Discord fork"} created in <#${thread.id}> and prompt started.`);
    await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, prompt, options);
    return;
  }

  const readyMessage = await thread.send(buildWorkspaceReadyPayload(record));
  await options.registry.recordMessage({
    discordMessageId: readyMessage.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`${forkSessionFile ? "Pi fork" : "Discord fork"} created in <#${thread.id}>.`);
}

async function showComposeModal(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("pi:compose")
    .setTitle("Compose Pi prompt");

  const prompt = new TextInputBuilder()
    .setCustomId("prompt")
    .setLabel("Prompt")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder("Paste a multi-line prompt for Pi...");

  const workspace = new TextInputBuilder()
    .setCustomId("workspace")
    .setLabel("Workspace alias (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder("aihero");

  const cwd = new TextInputBuilder()
    .setCustomId("cwd")
    .setLabel("cwd override (optional; ignored if workspace set)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder("~/Code/project or @Code/project");

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Thread title (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(90)
    .setPlaceholder("Short title for the Discord thread");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(prompt),
    new ActionRowBuilder<TextInputBuilder>().addComponents(workspace),
    new ActionRowBuilder<TextInputBuilder>().addComponents(cwd),
    new ActionRowBuilder<TextInputBuilder>().addComponents(title),
  );
  await interaction.showModal(modal);
}

async function runInteractionPrompt(
  interaction: ChatInputCommandInteraction,
  prompt: string,
  options: RunBotOptions,
  cwdInput?: string,
  workspaceName?: string,
): Promise<void> {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await replyEphemeral(interaction, "DM support is not implemented yet. Use `/pi ask` in a server channel or thread.");
    return;
  }

  const explicitCwd = cwdInput?.trim() ? await resolveCwdInput(cwdInput, options.config.pi.defaultCwd) : undefined;
  const existing = channel.isThread() ? options.registry.getThread(channel.id) : undefined;
  const channelContext = !explicitCwd && !workspaceName && !existing
    ? await resolveContextForChannel(channel, options.config)
    : undefined;
  const cwd = explicitCwd ?? existing?.cwd ?? channelContext?.cwd ?? options.config.pi.defaultCwd;
  const resolvedWorkspaceName = workspaceName ?? (!explicitCwd ? (existing?.workspaceName ?? channelContext?.workspaceName) : undefined);

  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const record = await ensureThreadRecord(thread, options, prompt, cwd, resolvedWorkspaceName);
    const promptToRun = buildRecoveryPrompt(record, prompt);
    await options.registry.recordMessage({
      discordMessageId: interaction.id,
      threadId: thread.id,
      direction: "user",
      createdAt: new Date().toISOString(),
    });
    if (await queueIfActiveForInteraction(interaction, record, promptToRun, options)) return;

    const response = await interaction.reply({
      ...buildWorkingPayload(record, promptToRun, {
        phase: "starting",
        title: record.status === "interrupted" ? "Recovering interrupted Pi session" : "Starting Pi session",
        detail: record.sessionFile ? "Rehydrating existing session" : `cwd: ${record.cwd}`,
      }),
      withResponse: true,
    });
    const placeholder = (response.resource?.message ?? await interaction.fetchReply()) as Message;
    await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, promptToRun, options);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await createThreadFromChannel(interaction, prompt);
  if (!thread) return;

  await interaction.deleteReply().catch(() => undefined);
  const record = await ensureThreadRecord(thread, options, prompt, cwd, resolvedWorkspaceName);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  const placeholder = await thread.send(buildWorkingPayload(record, prompt, {
    phase: "starting",
    title: "Starting Pi session",
    detail: `cwd: ${record.cwd}`,
  }));
  await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, prompt, options);
}

async function runWorkspaceInteraction(
  interaction: ChatInputCommandInteraction,
  workspaceName: string | undefined,
  prompt: string | undefined,
  options: RunBotOptions,
): Promise<void> {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await replyEphemeral(interaction, "DM support is not implemented yet. Use `/pi workspace` in a server channel or thread.");
    return;
  }

  if (!workspaceName) {
    await interaction.reply(buildWorkspacePickerPayload(options.config));
    return;
  }

  const workspace = await resolveWorkspaceInput(workspaceName, options.config);
  if (prompt) {
    await runInteractionPrompt(interaction, prompt, options, workspace.cwd, workspace.name);
    return;
  }

  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const record = await ensureThreadRecord(thread, options, `workspace ${workspace.name}`, workspace.cwd, workspace.name);
    const response = await interaction.reply({ ...buildWorkspaceReadyPayload(record), withResponse: true });
    await options.registry.recordMessage({
      discordMessageId: interaction.id,
      threadId: thread.id,
      direction: "user",
      createdAt: new Date().toISOString(),
    });
    const readyMessage = (response.resource?.message ?? await interaction.fetchReply()) as Message;
    await options.registry.recordMessage({
      discordMessageId: readyMessage.id,
      threadId: thread.id,
      direction: "assistant",
      createdAt: new Date().toISOString(),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await createThreadFromChannel(interaction, `workspace ${workspace.name}`);
  if (!thread) return;

  const record = await ensureThreadRecord(thread, options, `workspace ${workspace.name}`, workspace.cwd, workspace.name);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  const readyMessage = await thread.send(buildWorkspaceReadyPayload(record));
  await options.registry.recordMessage({
    discordMessageId: readyMessage.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`Workspace \`${workspace.name}\` ready in <#${thread.id}>.\ncwd: \`${workspace.cwd.replace(/`/g, "'")}\``);
}

async function handleMessage(
  message: Message,
  client: Client,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (message.author.bot) return;
  if (!isAllowedMessage(message, options.config, allowedUsers)) return;

  if (!message.inGuild()) {
    await handleDirectMessage(message, client, options);
    return;
  }

  const botId = client.user?.id ?? null;
  const rawContent = stripBotMention(message.content, botId);
  const prefixed = stripCommandPrefix(rawContent, options.config.discord.commandPrefix);
  const mentioned = options.config.discord.respondToMentions && botId ? message.mentions.users.has(botId) : false;
  const inThread = message.channel.isThread();
  const existingThread = inThread ? options.registry.getThread(message.channel.id) : undefined;

  if (!prefixed && !mentioned && !existingThread) return;

  const content = prefixed ?? (mentioned ? rawContent : message.content.trim());
  if (!content && message.attachments.size === 0) {
    await safeReply(message, helpText(options.config.discord.commandPrefix));
    return;
  }

  if (isCommand(content, "help")) {
    await safeReply(message, helpText(options.config.discord.commandPrefix));
    return;
  }

  if (isCommand(content, "status")) {
    await sendStatus(message, options.registry);
    return;
  }

  if (isCommand(content, "abort") || isCommand(content, "esc")) {
    const threadId = inThread ? message.channel.id : undefined;
    if (!threadId) {
      await safeReply(message, "`esc` only applies inside a registered Pi thread.");
      return;
    }
    await options.runtimeManager.abort(threadId);
    await safeReply(message, "ESC requested for this Pi session.");
    return;
  }

  if (isCommand(content, "reload")) {
    await reloadMessage(message, options);
    return;
  }

  if (isCommand(content, "compact")) {
    await compactMessage(message, options, commandArgs(content, "compact"));
    return;
  }

  const linkIngestCommand = parsePrefixLinkIngestCommand(content);
  if (linkIngestCommand) {
    await ingestLinkMessage(message, options, linkIngestCommand.text, linkIngestCommand.mode);
    return;
  }

  const workspaceCommand = parseWorkspaceCommand(content);
  if (workspaceCommand) {
    await handleWorkspaceMessage(message, options, workspaceCommand.name, workspaceCommand.prompt);
    return;
  }

  const parsed = parseLeadingCwdFlag(content || "Please inspect the attached file(s).");
  if (!parsed.prompt && message.attachments.size === 0) {
    await safeReply(message, "Prompt cannot be empty after `--cwd`.");
    return;
  }
  const explicitCwd = parsed.cwdInput?.trim() ? await resolveCwdInput(parsed.cwdInput, options.config.pi.defaultCwd) : undefined;
  const channelContext = !explicitCwd && !existingThread
    ? await resolveContextForChannel(message.channel, options.config)
    : undefined;
  const cwd = explicitCwd ?? existingThread?.cwd ?? channelContext?.cwd ?? options.config.pi.defaultCwd;
  const workspaceName = !explicitCwd ? (existingThread?.workspaceName ?? channelContext?.workspaceName) : undefined;

  const thread = inThread
    ? (message.channel as ThreadChannel)
    : await createThreadFromMessage(message, parsed.prompt);
  if (!thread) return;

  const record = await ensureThreadRecord(thread, options, parsed.prompt, cwd, workspaceName);
  await options.registry.recordMessage({
    discordMessageId: message.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });

  const attachmentContext = await appendAttachmentContext(parsed.prompt || "Please inspect the attached file(s).", message, options.config, thread.id);
  const promptToRun = buildRecoveryPrompt(record, attachmentContext.prompt);
  if (await queueIfActiveForMessage(message, record, promptToRun, options, attachmentContext.images)) return;
  await runPromptInThread(thread, message.id, record, promptToRun, options, attachmentContext.images);
}

async function handleDirectMessage(
  message: Message,
  client: Client,
  options: RunBotOptions,
): Promise<void> {
  if (!isPromptChannel(message.channel)) {
    await safeReply(message, "I cannot respond in this DM channel.");
    return;
  }

  const botId = client.user?.id ?? null;
  const rawContent = stripBotMention(message.content, botId);
  const prefixed = stripCommandPrefix(rawContent, options.config.discord.commandPrefix);
  const content = prefixed ?? rawContent.trim();
  if (!options.config.discord.personalWorkroom.enabled) {
    await safeReply(message, "DM Personal Workroom is not configured for this bridge.");
    return;
  }
  const record = await ensurePersonalWorkroomRecord(message.author.id, options);

  if (!content && message.attachments.size === 0) {
    await safeReply(message, helpText(options.config.discord.commandPrefix));
    return;
  }

  if (isCommand(content, "help")) {
    await safeReply(message, helpText(options.config.discord.commandPrefix));
    return;
  }

  if (isCommand(content, "status")) {
    await safeReply(message, formatStatus(record));
    return;
  }

  if (isCommand(content, "abort") || isCommand(content, "esc")) {
    await options.runtimeManager.abort(record.threadId);
    await safeReply(message, "ESC requested for the Personal Workroom.");
    return;
  }

  if (isCommand(content, "reload")) {
    await reloadRecordMessage(message, record, options);
    return;
  }

  if (isCommand(content, "compact")) {
    await compactRecordMessage(message, record, options, commandArgs(content, "compact"));
    return;
  }

  const prompt = content || "Please inspect the attached file(s).";
  const attachmentContext = await appendAttachmentContext(prompt, message, options.config, record.threadId);
  await options.registry.recordMessage({
    discordMessageId: message.id,
    threadId: record.threadId,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  const promptToRun = buildRecoveryPrompt(record, attachmentContext.prompt);
  if (await queueIfActiveForMessage(message, record, promptToRun, options, attachmentContext.images)) return;
  await runPromptInChannel(message.channel, message.id, record, promptToRun, options, attachmentContext.images);
}

async function handleWorkspaceMessage(
  message: Message,
  options: RunBotOptions,
  workspaceName: string | undefined,
  prompt: string,
): Promise<void> {
  if (!workspaceName) {
    await safeReply(message, workspaceUsage(options.config));
    return;
  }

  const workspace = await resolveWorkspaceInput(workspaceName, options.config);
  const thread = message.channel.isThread()
    ? (message.channel as ThreadChannel)
    : await createThreadFromMessage(message, prompt || `workspace ${workspace.name}`);
  if (!thread) return;

  const record = await ensureThreadRecord(thread, options, prompt || `workspace ${workspace.name}`, workspace.cwd, workspace.name);
  await options.registry.recordMessage({
    discordMessageId: message.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });

  if (prompt || message.attachments.size > 0) {
    const attachmentContext = await appendAttachmentContext(prompt || "Please inspect the attached file(s).", message, options.config, thread.id);
    const promptToRun = buildRecoveryPrompt(record, attachmentContext.prompt);
    if (await queueIfActiveForMessage(message, record, promptToRun, options, attachmentContext.images)) return;
    await runPromptInThread(thread, message.id, record, promptToRun, options, attachmentContext.images);
    return;
  }

  const readyMessage = await thread.send(buildWorkspaceReadyPayload(record));
  await options.registry.recordMessage({
    discordMessageId: readyMessage.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
}

async function ingestLinkInteraction(
  interaction: ChatInputCommandInteraction,
  options: RunBotOptions,
  text: string,
  mode: LinkIngestCommandMode,
): Promise<void> {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !channel) {
    await replyEphemeral(interaction, `Use \`/pi ${mode}\` in a server channel or thread.`);
    return;
  }
  if (!extractFirstUrl(text)) {
    await replyEphemeral(interaction, `No URL found. Use \`${linkIngestUsage(mode)}\`.`);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromChannelObject(channel, text, linkIngestThreadTitle(text, mode), "Create joelclaw link ingest thread");
  const prepared = prepareLinkIngest({
    text,
    origin: {
      guildId: interaction.guildId ?? undefined,
      channelId: channel.id,
      threadId: thread.id,
      interactionId: interaction.id,
      authorId: interaction.user.id,
    },
    config: options.config.linkIngest,
  });
  await recordLinkIngest(options, prepared, thread.id, channel.id, interaction.guildId ?? undefined, undefined, interaction.id, interaction.user.id);
  let result: LinkIngestSendResult;
  try {
    const posted = await postPreparedLinkIngest({
      prepared,
      config: options.config.linkIngest,
    });
    result = { ...prepared, ...posted };
    await recordLinkIngest(options, result, thread.id, channel.id, interaction.guildId ?? undefined, undefined, interaction.id, interaction.user.id);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await recordLinkIngest(options, prepared, thread.id, channel.id, interaction.guildId ?? undefined, undefined, interaction.id, interaction.user.id, {
      status: "send_failed",
      error: text,
    });
    throw error;
  }
  const status = await thread.send(buildLinkIngestAcceptedPayload(result, mode));
  await options.registry.recordMessage({
    discordMessageId: status.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`${linkIngestAcceptedTitle(mode)} in <#${thread.id}>.\nsourceId: \`${result.sourceId}\``);
}

async function ingestLinkMessage(message: Message, options: RunBotOptions, text: string, mode: LinkIngestCommandMode = "ingest"): Promise<void> {
  if (!message.inGuild()) {
    await safeReply(message, "Use `ingest` in a server channel or thread.");
    return;
  }
  if (!extractFirstUrl(text)) {
    await safeReply(message, "No URL found. Use `ingest https://...`.");
    return;
  }

  const thread = message.channel.isThread()
    ? (message.channel as ThreadChannel)
    : await createThreadFromMessage(message, linkIngestThreadTitle(text, mode), "Create joelclaw link ingest thread");
  if (!thread) return;

  const prepared = prepareLinkIngest({
    text,
    origin: {
      guildId: message.guildId ?? undefined,
      channelId: message.channel.id,
      threadId: thread.id,
      messageId: message.id,
      authorId: message.author.id,
    },
    config: options.config.linkIngest,
  });
  await recordLinkIngest(options, prepared, thread.id, message.channel.id, message.guildId ?? undefined, message.id, undefined, message.author.id);
  let result: LinkIngestSendResult;
  try {
    const posted = await postPreparedLinkIngest({
      prepared,
      config: options.config.linkIngest,
    });
    result = { ...prepared, ...posted };
    await recordLinkIngest(options, result, thread.id, message.channel.id, message.guildId ?? undefined, message.id, undefined, message.author.id);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await recordLinkIngest(options, prepared, thread.id, message.channel.id, message.guildId ?? undefined, message.id, undefined, message.author.id, {
      status: "send_failed",
      error: text,
    });
    throw error;
  }
  const status = await thread.send(buildLinkIngestAcceptedPayload(result, mode));
  await options.registry.recordMessage({
    discordMessageId: status.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });
}

async function recordLinkIngest(
  options: RunBotOptions,
  result: PreparedLinkIngest | LinkIngestSendResult,
  threadId: string,
  channelId: string,
  guildId: string | undefined,
  discordMessageId: string | undefined,
  interactionId: string | undefined,
  authorId: string | undefined,
  patch?: {
    status?: LinkIngestRecord["status"];
    error?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await options.registry.upsertLinkIngest({
    sourceId: result.sourceId,
    mentionId: result.mentionId,
    eventId: result.eventId,
    eventName: "link/ingest.requested",
    url: result.url,
    normalizedUrl: result.normalizedUrl,
    threadId,
    channelId,
    ...(guildId ? { guildId } : {}),
    ...(discordMessageId ? { discordMessageId } : {}),
    ...(interactionId ? { interactionId } : {}),
    ...(authorId ? { authorId } : {}),
    status: patch?.status ?? "accepted",
    ...("inngestEventIds" in result ? { inngestEventIds: result.inngestEventIds } : {}),
    ...(patch?.error ? { error: patch.error } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

function linkIngestThreadTitle(text: string, mode: LinkIngestCommandMode = "ingest"): string {
  const found = extractFirstUrl(text);
  if (!found) return `${mode} link`;
  try {
    const url = new URL(found.url);
    return `${mode} ${url.hostname.replace(/^www\./iu, "")}`;
  } catch {
    return `${mode} link`;
  }
}

function isAllowedInteraction(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  allowedUsers: Set<string>,
): boolean {
  if (allowedUsers.size > 0 && !allowedUsers.has(interaction.user.id)) return false;

  if (config.discord.guildIds.length > 0) {
    if (!interaction.guildId || !config.discord.guildIds.includes(interaction.guildId)) return false;
  }

  if (config.discord.channelIds.length > 0) {
    const channelId = interaction.channelId;
    const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : undefined;
    if (!config.discord.channelIds.includes(channelId) && (!parentId || !config.discord.channelIds.includes(parentId))) {
      return false;
    }
  }

  return true;
}

function isAllowedComponentInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | MessageContextMenuCommandInteraction,
  config: AppConfig,
  allowedUsers: Set<string>,
): boolean {
  if (allowedUsers.size > 0 && !allowedUsers.has(interaction.user.id)) return false;
  if (!interaction.guildId) return true;

  if (config.discord.guildIds.length > 0) {
    if (!interaction.guildId || !config.discord.guildIds.includes(interaction.guildId)) return false;
  }

  if (config.discord.channelIds.length > 0) {
    const channelId = interaction.channelId;
    if (!channelId) return false;
    const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : undefined;
    if (!config.discord.channelIds.includes(channelId) && (!parentId || !config.discord.channelIds.includes(parentId))) {
      return false;
    }
  }

  return true;
}

function isAllowedMessage(message: Message, config: AppConfig, allowedUsers: Set<string>): boolean {
  if (allowedUsers.size > 0 && !allowedUsers.has(message.author.id)) return false;
  if (!message.inGuild()) return true;

  if (config.discord.guildIds.length > 0) {
    if (!message.guildId || !config.discord.guildIds.includes(message.guildId)) return false;
  }

  if (config.discord.channelIds.length > 0) {
    const channel = message.channel;
    const channelId = channel.id;
    const parentId = channel.isThread() ? channel.parentId : undefined;
    if (!config.discord.channelIds.includes(channelId) && (!parentId || !config.discord.channelIds.includes(parentId))) {
      return false;
    }
  }

  return true;
}

async function createThreadFromMessage(
  message: Message,
  prompt: string,
  reason = "Create durable Pi session thread",
): Promise<ThreadChannel | undefined> {
  if (!message.inGuild()) {
    await safeReply(message, "DM support is not implemented yet. Send this in a server channel or thread.");
    return undefined;
  }

  if (message.channel.type !== ChannelType.GuildText && message.channel.type !== ChannelType.GuildAnnouncement) {
    await safeReply(message, "I can only create Pi threads from text or announcement channels right now.");
    return undefined;
  }

  const thread = await message.startThread({
    name: summarizeForThreadName(prompt),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason,
  });
  return thread;
}

async function createThreadFromChannel(
  interaction: ChatInputCommandInteraction,
  prompt: string,
): Promise<ThreadChannel | undefined> {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.editReply("No channel found for this command.");
    return undefined;
  }

  try {
    return await createThreadFromChannelObject(channel, prompt);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await interaction.editReply(text);
    return undefined;
  }
}

async function createThreadFromChannelObject(
  channel: unknown,
  prompt: string,
  title?: string,
  reason = "Create durable Pi session thread",
): Promise<ThreadChannel> {
  const candidate = channel as {
    type?: ChannelType;
    threads?: {
      create(options: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration; reason: string }): Promise<ThreadChannel>;
    };
  };

  if (candidate.type !== ChannelType.GuildText && candidate.type !== ChannelType.GuildAnnouncement) {
    throw new Error("I can only create Pi threads from text or announcement channels right now.");
  }
  if (!candidate.threads) {
    throw new Error("This channel cannot create Pi threads.");
  }

  return candidate.threads.create({
    name: title ? summarizeForThreadName(title) : summarizeForThreadName(prompt),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason,
  });
}

function dmWorkroomThreadId(discordUserId: string): string {
  return `dm:${discordUserId}`;
}

function isPromptChannel(channel: Message["channel"]): channel is Message["channel"] & PromptChannel {
  return channel.isSendable() && typeof (channel as { sendTyping?: unknown }).sendTyping === "function";
}

function getThreadChannel(channel: PromptChannel): ThreadChannel | undefined {
  const maybeThread = channel as PromptChannel & { isThread?: () => boolean };
  return typeof maybeThread.isThread === "function" && maybeThread.isThread()
    ? (channel as unknown as ThreadChannel)
    : undefined;
}

type ContextChannelLike = {
  id: string;
  isThread?: () => boolean;
  parentId?: string | null;
};

async function resolveContextForChannel(channel: ContextChannelLike, config: AppConfig): Promise<{ cwd: string; workspaceName?: string } | undefined> {
  return resolveContextChannelDefault(
    channel.id,
    typeof channel.isThread === "function" && channel.isThread() ? (channel.parentId ?? undefined) : undefined,
    config,
  );
}

async function ensurePersonalWorkroomRecord(discordUserId: string, options: RunBotOptions): Promise<ThreadRecord> {
  const threadId = dmWorkroomThreadId(discordUserId);
  const existing = options.registry.getThread(threadId);
  const workroom = options.config.discord.personalWorkroom;
  const workspaceName = workroom.workspace;
  const cwd = workroom.cwd ?? (workspaceName ? options.config.pi.workspaces[workspaceName] : undefined) ?? options.config.pi.defaultCwd;
  const patch = {
    kind: "discord-dm-workroom" as const,
    discordUserId,
    cwd,
    workspaceName,
    sessionName: existing?.sessionName ?? workroom.sessionName,
    extensionPaths: workroom.extensionPaths,
  };

  if (existing) {
    return options.registry.patchThread(threadId, patch);
  }

  return options.registry.upsertThread({
    threadId,
    ...patch,
    status: "idle",
  });
}

async function ensureThreadRecord(
  thread: ThreadChannel,
  options: RunBotOptions,
  prompt: string,
  cwd = options.config.pi.defaultCwd,
  workspaceName?: string,
): Promise<ThreadRecord> {
  const existing = options.registry.getThread(thread.id);
  if (existing) {
    if (workspaceName && existing.cwd !== cwd) {
      throw new Error(
        `This thread is already mapped to cwd ${existing.cwd}. Start workspace '${workspaceName}' from a channel to create a new thread.`,
      );
    }
    if (workspaceName && existing.workspaceName !== workspaceName) {
      return options.registry.patchThread(thread.id, { workspaceName });
    }
    return existing;
  }

  return options.registry.upsertThread({
    threadId: thread.id,
    kind: "discord-thread",
    guildId: thread.guildId,
    parentChannelId: thread.parentId ?? undefined,
    cwd,
    workspaceName,
    sessionName: summarizeForThreadName(prompt),
    status: "idle",
    workGraph: rootWorkGraph(thread.id),
  });
}

async function runPromptInThread(
  thread: ThreadChannel,
  sourceDiscordId: string,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<void> {
  await runPromptInChannel(thread, sourceDiscordId, record, prompt, options, images);
}

async function runPromptInChannel(
  channel: PromptChannel,
  sourceDiscordId: string,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<void> {
  const placeholder = await channel.send(buildWorkingPayload(record, prompt, {
    phase: "starting",
    title: "Starting Pi session",
    detail: "Queued from Discord message",
  }));
  await runPromptWithPlaceholder(channel, sourceDiscordId, placeholder, record, prompt, options, images);
}

async function queueIfActive(
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
  sourceDiscordMessageId?: string,
): Promise<{ queued: boolean; mode?: "steer" | "followUp"; pendingMessageCount?: number }> {
  const intent = parseQueueIntent(prompt);
  if (options.config.runControl.enabled && options.runControlStore) {
    const activeRunId = await options.runControlStore.getQueueableActiveRunId(record.threadId);
    if (!activeRunId) return { queued: false };
    await options.runControlStore.appendInput({
      runId: activeRunId,
      logicalThreadId: record.threadId,
      mode: intent.mode,
      text: intent.text,
      images,
      sourceDiscordMessageId,
      createdAt: new Date().toISOString(),
    });
    return {
      queued: true,
      mode: intent.mode,
      pendingMessageCount: await options.runControlStore.countInputsForRun(record.threadId, activeRunId).catch(() => undefined),
    };
  }
  return options.runtimeManager.queueMessageForThreadIfActive(record, intent.text, intent.mode, images);
}

async function queueIfActiveForInteraction(
  interaction: EphemeralInteraction,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<boolean> {
  const queued = await queueIfActive(record, prompt, options, images, interaction.id);
  if (!queued.queued) return false;
  await replyEphemeral(interaction, formatQueuedText(queued.mode ?? "steer", queued.pendingMessageCount ?? 0));
  return true;
}

async function queueIfActiveForMessage(
  message: Message,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<boolean> {
  const queued = await queueIfActive(record, prompt, options, images, message.id);
  if (!queued.queued) return false;
  const mode = queued.mode ?? "steer";
  await message.react(queuedInputReactionForMode(mode)).catch(() => undefined);
  const queuedViaRunControl = Boolean(options.config.runControl.enabled && options.runControlStore);
  if (!queuedViaRunControl) {
    await markQueuedMessageAccepted(message, mode);
  }
  return true;
}

const QUEUED_INPUT_ACCEPTED_REACTION = "✅";

function queuedInputReactionForMode(mode: "steer" | "followUp"): string {
  return mode === "followUp" ? "🕓" : "🧭";
}

async function markQueuedMessageAccepted(message: Message, mode: "steer" | "followUp"): Promise<void> {
  const accepted = await message.react(QUEUED_INPUT_ACCEPTED_REACTION)
    .then(() => true)
    .catch(() => false);
  if (!accepted) return;

  const queuedReaction = queuedInputReactionForMode(mode);
  const ownQueuedReaction = message.reactions.cache.find((reaction) => reaction.emoji.name === queuedReaction);
  await ownQueuedReaction?.users.remove().catch(() => undefined);
}

async function markQueuedRunInputAccepted(
  client: Client,
  run: RunRecord,
  input: QueuedRunInput,
  options: RunBotOptions,
): Promise<void> {
  if (!input.sourceDiscordMessageId) return;
  const record = options.registry.getThread(run.threadId);
  if (!record) return;
  const channel = await resolvePromptChannel(client, record);
  const message = await fetchPromptChannelMessage(channel, input.sourceDiscordMessageId).catch(() => undefined);
  if (!message) return;
  await markQueuedMessageAccepted(message, input.mode);
}

function parseQueueIntent(prompt: string): { text: string; mode: "steer" | "followUp" } {
  const trimmed = prompt.trim();
  const followUpMatch = trimmed.match(/^(?:follow[- ]?up|after|later)\s*[:：]?\s+([\s\S]*)$/i);
  if (followUpMatch?.[1]?.trim()) {
    return { mode: "followUp", text: followUpMatch[1].trim() };
  }
  return { mode: "steer", text: prompt };
}

const ACTIVE_RUN_PROMPT_LIMIT = 24_000;

function buildActiveRunRecord(
  sourceDiscordMessageId: string,
  placeholderDiscordMessageId: string,
  prompt: string,
  sessionFile: string | undefined,
  runId?: string,
): ActiveRunRecord {
  const now = new Date().toISOString();
  const storedPrompt = prompt.length > ACTIVE_RUN_PROMPT_LIMIT
    ? `${prompt.slice(0, ACTIVE_RUN_PROMPT_LIMIT)}\n\n[truncated by pi-discord-threads active-run recovery metadata]`
    : prompt;
  return {
    runId,
    sourceDiscordMessageId,
    placeholderDiscordMessageId,
    prompt: storedPrompt,
    promptPreview: summarizeActiveRunPrompt(prompt),
    startedAt: now,
    updatedAt: now,
    sessionFile,
  };
}

function buildRecoveryPrompt(record: ThreadRecord, prompt: string): string {
  if (record.status !== "interrupted") return prompt;

  const activeRun = record.activeRun;
  const interruptedAt = activeRun?.interruptedAt ?? record.updatedAt;
  const interruptedPrompt = recoverableInterruptedPrompt(activeRun?.prompt);
  const userPrompt = prompt.trim() || "continue";
  const wantsContinuation = isRecoveryIntent(userPrompt);

  const header = [
    "The previous Discord/Pi turn in this thread was interrupted by a bridge daemon restart before Discord received a final assistant answer.",
    `Interrupted at: ${interruptedAt}`,
    "Use the durable Pi session history as the source of truth. It may contain partial work from the interrupted turn; continue from it if present, otherwise reconstruct the interrupted request from the metadata below.",
  ].join("\n");

  if (wantsContinuation && interruptedPrompt) {
    return [
      header,
      "Interrupted request to recover:",
      interruptedPrompt,
      "Operator asked to continue after restart. Resume the interrupted request and explain any duplicated or missing work if the session history shows the turn was only partially persisted.",
    ].join("\n\n");
  }

  return [
    header,
    interruptedPrompt ? `Previous interrupted request:\n${interruptedPrompt}` : "No exact interrupted prompt was recorded; infer only from durable session history and the new operator message.",
    "New operator message after restart:",
    userPrompt,
  ].join("\n\n");
}

function isRecoveryIntent(prompt: string): boolean {
  return /^(?:continue(?: work)?|keep going|resume|recover|retry|rerun|pick up)(?:[.!?]*)$/i.test(prompt.trim());
}

function summarizeActiveRunPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function runPromptWithPlaceholder(
  channel: PromptChannel,
  sourceDiscordId: string,
  placeholder: Message,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<void> {
  await options.registry.recordMessage({
    discordMessageId: placeholder.id,
    threadId: record.threadId,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });

  let stopTyping: (() => void) | undefined;
  let stopProgress: (() => Promise<void>) | undefined;
  let progressHudSnapshot: ProgressHudSnapshot | undefined;

  if (options.config.runControl.enabled && options.runControlStore) {
    await enqueueRunControlPrompt(channel, sourceDiscordId, placeholder, record, prompt, options, images);
    return;
  }

  try {
    const queued = await queueIfActive(record, prompt, options, images, sourceDiscordId);
    if (queued.queued) {
      await placeholder.delete().catch(() => placeholder.edit(buildQueuedPayload(queued.mode ?? "steer", queued.pendingMessageCount ?? 0)).then(() => undefined).catch(() => undefined));
      return;
    }

    const activeRun = buildActiveRunRecord(sourceDiscordId, placeholder.id, prompt, record.sessionFile);
    const runningRecord: ThreadRecord = { ...record, status: "running", activeRun };
    await options.registry.patchThread(record.threadId, {
      status: "running",
      activeRun,
    });

    stopTyping = startTypingIndicator(channel);
    const thread = getThreadChannel(channel);
    if (thread) await maybeRenameThreadForPrompt(thread, record, prompt, options.registry);
    const renderer = new DiscordMessageRenderer(placeholder, {
      onError(error) {
        console.warn(`progress HUD edit failed for ${record.threadId}: ${error.message}`);
      },
    });
    const progress = createProgressHudController({
      renderer,
      record: runningRecord,
      prompt,
      config: options.config,
      warn(message) {
        console.warn(message);
      },
    });
    const progressEvents = createProgressEventBus(progress.update);
    stopProgress = async () => {
      progressHudSnapshot = progress.snapshot();
      await progress.stop();
    };
    await renderer.render(buildWorkingPayload(runningRecord, prompt, {
      phase: "starting",
      title: "Starting Pi session",
      detail: record.sessionFile ? "Rehydrating existing session" : "Creating a durable session",
    }));

    const result = await options.runtimeManager.enqueuePrompt(record, prompt, images, progressEvents.publish);
    await stopProgress();
    stopTyping();
    if (result.kind === "queued") {
      await options.registry.patchThread(record.threadId, {
        status: record.status,
        activeRun: record.activeRun,
        sessionFile: result.sessionFile ?? record.sessionFile,
      }).catch(() => undefined);
      await placeholder.delete().catch(() => placeholder.edit(buildQueuedPayload(result.mode, result.pendingMessageCount ?? 0)).then(() => undefined).catch(() => undefined));
      return;
    }
    await options.registry.recordMessageEntry(sourceDiscordId, result.userEntryId);

    const chunks = chunkForDiscord(result.text, options.config.render.maxDiscordChars);
    await sendFinalResponseMessages(channel, record, options.registry, chunks, result.assistantEntryId);
    await archiveWorkingHud(placeholder, record, progressHudSnapshot);
    const titleRecord = await recordCompletedTitleTurn(options.registry, record, prompt, result.text);
    void maybeEvaluateThreadTitle(getThreadChannel(channel), titleRecord, { config: options.config, registry: options.registry }).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`thread title hook failed for ${record.threadId}: ${text}`);
    });
  } catch (error) {
    await stopProgress?.();
    stopTyping?.();
    const text = error instanceof Error ? error.message : String(error);
    await options.registry.patchThread(record.threadId, { status: "error", activeRun: undefined });
    await placeholder.edit(buildErrorPayload(record, text));
  }
}

async function enqueueRunControlPrompt(
  _channel: PromptChannel,
  sourceDiscordId: string,
  placeholder: Message,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
  images: InlineImageContent[] = [],
): Promise<void> {
  const store = options.runControlStore;
  if (!store) throw new Error("runControl is enabled but no Redis store is available");

  const run = buildRunControlRecord(record, sourceDiscordId, placeholder.id, prompt, images);
  const result = await store.tryEnqueueRun(run);
  if (!result.enqueued) {
    const queueableRunId = await store.getQueueableActiveRunId(record.threadId);
    if (!queueableRunId) {
      await placeholder.delete().catch(() => placeholder.edit(buildFinalizingBusyPayload()).then(() => undefined).catch(() => undefined));
      return;
    }
    const intent = parseQueueIntent(prompt);
    await store.appendInput({
      runId: queueableRunId,
      logicalThreadId: record.threadId,
      mode: intent.mode,
      text: intent.text,
      images,
      sourceDiscordMessageId: sourceDiscordId,
      createdAt: new Date().toISOString(),
    });
    const pending = await store.countInputsForRun(record.threadId, queueableRunId).catch(() => 0);
    await placeholder.delete().catch(() => placeholder.edit(buildQueuedPayload(intent.mode, pending)).then(() => undefined).catch(() => undefined));
    return;
  }

  const activeRun = buildActiveRunRecord(sourceDiscordId, placeholder.id, prompt, record.sessionFile, run.runId);
  const queuedRecord: ThreadRecord = { ...record, status: "queued", activeRun };
  await options.registry.patchThread(record.threadId, {
    status: "queued",
    activeRun,
  });
  await placeholder.edit(buildQueuedRunPayload(queuedRecord)).catch(() => undefined);
}

function buildRunControlRecord(
  record: ThreadRecord,
  sourceDiscordMessageId: string,
  placeholderDiscordMessageId: string,
  prompt: string,
  images: InlineImageContent[],
): RunRecord {
  const now = new Date().toISOString();
  const runId = `run-${Date.now()}-${randomUUID()}`;
  return {
    runId,
    logicalThreadId: record.threadId,
    threadId: record.threadId,
    kind: record.kind === "discord-dm-workroom" ? "discord-dm-workroom" : "discord-thread",
    status: "queued",
    sourceDiscordMessageId,
    placeholderDiscordMessageId,
    prompt,
    promptPreview: summarizeActiveRunPrompt(prompt),
    cwd: record.cwd,
    workspaceName: record.workspaceName,
    sessionFile: record.sessionFile,
    images,
    createdAt: now,
    updatedAt: now,
  };
}

function createRunControlWorkerAdapter(client: Client, options: RunBotOptions): RunControlWorkerAdapter {
  const hudSnapshots = new Map<string, ProgressHudSnapshot>();
  return {
    async executeRun(run, progressEvents) {
      const record = options.registry.getThread(run.threadId);
      if (!record) throw new Error(`No registry record for run-control thread ${run.threadId}`);
      const channel = await resolvePromptChannel(client, record);
      const placeholder = await fetchPlaceholderMessage(channel, run.placeholderDiscordMessageId);
      let stopTyping: (() => void) | undefined;
      let stopProgress: (() => Promise<void>) | undefined;
      let unsubscribeProgress: (() => void) | undefined;
      try {
        stopTyping = startTypingIndicator(channel);
        const thread = getThreadChannel(channel);
        if (thread) await maybeRenameThreadForPrompt(thread, record, run.prompt, options.registry);
        const runningRecord: ThreadRecord = {
          ...record,
          status: "running",
          activeRun: record.activeRun?.runId === run.runId
            ? record.activeRun
            : buildActiveRunRecord(run.sourceDiscordMessageId, run.placeholderDiscordMessageId, run.prompt, run.sessionFile, run.runId),
        };
        await options.registry.patchThread(record.threadId, {
          status: "running",
          activeRun: runningRecord.activeRun,
        }).catch(() => undefined);
        const renderer = new DiscordMessageRenderer(placeholder, {
          onError(error) {
            console.warn(`progress HUD edit failed for ${run.runId}: ${error.message}`);
          },
        });
        const progress = createProgressHudController({
          renderer,
          record: runningRecord,
          prompt: run.prompt,
          config: options.config,
          warn(message) {
            console.warn(message);
          },
        });
        stopProgress = async () => {
          hudSnapshots.set(run.runId, progress.snapshot());
          await progress.stop();
        };
        unsubscribeProgress = progressEvents.subscribe(progress.update);
        await renderer.render(buildWorkingPayload(runningRecord, run.prompt, {
          phase: "starting",
          title: "Worker claimed Redis run",
          detail: run.sessionFile ? "Rehydrating existing session" : "Creating a durable session",
        })).catch(() => undefined);
        const result = await options.runtimeManager.enqueuePrompt(runningRecord, run.prompt, run.images ?? [], progressEvents.publish);
        unsubscribeProgress?.();
        await stopProgress();
        stopTyping();
        if (result.kind === "queued") {
          throw new Error("Run-control worker prompt was queued into an already-active Pi session instead of producing a final answer");
        }
        await options.registry.recordMessageEntry(run.sourceDiscordMessageId, result.userEntryId);
        return result;
      } catch (error) {
        unsubscribeProgress?.();
        await stopProgress?.();
        hudSnapshots.delete(run.runId);
        stopTyping?.();
        throw error;
      }
    },
    async finalizeRun(run, result) {
      const record = options.registry.getThread(run.threadId);
      if (!record) throw new Error(`No registry record for run-control thread ${run.threadId}`);
      const channel = await resolvePromptChannel(client, record);
      const chunks = chunkForDiscord(result.text, options.config.render.maxDiscordChars);
      const hudSnapshot = hudSnapshots.get(run.runId);
      hudSnapshots.delete(run.runId);
      await sendFinalResponseMessages(channel, record, options.registry, chunks, result.assistantEntryId);
      const placeholder = await fetchPlaceholderMessage(channel, run.placeholderDiscordMessageId);
      await archiveWorkingHud(placeholder, record, hudSnapshot);
      const idleRecord = await options.registry.patchThread(record.threadId, {
        status: "idle",
        activeRun: undefined,
        sessionFile: result.sessionFile ?? record.sessionFile,
      }).catch(() => record);
      const titleRecord = await recordCompletedTitleTurn(options.registry, idleRecord, run.prompt, result.text);
      void maybeEvaluateThreadTitle(getThreadChannel(channel), titleRecord, { config: options.config, registry: options.registry }).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`thread title hook failed for ${record.threadId}: ${text}`);
      });
    },
    async failRun(run, error) {
      const record = options.registry.getThread(run.threadId);
      if (!record) throw new Error(`No registry record for run-control thread ${run.threadId}`);
      const channel = await resolvePromptChannel(client, record);
      const placeholder = await fetchPlaceholderMessage(channel, run.placeholderDiscordMessageId);
      hudSnapshots.delete(run.runId);
      await options.registry.patchThread(record.threadId, { status: "error", activeRun: undefined }).catch(() => undefined);
      await placeholder.edit(buildErrorPayload(record, error.message));
    },
    async applyInput(run, input) {
      const applied = await options.runtimeManager.queueMessageDuringActive(run.threadId, input.text, input.mode, input.images ?? []);
      if (applied.queued) {
        await markQueuedRunInputAccepted(client, run, input, options).catch(() => undefined);
      }
      return applied;
    },
  };
}

async function resolvePromptChannel(client: Client, record: ThreadRecord): Promise<PromptChannel> {
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
  return Boolean(channel && typeof channel.send === "function" && typeof channel.sendTyping === "function");
}

async function fetchPromptChannelMessage(channel: PromptChannel, messageId: string): Promise<Message> {
  const withMessages = channel as PromptChannel & { messages?: { fetch(messageId: string): Promise<Message> } };
  if (!withMessages.messages) throw new Error("Prompt channel cannot fetch Discord messages");
  return withMessages.messages.fetch(messageId);
}

async function fetchPlaceholderMessage(channel: PromptChannel, messageId: string): Promise<Message> {
  return fetchPromptChannelMessage(channel, messageId);
}

async function sendFinalResponseMessages(
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

async function archiveWorkingHud(placeholder: Message, record: ThreadRecord, snapshot?: ProgressHudSnapshot): Promise<void> {
  // Archive is best-effort after final text posts. Do not turn a posted final answer
  // into a run-control failure just because Discord refused the terminal HUD edit;
  // once activeRun clears, stale ESC clicks are still rejected by expectedMessageId.
  const renderer = new DiscordMessageRenderer(placeholder, {
    onError(error) {
      console.warn(`failed to archive run HUD ${placeholder.id}: ${error.message}`);
    },
  });
  await renderer.deactivate(buildArchivedHudPayload(snapshot?.record ?? record, snapshot));
}

function buildThreadCreatedPayload(prompt: string): MessageCreateOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Pi session thread created")
        .setDescription("This Discord thread is now mapped to a durable local Pi session.")
        .addFields({ name: "Prompt", value: truncateForEmbed(prompt, 900) })
        .setFooter({ text: "Pi skills are available normally, including /skill:name." }),
    ],
  };
}

function buildWorkspaceReadyPayload(record: ThreadRecord): RichPayload {
  const graphDescription = formatWorkGraphEmbedDescription(record);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ ${record.workspaceName ? `Workspace ${record.workspaceName}` : "Pi session"} ready`)
    .setDescription([
      `Send your next message in this thread to start or continue Pi.${record.workspaceName ? "" : `\ncwd: ${homeRelative(record.cwd)}`}`,
      graphDescription,
    ].filter(Boolean).join("\n"))
    .setTimestamp(new Date());

  return {
    content: "",
    embeds: [embed],
    components: [],
  };
}

function buildLinkIngestAcceptedPayload(result: LinkIngestSendResult, mode: LinkIngestCommandMode = "ingest"): MessageCreateOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(linkIngestAcceptedTitle(mode))
        .setDescription("Central Inngest has the standalone capture request. Processing status should come back to this thread as the worker path lands.")
        .addFields(
          { name: "URL", value: truncateForEmbed(result.normalizedUrl, 900) },
          { name: "sourceId", value: inlineCode(result.sourceId) },
          { name: "event", value: inlineCode("link/ingest.requested") },
        )
        .setTimestamp(new Date()),
    ],
  };
}

function startTypingIndicator(channel: PromptChannel): () => void {
  void channel.sendTyping().catch(() => undefined);
  const interval = setInterval(() => {
    void channel.sendTyping().catch(() => undefined);
  }, 8_000);
  interval.unref();
  return () => clearInterval(interval);
}

function truncateForEmbed(value: string, maxChars: number): string {
  const clean = value.trim() || "-";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function inlineCode(value: string): string {
  return `\`${truncateForEmbed(value.replace(/`/g, "'"), 900)}\``;
}

function buildWorkspaceListPayload(config: AppConfig): { content: string; flags: MessageFlags.Ephemeral; components?: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  const workspaces = listWorkspaces(config);
  if (workspaces.length === 0) {
    return { content: workspaceUsage(config), flags: MessageFlags.Ephemeral };
  }
  return {
    content: [
      "Configured Pi workspaces:",
      ...workspaces.map((workspace) => `- ${workspace.name}: ${homeRelative(workspace.cwd)}`),
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
    components: buildWorkspaceSelectComponents(config),
  };
}

function buildWorkspacePickerPayload(config: AppConfig): { content: string; flags: MessageFlags.Ephemeral; components?: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  const workspaces = listWorkspaces(config);
  if (workspaces.length === 0) {
    return { content: workspaceUsage(config), flags: MessageFlags.Ephemeral };
  }
  return {
    content: "Pick a workspace to start a Pi thread:",
    flags: MessageFlags.Ephemeral,
    components: buildWorkspaceSelectComponents(config),
  };
}

function buildWorkspaceSelectComponents(config: AppConfig): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const select = new StringSelectMenuBuilder()
    .setCustomId("pi:workspace-select")
    .setPlaceholder("Choose a workspace")
    .addOptions(
      ...listWorkspaces(config).slice(0, 25).map((workspace) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(workspace.name.slice(0, 100))
          .setDescription(homeRelative(workspace.cwd).slice(0, 100))
          .setValue(workspace.name),
      ),
    );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

function formatRecentSessions(registry: RegistryPort): string {
  const records = recentThreads(registry).slice(0, 10);
  if (records.length === 0) return "No Discord ↔ Pi sessions are registered yet.";
  return [
    "Recent Pi sessions:",
    ...records.map((record) => `- ${formatSessionChoice(record)} (${record.threadId})`),
    "",
    "Use `/pi resume session:<session>` to resume one.",
  ].join("\n");
}

function recentThreads(registry: RegistryPort): ThreadRecord[] {
  return registry.listThreads()
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function formatSessionChoice(record: ThreadRecord): string {
  const label = record.sessionName ?? record.workspaceName ?? record.threadId;
  const workspace = record.workspaceName ? ` [${record.workspaceName}]` : "";
  return `${label}${workspace} - ${homeRelative(record.cwd)}`;
}

function buildMessageContextPrompt(message: Message): string {
  const content = message.content.trim() || "(no text content)";
  return [
    "Ask Pi about this Discord message.",
    "",
    `Message URL: ${message.url}`,
    `Author: ${message.author.displayName ?? message.author.username}`,
    "",
    "Message content:",
    content,
  ].join("\n");
}

function homeRelative(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

async function sendStatus(message: Message, registry: RegistryPort): Promise<void> {
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  if (!threadId) {
    await safeReply(message, "Use `status` inside a registered Pi thread.");
    return;
  }

  const record = registry.getThread(threadId);
  if (!record) {
    await safeReply(message, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  await safeReply(message, formatStatus(record));
}

async function sendStatusInteraction(interaction: ChatInputCommandInteraction, registry: RegistryPort): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  if (!threadId) {
    await replyEphemeral(interaction, "Use `/pi status` inside a registered Pi thread.");
    return;
  }

  const record = registry.getThread(threadId);
  if (!record) {
    await replyEphemeral(interaction, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  await replyEphemeral(interaction, formatStatus(record));
}

async function sendDebugInteraction(interaction: ChatInputCommandInteraction, options: RunBotOptions): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  const record = threadId ? options.registry.getThread(threadId) : undefined;
  const payload = {
    scope: record ? "thread" : "bridge",
    currentThreadId: threadId ?? null,
    currentRecord: record ?? null,
    runtime: {
      node: process.version,
      pid: process.pid,
      cwd: process.cwd(),
    },
    discordThreadMode: {
      systemPromptUrl: DISCORD_SYSTEM_PROMPT_URL,
    },
    config: {
      dataDir: options.config.dataDir,
      discord: {
        guildIds: options.config.discord.guildIds,
        channelIds: options.config.discord.channelIds,
        contextChannels: options.config.discord.contextChannels,
        commandPrefix: options.config.discord.commandPrefix,
        respondToMentions: options.config.discord.respondToMentions,
        configuredAllowlistCount: options.config.discord.allowedUserIds.length,
        effectiveAllowlistCount: options.allowedUserIds.length,
        tokenEnv: options.config.discord.tokenEnv,
        tokenSecretName: options.config.discord.tokenSecretName,
      },
      pi: {
        defaultCwd: options.config.pi.defaultCwd,
        agentDir: options.config.pi.agentDir,
        sessionDir: options.config.pi.sessionDir,
        idleTtlMs: options.config.pi.idleTtlMs,
        workspaces: options.config.pi.workspaces,
      },
      render: options.config.render,
      attachments: options.config.attachments,
      linkIngest: {
        enabled: options.config.linkIngest.enabled,
        inngestUrl: options.config.linkIngest.inngestUrl,
        eventKeyEnv: options.config.linkIngest.eventKeyEnv,
        eventKeySecretName: options.config.linkIngest.eventKeySecretName,
        signingKeyEnv: options.config.linkIngest.signingKeyEnv,
        signingKeySecretName: options.config.linkIngest.signingKeySecretName,
        statusBridgeEnabled: options.config.linkIngest.statusBridgeEnabled,
        defaultVisibility: options.config.linkIngest.defaultVisibility,
        defaultSite: options.config.linkIngest.defaultSite,
        wzrrdCandidate: options.config.linkIngest.wzrrdCandidate,
        requestTimeoutMs: options.config.linkIngest.requestTimeoutMs,
      },
    },
    registry: {
      threadCount: options.registry.listThreads().length,
      recentThreads: recentThreads(options.registry).slice(0, 5),
    },
  };

  await replyEphemeralJson(interaction, "Pi bridge debug", payload);
}

async function reloadInteraction(interaction: ChatInputCommandInteraction, options: RunBotOptions): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  if (!threadId) {
    await replyEphemeral(interaction, "Use `/pi reload` inside a registered Pi thread.");
    return;
  }

  const record = options.registry.getThread(threadId);
  if (!record) {
    await replyEphemeral(interaction, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueReload(record).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`queued reload failed for ${threadId}: ${text}`);
    });
    await interaction.editReply("Reload queued. It will run after the current turn finishes.");
    return;
  }

  await options.runtimeManager.enqueueReload(record);
  await interaction.editReply("Reloaded Pi resources for this thread session.");
}

async function reloadRecordMessage(message: Message, record: ThreadRecord, options: RunBotOptions): Promise<void> {
  const threadId = record.threadId;
  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueReload(record).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`queued reload failed for ${threadId}: ${text}`);
    });
    await safeReply(message, "Reload queued. It will run after the current turn finishes.");
    return;
  }

  await options.runtimeManager.enqueueReload(record);
  await safeReply(message, "Reloaded Pi resources for this session.");
}

async function reloadMessage(message: Message, options: RunBotOptions): Promise<void> {
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  if (!threadId) {
    await safeReply(message, "Use `reload` inside a registered Pi thread.");
    return;
  }

  const record = options.registry.getThread(threadId);
  if (!record) {
    await safeReply(message, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueReload(record).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`queued reload failed for ${threadId}: ${text}`);
    });
    await safeReply(message, "Reload queued. It will run after the current turn finishes.");
    return;
  }

  await options.runtimeManager.enqueueReload(record);
  await safeReply(message, "Reloaded Pi resources for this thread session.");
}

async function compactInteraction(interaction: ChatInputCommandInteraction, options: RunBotOptions): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  if (!threadId) {
    await replyEphemeral(interaction, "Use `/pi compact` inside a registered Pi thread.");
    return;
  }

  const record = options.registry.getThread(threadId);
  if (!record) {
    await replyEphemeral(interaction, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  const instructions = interaction.options.getString("instructions")?.trim() || undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueCompact(record, instructions)
      .then((result) => interaction.followUp({ content: formatCompactReceipt(result), flags: MessageFlags.Ephemeral }))
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`queued compact failed for ${threadId}: ${text}`);
        return interaction.followUp({ content: `Compact failed: ${text}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      });
    await interaction.editReply("Compact queued. It will run after the current turn finishes.");
    return;
  }

  try {
    const result = await options.runtimeManager.enqueueCompact(record, instructions);
    await interaction.editReply(formatCompactReceipt(result));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Compact failed: ${text}`);
  }
}

async function compactRecordMessage(message: Message, record: ThreadRecord, options: RunBotOptions, instructions?: string): Promise<void> {
  const threadId = record.threadId;
  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueCompact(record, instructions)
      .then((result) => safeReply(message, formatCompactReceipt(result)))
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`queued compact failed for ${threadId}: ${text}`);
        return safeReply(message, `Compact failed: ${text}`).catch(() => undefined);
      });
    await safeReply(message, "Compact queued. It will run after the current turn finishes.");
    return;
  }

  try {
    const result = await options.runtimeManager.enqueueCompact(record, instructions);
    await safeReply(message, formatCompactReceipt(result));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await safeReply(message, `Compact failed: ${text}`);
  }
}

async function compactMessage(message: Message, options: RunBotOptions, instructions?: string): Promise<void> {
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  if (!threadId) {
    await safeReply(message, "Use `compact` inside a registered Pi thread.");
    return;
  }

  const record = options.registry.getThread(threadId);
  if (!record) {
    await safeReply(message, "This Discord thread is not registered to a Pi session yet.");
    return;
  }

  if (options.runtimeManager.isActive(threadId)) {
    void options.runtimeManager.enqueueCompact(record, instructions)
      .then((result) => safeReply(message, formatCompactReceipt(result)))
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        console.warn(`queued compact failed for ${threadId}: ${text}`);
        return safeReply(message, `Compact failed: ${text}`).catch(() => undefined);
      });
    await safeReply(message, "Compact queued. It will run after the current turn finishes.");
    return;
  }

  try {
    const result = await options.runtimeManager.enqueueCompact(record, instructions);
    await safeReply(message, formatCompactReceipt(result));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await safeReply(message, `Compact failed: ${text}`);
  }
}

function formatCompactReceipt(result: { tokensBefore: number; firstKeptEntryId: string; summary: string }): string {
  const preview = truncateForEmbed(result.summary.replace(/\s+/g, " "), 500);
  return [
    "Compacted Pi session context.",
    `tokensBefore: ${result.tokensBefore.toLocaleString()}`,
    `firstKeptEntry: ${result.firstKeptEntryId}`,
    `summary: ${preview}`,
  ].join("\n");
}

async function abortInteraction(
  interaction: ChatInputCommandInteraction,
  runtimeManager: PiRuntimePort,
): Promise<void> {
  const threadId = interaction.channel?.isThread() ? interaction.channel.id : undefined;
  if (!threadId) {
    await replyEphemeral(interaction, "Use `/pi esc` inside a registered Pi thread.");
    return;
  }

  await runtimeManager.abort(threadId);
  await replyEphemeral(interaction, "ESC requested for this Pi session.");
}

function formatStatus(record: ThreadRecord): string {
  return [
    `status: ${record.status}`,
    record.workspaceName ? `workspace: ${record.workspaceName}` : undefined,
    ...formatWorkGraphStatus(record),
    `cwd: ${record.cwd}`,
    `session: ${record.sessionFile ?? "not created yet"}`,
  ].filter(Boolean).join("\n");
}

function isCommand(content: string, command: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === command || trimmed.startsWith(`${command} `);
}

function commandArgs(content: string, command: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.toLowerCase() === command) return undefined;
  if (!trimmed.toLowerCase().startsWith(`${command} `)) return undefined;
  return trimmed.slice(command.length).trim() || undefined;
}

async function safeReply(message: Message, text: string): Promise<void> {
  try {
    await message.reply(text);
  } catch {
    if (message.channel.isSendable()) {
      await message.channel.send(text);
    }
  }
}

type EphemeralInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | MessageContextMenuCommandInteraction;

async function replyEphemeral(interaction: EphemeralInteraction, text: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(text).catch(async () => {
      await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    });
    return;
  }
  await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
}

async function replyEphemeralJson(interaction: ChatInputCommandInteraction, title: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  const chunks = chunkForDiscord(json, 1700);
  const first = `${title}\n\`\`\`json\n${chunks[0] ?? "{}"}\n\`\`\``;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(first);
  } else {
    await interaction.reply({ content: first, flags: MessageFlags.Ephemeral });
  }
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: `\`\`\`json\n${chunk}\n\`\`\``, flags: MessageFlags.Ephemeral });
  }
}

async function safeInteractionReply(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  await replyEphemeral(interaction, text).catch(() => undefined);
}

function helpText(prefix: string): string {
  return [
    "Pi Discord thread bridge MVP",
    `- Slash: \`/pi ask prompt:<prompt>\` creates/continues a durable Pi session.`,
    `- Slash: \`/pi skill name:<skill> args:<optional>\` invokes a Pi skill as \`/skill:name\`.`,
    `- Slash: \`/pi workspace name:<workspace> prompt:<optional>\` creates a thread rooted in a configured workspace.`,
    `- Slash: \`/pi ingest url:<url> note:<optional>\` and \`/pi capture url:<url> note:<optional>\` send explicit out-of-phase source captures.`,
    `- Slash: \`/aih-triage\` starts the standard AI Hero fresh support triage run in the aihero workspace.`,
    `- Slash: \`/pi status\`, \`/pi debug\`, \`/pi reload\`, \`/pi compact\`, \`/pi esc\`, \`/pi abort\`, \`/pi help\`.`,
    `- Prefix fallback: \`${prefix} <prompt>\`, \`${prefix} workspace <name> [prompt]\`, \`${prefix} ingest <url> [note]\`, \`${prefix} status\`, \`${prefix} reload\`, \`${prefix} compact [instructions]\`, \`${prefix} esc\`, \`${prefix} help\`.`,
    "- In a registered thread, normal messages continue the Pi session; while active they queue as steering messages.",
    "- In DM, normal messages continue the configured Personal Workroom prototype.",
    "- Pi skills work normally in messages; Discord slash equivalent is `/pi skill`",
  ].join("\n");
}
