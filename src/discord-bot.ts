import { homedir } from "node:os";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from "discord.js";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendAttachmentContext } from "./attachments.js";
import type { AppConfig } from "./config.js";
import { PiRuntimeManager, type PromptProgress } from "./pi-runtime.js";
import { Registry, type ThreadRecord } from "./registry.js";
import {
  listWorkspaces,
  parseLeadingCwdFlag,
  parseWorkspaceCommand,
  resolveCwdInput,
  resolveWorkspaceInput,
  workspaceUsage,
} from "./cwd.js";
import { applicationCommands, askPiMessageCommandName } from "./discord-commands.js";
import { DISCORD_SYSTEM_PROMPT_URL } from "./discord-system-prompt.js";
import { chunkForDiscord, stripBotMention, stripCommandPrefix, summarizeForThreadName } from "./render.js";

interface RunBotOptions {
  config: AppConfig;
  token: string;
  allowedUserIds: string[];
  registry: Registry;
  runtimeManager: PiRuntimeManager;
}

export async function runBot(options: RunBotOptions): Promise<void> {
  const allowedUsers = new Set(options.allowedUserIds.filter(Boolean));
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, async () => {
    console.log(`pi-discord-threads logged in as ${client.user?.tag ?? "unknown bot"}`);
    if (allowedUsers.size > 0) {
      console.log(`allowlist enabled for ${allowedUsers.size} Discord user id(s)`);
    }
    await registerSlashCommands(client, options.config);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
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

      if (!interaction.isChatInputCommand() || interaction.commandName !== "pi") return;
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

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down...`);
    await options.runtimeManager.disposeAll();
    client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(options.token);
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

async function handlePiAutocomplete(interaction: AutocompleteInteraction, config: AppConfig, registry: Registry): Promise<void> {
  const focusedOption = interaction.options.getFocused(true);
  const focused = String(focusedOption.value).toLowerCase();
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand === "workspace") {
    const matches = listWorkspaces(config)
      .filter((workspace) => workspace.name.includes(focused) || workspace.cwd.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((workspace) => ({
        name: `${workspace.name} — ${homeRelative(workspace.cwd)}`.slice(0, 100),
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
      name: `${skill.name} — ${skill.description}`.slice(0, 100),
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

async function handlePiButton(
  interaction: ButtonInteraction,
  options: RunBotOptions,
  allowedUsers: Set<string>,
): Promise<void> {
  if (!isAllowedComponentInteraction(interaction, options.config, allowedUsers)) {
    await replyEphemeral(interaction, "You are not allowed to use this Pi bridge here.");
    return;
  }

  const [, action, threadId] = interaction.customId.split(":");
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
  if (existing && !workspaceInput && !cwdInput) {
    cwd = existing.cwd;
    workspaceName = existing.workspaceName;
  }
  if (workspaceInput) {
    const workspace = await resolveWorkspaceInput(workspaceInput, options.config);
    cwd = workspace.cwd;
    workspaceName = workspace.name;
  } else if (cwdInput) {
    cwd = await resolveCwdInput(cwdInput, options.config.pi.defaultCwd);
  }

  const thread = channel.isThread()
    ? (channel as ThreadChannel)
    : await createThreadFromChannelObject(channel, prompt, title || undefined);
  const record = await ensureThreadRecord(thread, options, title || prompt, cwd, workspaceName);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  const placeholder = await thread.send(buildWorkingPayload(record, prompt, {
    phase: "starting",
    title: "Starting Pi session",
    detail: "Queued from compose modal",
  }));
  await interaction.editReply(`Prompt started in <#${thread.id}>.`);
  await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, prompt, options);
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
  const record = existing ?? await ensureThreadRecord(thread, options, basePrompt, options.config.pi.defaultCwd);
  const prompt = await appendAttachmentContext(basePrompt, targetMessage, options.config, thread.id);
  await options.registry.recordMessage({
    discordMessageId: interaction.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });
  await interaction.editReply(`Asked Pi about the selected message in <#${thread.id}>.`);
  await runPromptInThread(thread, interaction.id, record, prompt, options);
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
    guildId: thread.guildId,
    parentChannelId: thread.parentId ?? undefined,
    cwd: source.cwd,
    workspaceName: source.workspaceName,
    sessionFile: source.sessionFile,
    sessionName: source.sessionName ?? summarizeForThreadName(prompt ?? "resumed Pi session"),
    status: "idle",
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
  const record = await ensureThreadRecord(thread, options, forkPrompt, source.cwd, source.workspaceName);
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
    await interaction.editReply(`Fork created in <#${thread.id}> and prompt started.`);
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
  await interaction.editReply(`Fork created in <#${thread.id}>.`);
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

  const cwd = await resolveCwdInput(cwdInput, options.config.pi.defaultCwd);

  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const record = await ensureThreadRecord(thread, options, prompt, cwd, workspaceName);
    const response = await interaction.reply({
      ...buildWorkingPayload(record, prompt, {
        phase: "starting",
        title: "Starting Pi session",
        detail: record.sessionFile ? "Rehydrating existing session" : `cwd: ${record.cwd}`,
      }),
      withResponse: true,
    });
    await options.registry.recordMessage({
      discordMessageId: interaction.id,
      threadId: thread.id,
      direction: "user",
      createdAt: new Date().toISOString(),
    });
    const placeholder = (response.resource?.message ?? await interaction.fetchReply()) as Message;
    await runPromptWithPlaceholder(thread, interaction.id, placeholder, record, prompt, options);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await createThreadFromChannel(interaction, prompt);
  if (!thread) return;

  await interaction.deleteReply().catch(() => undefined);
  const record = await ensureThreadRecord(thread, options, prompt, cwd, workspaceName);
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
  const cwd = await resolveCwdInput(parsed.cwdInput, options.config.pi.defaultCwd);

  const thread = inThread
    ? (message.channel as ThreadChannel)
    : await createThreadFromMessage(message, parsed.prompt);
  if (!thread) return;

  const record = await ensureThreadRecord(thread, options, parsed.prompt, cwd);
  await options.registry.recordMessage({
    discordMessageId: message.id,
    threadId: thread.id,
    direction: "user",
    createdAt: new Date().toISOString(),
  });

  const prompt = await appendAttachmentContext(parsed.prompt || "Please inspect the attached file(s).", message, options.config, thread.id);
  await runPromptInThread(thread, message.id, record, prompt, options);
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
    const enrichedPrompt = await appendAttachmentContext(prompt || "Please inspect the attached file(s).", message, options.config, thread.id);
    await runPromptInThread(thread, message.id, record, enrichedPrompt, options);
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

async function createThreadFromMessage(message: Message, prompt: string): Promise<ThreadChannel | undefined> {
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
    reason: "Create durable Pi session thread",
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
    reason: "Create durable Pi session thread",
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
    guildId: thread.guildId,
    parentChannelId: thread.parentId ?? undefined,
    cwd,
    workspaceName,
    sessionName: summarizeForThreadName(prompt),
    status: "idle",
  });
}

