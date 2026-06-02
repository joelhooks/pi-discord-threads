import { ApplicationCommandType, ContextMenuCommandBuilder, SlashCommandBuilder, type ApplicationCommandData } from "discord.js";

export const askPiMessageCommandName = "Ask Pi about message";

export const piCommand = new SlashCommandBuilder()
  .setName("pi")
  .setDescription("Run and manage local Pi coding-agent sessions")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("ask")
      .setDescription("Send a prompt to Pi, creating a thread if needed")
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("Prompt to send to the Pi session")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("cwd")
          .setDescription("Working directory for a new session; supports ~ and @Code/...")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("skill")
      .setDescription("Invoke a Pi skill by name")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Pi skill name, e.g. diagnose or grill-with-docs")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("args")
          .setDescription("Optional arguments to pass after /skill:name")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("cwd")
          .setDescription("Working directory for a new session; supports ~ and @Code/...")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("workspace")
      .setDescription("Start a thread/session rooted in a configured workspace")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Workspace name from pi.workspaces, e.g. aihero")
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("Optional first prompt to run in the workspace")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("workspaces")
      .setDescription("List configured Pi workspace aliases"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("sessions")
      .setDescription("List recent Discord ↔ Pi session mappings"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("resume")
      .setDescription("Resume a recent Pi session in this channel/thread")
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription("Recent session/thread to resume")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("Optional first prompt to send after resuming")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("fork")
      .setDescription("Create a fresh thread/session from the current thread cwd")
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("Optional first prompt for the fork")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("compose")
      .setDescription("Open a modal for a multi-line Pi prompt"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Show the Pi session mapped to this Discord thread"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("debug")
      .setDescription("Show full Pi bridge debug details for this thread"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reload")
      .setDescription("Reload Pi resources for this Discord thread session"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("esc")
      .setDescription("Escape/stop the active Pi run in this Discord thread"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("abort")
      .setDescription("Abort the active Pi run in this Discord thread"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("help")
      .setDescription("Show Pi Discord bridge help"),
  );

export const askPiMessageCommand = new ContextMenuCommandBuilder()
  .setName(askPiMessageCommandName)
  .setType(ApplicationCommandType.Message);

export function applicationCommands(): ApplicationCommandData[] {
  return [piCommand.toJSON(), askPiMessageCommand.toJSON()] as ApplicationCommandData[];
}