async function runPromptInThread(
  thread: ThreadChannel,
  sourceDiscordId: string,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
): Promise<void> {
  const placeholder = await thread.send(buildWorkingPayload(record, prompt, {
    phase: "starting",
    title: "Starting Pi session",
    detail: "Queued from Discord message",
  }));
  await runPromptWithPlaceholder(thread, sourceDiscordId, placeholder, record, prompt, options);
}

async function queueIfActive(
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
): Promise<{ queued: boolean; mode?: "steer" | "followUp"; pendingMessageCount?: number }> {
  const intent = parseQueueIntent(prompt);
  return options.runtimeManager.queueMessageDuringActive(record.threadId, intent.text, intent.mode);
}

function parseQueueIntent(prompt: string): { text: string; mode: "steer" | "followUp" } {
  const trimmed = prompt.trim();
  const followUpMatch = trimmed.match(/^(?:follow[- ]?up|after|later)\s*[:：]?\s+([\s\S]*)$/i);
  if (followUpMatch?.[1]?.trim()) {
    return { mode: "followUp", text: followUpMatch[1].trim() };
  }
  return { mode: "steer", text: prompt };
}

async function runPromptWithPlaceholder(
  thread: ThreadChannel,
  sourceDiscordId: string,
  placeholder: Message,
  record: ThreadRecord,
  prompt: string,
  options: RunBotOptions,
): Promise<void> {
  await options.registry.recordMessage({
    discordMessageId: placeholder.id,
    threadId: thread.id,
    direction: "assistant",
    createdAt: new Date().toISOString(),
  });

  let stopTyping: (() => void) | undefined;
  let stopProgress: (() => void) | undefined;

  try {
    const queued = await queueIfActive(record, prompt, options);
    if (queued.queued) {
      await placeholder.edit(buildQueuedPayload(queued.mode ?? "steer", queued.pendingMessageCount ?? 0));
      return;
    }

    stopTyping = startTypingIndicator(thread);
    await maybeRenameThreadForPrompt(thread, record, prompt, options.registry);
    const progress = createProgressUpdater(placeholder, record, prompt);
    stopProgress = progress.stop;
    await placeholder.edit(buildWorkingPayload(record, prompt, {
      phase: "starting",
      title: "Starting Pi session",
      detail: record.sessionFile ? "Rehydrating existing session" : "Creating a durable session",
    }));

    const result = await options.runtimeManager.enqueuePrompt(record, prompt, progress.update);
    stopProgress();
    stopTyping();
    await options.registry.recordMessageEntry(sourceDiscordId, result.userEntryId);
    await options.registry.recordMessageEntry(placeholder.id, result.assistantEntryId);

    const chunks = chunkForDiscord(result.text, options.config.render.maxDiscordChars);
    await placeholder.edit(buildDonePayload(record, result.sessionFile, chunks[0]));
    for (const chunk of chunks.slice(1)) {
      await thread.send({ content: chunk });
    }
  } catch (error) {
    stopProgress?.();
    stopTyping?.();
    const text = error instanceof Error ? error.message : String(error);
    await options.registry.patchThread(thread.id, { status: "error" });
    await placeholder.edit(buildErrorPayload(record, text));
  }
}

type RichPayload = Pick<MessageCreateOptions & MessageEditOptions, "content" | "embeds" | "components">;

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

function buildWorkingPayload(record: ThreadRecord, prompt: string, progress: PromptProgress): RichPayload {
  const embed = new EmbedBuilder()
    .setColor(progress.isError ? 0xed4245 : 0x5865f2)
    .setTitle(formatWorkingTitle(progress))
    .setDescription(formatWorkingDescription(prompt, progress))
    .setTimestamp(new Date());

  if (record.workspaceName) {
    embed.setFooter({ text: `workspace: ${record.workspaceName}` });
  }

  return {
    content: "",
    embeds: [embed],
    components: buildRunControls(record.threadId),
  };
}

function buildWorkspaceReadyPayload(record: ThreadRecord): RichPayload {
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`✅ ${record.workspaceName ? `Workspace ${record.workspaceName}` : "Pi session"} ready`)
        .setDescription(`Send your next message in this thread to start or continue Pi.${record.workspaceName ? "" : `\ncwd: ${homeRelative(record.cwd)}`}`)
        .setTimestamp(new Date()),
    ],
    components: [],
  };
}

function buildDonePayload(_record: ThreadRecord, _sessionFile: string | undefined, firstChunk: string | undefined): RichPayload {
  return {
    content: firstChunk ?? "(no assistant text produced)",
    embeds: [],
    components: [],
  };
}

function buildQueuedPayload(mode: "steer" | "followUp", pendingCount: number): RichPayload {
  const label = mode === "followUp" ? "follow-up" : "steering";
  return {
    content: `Queued as ${label}${pendingCount > 0 ? ` (${pendingCount} pending)` : ""}.`,
    embeds: [],
    components: [],
  };
}

function buildErrorPayload(record: ThreadRecord, error: string): RichPayload {
  return {
    content: "",
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("❌ Pi run failed")
        .setDescription(truncateForEmbed(error, 1800))
        .setTimestamp(new Date())
        .setFooter(record.workspaceName ? { text: `workspace: ${record.workspaceName}` } : null),
    ],
    components: buildRunControls(record.threadId, { abortDisabled: true }),
  };
}

function buildRunControls(threadId: string, options: { abortDisabled?: boolean } = {}): ActionRowBuilder<ButtonBuilder>[] {
  if (options.abortDisabled) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`pi:abort:${threadId}`)
        .setLabel("ESC")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function createProgressUpdater(placeholder: Message, record: ThreadRecord, prompt: string): {
  update: (progress: PromptProgress) => void;
  stop: () => void;
} {
  const startedAt = Date.now();
  let latest: PromptProgress | undefined;
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastEditAt = 0;
  let stopped = false;

  const withElapsed = (progress: PromptProgress): PromptProgress => ({
    ...progress,
    elapsedMs: Date.now() - startedAt,
  });

  const flush = async () => {
    if (stopped || !latest) return;
    timer = undefined;
    lastEditAt = Date.now();
    await placeholder.edit(buildWorkingPayload(record, prompt, withElapsed(latest))).catch(() => undefined);
  };

  heartbeat = setInterval(() => {
    if (!latest || stopped) return;
    void flush();
  }, 5_000);
  heartbeat.unref();

  return {
    update(progress) {
      if (stopped) return;
      latest = progress;
      const elapsed = Date.now() - lastEditAt;
      if (elapsed >= 2_500) {
        void flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => void flush(), 2_500 - elapsed);
        timer.unref();
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
    },
  };
}

function startTypingIndicator(thread: ThreadChannel): () => void {
  void thread.sendTyping().catch(() => undefined);
  const interval = setInterval(() => {
    void thread.sendTyping().catch(() => undefined);
  }, 8_000);
  interval.unref();
  return () => clearInterval(interval);
}

async function maybeRenameThreadForPrompt(thread: ThreadChannel, record: ThreadRecord, prompt: string, registry: Registry): Promise<void> {
  const desired = summarizeForThreadName(prompt);
  if (!shouldRenameThread(thread.name, desired)) return;
  const renamed = await thread.setName(desired, "Update Pi thread name from current task").then(() => true).catch(() => false);
  if (renamed) await registry.patchThread(record.threadId, { sessionName: desired }).catch(() => undefined);
}

function shouldRenameThread(currentName: string, desiredName: string): boolean {
  if (!desiredName || currentName === desiredName) return false;
  const normalized = currentName.toLowerCase().trim();
  return normalized === "pi session"
    || normalized === "pi: pi session"
    || normalized === "π pi session"
    || normalized.startsWith("pi: workspace ")
    || normalized.startsWith("pi: fork of ")
    || normalized.startsWith("pi: resume ")
    || normalized.startsWith("🗂️ ")
    || normalized.startsWith("π fork of ")
    || normalized.startsWith("π resume ");
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function formatWorkingTitle(progress: PromptProgress): string {
  const elapsed = progress.elapsedMs !== undefined ? ` · ${formatElapsed(progress.elapsedMs)}` : "";
  return `${statusIcon(progress.phase, progress.isError, progress.toolName)} ${progress.title}${elapsed}`;
}

function formatWorkingDescription(prompt: string, progress: PromptProgress): string {
  if (progress.textPreview) {
    return [`Writing response…`, "", truncateForEmbed(progress.textPreview, 800)].join("\n");
  }

  const lines: string[] = [];
  if (progress.toolName) lines.push(`Tool: ${progress.toolName}`);
  if (progress.detail) lines.push(truncateForEmbed(progress.detail, 260));
  lines.push(`Request: ${truncateForEmbed(prompt.replace(/\s+/g, " "), 180)}`);
  return lines.join("\n");
}

function phaseLabel(phase: PromptProgress["phase"]): string {
  switch (phase) {
    case "starting":
      return "starting";
    case "thinking":
      return "thinking";
    case "streaming":
      return "writing";
    case "tool":
      return "using a tool";
    case "compaction":
      return "compacting context";
    case "retry":
      return "retrying";
    case "done":
      return "done";
  }
}

function statusIcon(phase: PromptProgress["phase"], isError: boolean | undefined, toolName?: string): string {
  if (isError) return "⚠️";
  if (phase === "tool" && toolName) return toolIcon(toolName);
  switch (phase) {
    case "starting":
      return "🚀";
    case "thinking":
      return "🧠";
    case "streaming":
      return "✍️";
    case "tool":
      return "🛠️";
    case "compaction":
      return "🗜️";
    case "retry":
      return "🔁";
    case "done":
      return "✅";
  }
}

function toolIcon(toolName: string): string {
  switch (toolName) {
    case "read":
      return "📖";
    case "edit":
      return "✏️";
    case "write":
      return "📝";
    case "bash":
      return "💻";
    case "grep":
    case "find":
    case "web_search":
    case "web_search_links":
      return "🔎";
    case "url_to_markdown":
      return "🌐";
    case "mcq":
      return "🙋";
    case "workflow":
      return "🔀";
    default:
      return "🛠️";
  }
}

function truncateForEmbed(value: string, maxChars: number): string {
  const clean = value.trim() || "—";
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

function formatRecentSessions(registry: Registry): string {
  const records = recentThreads(registry).slice(0, 10);
  if (records.length === 0) return "No Discord ↔ Pi sessions are registered yet.";
  return [
    "Recent Pi sessions:",
    ...records.map((record) => `- ${formatSessionChoice(record)} (${record.threadId})`),
    "",
    "Use `/pi resume session:<session>` to resume one.",
  ].join("\n");
}

function recentThreads(registry: Registry): ThreadRecord[] {
  return registry.listThreads()
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function formatSessionChoice(record: ThreadRecord): string {
  const label = record.sessionName ?? record.workspaceName ?? record.threadId;
  const workspace = record.workspaceName ? ` [${record.workspaceName}]` : "";
  return `${label}${workspace} — ${homeRelative(record.cwd)}`;
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

async function sendStatus(message: Message, registry: Registry): Promise<void> {
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

async function sendStatusInteraction(interaction: ChatInputCommandInteraction, registry: Registry): Promise<void> {
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

async function abortInteraction(
  interaction: ChatInputCommandInteraction,
  runtimeManager: PiRuntimeManager,
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
    `cwd: ${record.cwd}`,
    `session: ${record.sessionFile ?? "not created yet"}`,
  ].filter(Boolean).join("\n");
}

function isCommand(content: string, command: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === command || trimmed.startsWith(`${command} `);
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
    `- Slash: \`/pi status\`, \`/pi debug\`, \`/pi reload\`, \`/pi esc\`, \`/pi abort\`, \`/pi help\`.`,
    `- Prefix fallback: \`${prefix} <prompt>\`, \`${prefix} workspace <name> [prompt]\`, \`${prefix} status\`, \`${prefix} reload\`, \`${prefix} esc\`, \`${prefix} help\`.`,
    "- In a registered thread, normal messages continue the Pi session; while active they queue as steering messages.",
    "- Pi skills work normally in messages; Discord slash equivalent is `/pi skill`.",
  ].join("\n");
}
