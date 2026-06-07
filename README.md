# pi-discord-threads

Portable local Discord bridge for durable Pi coding-agent sessions.

## Current MVP

- `!pi <prompt>` in a server text channel creates a Discord thread and a persistent Pi session.
- `/pi workspace name:<workspace>` or `!pi workspace <workspace>` creates a thread rooted in a configured workspace cwd.
- `/pi compose` opens a multi-line prompt modal; active run messages include only a minimal ESC button.
- Message context menu `Ask Pi about message` starts a Pi thread from a selected Discord message.
- Messages inside a registered Discord thread continue that Pi session.
- Bot DMs can be wired to a single-user Personal Workroom prototype through config, disabled by default.
- Pi skills behave normally, including model auto-invocation. Discord slash equivalent is `/pi skill name:<skill>`.
- Local secrets are leased from `secrets`; values are never printed.
- Registry stores `discord_thread_id -> pi_session_file` and message-to-entry IDs when available.
- Run status uses a native Discord HUD with an LLM narrator while running; final answers are posted as fresh Discord messages so thread notifications fire.

## Requirements

- Node.js `>=22.19.0`
- Local `pi` credentials/settings already configured
- Local `secrets` daemon with `discord_bot_token`
- Discord bot with:
  - Message Content Intent enabled for prefix/normal-thread messages
  - `applications.commands` scope for slash commands
  - permissions to read/send messages
  - permission to create public threads

Optional local secret:

- `discord_allowed_user_id` to restrict access

## Setup

```bash
npm install
npm run build
npm run start -- start
```

Write a config file:

```bash
npm run start -- init-config
```

Default config path:

```text
~/.config/pi-discord-threads/config.json
```

See `config.example.json` for the full shape. If the config file is missing, the daemon uses the same defaults.

### macOS LaunchAgent daemon

For long-running local use on macOS, run the bridge as a user LaunchAgent instead of an orphaned shell/nohup process. This keeps the daemon in the GUI user session so local CLIs that depend on the login keychain, like Macroscope, can read their normal auth.

```bash
npm run build
pi-discord-threads install-launch-agent --config ~/.config/pi-discord-threads/config.json
pi-discord-threads install-launch-agent --config ~/.config/pi-discord-threads/config.json --start
pi-discord-threads launch-agent-status --config ~/.config/pi-discord-threads/config.json
```

Use `--restart` when intentionally replacing the loaded LaunchAgent from a normal terminal, and `uninstall-launch-agent` to boot it out and remove the plist. The start command refuses to launch when it sees another matching daemon process unless `--force` is passed, because duplicate Discord bot connections are fucky. It also refuses to restart from inside an active Discord-run process tree, because that kills the daemon currently carrying the turn.

Workspace aliases are configured under `pi.workspaces`:

```json
{
  "pi": {
    "workspaces": {
      "aihero": "~/Code/badass-courses/aihero-support"
    }
  }
}
```

Discord context-channel defaults are configured under `discord.contextChannels`. They apply only when creating a new/unmapped Pi thread from that Discord channel or one of its child threads. Explicit `cwd`, `/pi workspace`, compose-modal workspace, and existing thread registry records still win.

```json
{
  "discord": {
    "contextChannels": {
      "1234567890123456789": { "workspace": "aihero" }
    }
  }
}
```

Attachment ingestion is controlled under `attachments` with an enabled flag, maximum byte size, content-type prefixes, and extension allowlist. Defaults accept common text, image, audio, video, and PDF uploads up to 25 MB; use `"*"` in `allowedContentTypePrefixes` if you intentionally want to accept every file type.

Live run HUD narration is controlled under `render.hud`. It defaults to `openai-codex/gpt-5.5` and updates only the active placeholder message. When the run completes, the bridge posts the final answer as a fresh Discord message and retires the placeholder.

Redis run control is configured under `runControl` and is **disabled by default**. When enabled, ingress writes jobs, active-thread pointers, leases, queued steer/follow-up input, and finalization guards to Redis. The process can run `bot`, `worker`, and `reconcile` roles together or separately:

```bash
pi-discord-threads start --roles bot,worker,reconcile
pi-discord-threads reconcile --dry-run
pi-discord-threads reconcile --apply
```

`doctor` checks Redis only when `runControl.enabled` is true. With run control disabled, the bridge does not connect to Redis and continues using the original in-process runtime queue. The daemon reconcile role applies safe local cleanup for stale Redis and registry pointers; use `reconcile --dry-run` when you only want a report.

## Discord usage

Slash commands:

```text
/pi ask prompt:<prompt> cwd:<optional>                  create/continue a Discord thread + durable Pi session
/pi skill name:<skill> args:<optional> cwd:<optional>   invoke a Pi skill as /skill:name
/pi workspace name:<optional> prompt:<optional>         create a workspace-rooted thread; no name shows a picker
/pi workspaces                                          list configured workspace aliases
/pi sessions                                            list recent Discord ↔ Pi session mappings
/pi resume session:<session> prompt:<optional>          resume a recent Pi session, with autocomplete
/pi fork prompt:<optional>                              create a child thread with a true Pi fork when a source session file exists
/pi compose                                             open a multi-line prompt modal
/pi status                                              show the current thread mapping
/pi debug                                               show full ephemeral bridge/session debug details
/pi reload                                              reload Pi resources for the current thread session
/pi compact instructions:<optional>                    compact the current thread session context
/pi esc                                                 escape/stop the active Pi run in the current thread
/pi abort                                               abort the active Pi run in the current thread
/pi help                                                show help
```

`cwd` supports absolute paths, `~`, and `@` as home-relative shorthand, e.g. `@Code/badass-courses/second-brain`.

Discord message context menu:

```text
Apps → Ask Pi about message                             create/run a Pi thread from the selected message
```

Prefix fallback:

```text
!pi <prompt>                         create a Discord thread + durable Pi session
!pi --cwd @Code/project <prompt>     create a session rooted in that cwd
!pi workspace <workspace> [prompt]   create a workspace-rooted thread; without prompt it waits for the next message
!pi status                           show the current thread mapping
!pi reload                           reload Pi resources for the current thread session
!pi compact [instructions]           compact the current thread session context
!pi esc                              escape/stop the active Pi run in the current thread
!pi abort                            abort the active Pi run in the current thread
!pi help                             show help
```

In a registered thread, normal messages are sent to the Pi session. If a turn is already running, new messages are queued as steering messages for the active turn; slash/modal/context-menu prompts get an ephemeral queue receipt, while normal Discord messages get a quiet reaction because message-created events cannot be ephemeral. Prefix a message with `followup:` or `after:` to queue it as a follow-up after the current turn completes. With Redis run control enabled, that active-run decision and queued input stream are shared across bridge processes.

In a bot DM, normal messages can route to a single-user Personal Workroom record (`dm:<discordUserId>`) when `discord.personalWorkroom.enabled` is true. Configure its `workspace` or `cwd`, `sessionName`, and optional `extensionPaths` for the local deployment. DM `status`, `reload`, `compact [instructions]`, `esc`, and `abort` operate on that Personal Workroom session.

Attachments on normal thread messages, DM messages, workspace messages, and context-menu-selected messages are downloaded into the bridge data directory and appended to the prompt as local file paths when they pass the configured size/type allowlist. Supported images are also attached inline for model vision when small enough; audio/video/PDF uploads are saved and surfaced with guidance for Pi to inspect/extract/process them with local tools when needed.

## Discord thread mode system prompt

Pi sessions created by this bridge receive an appended Discord Thread Mode system prompt so the model understands the operator is using Discord, not the terminal TUI.

- Source of truth: `src/discord-system-prompt.ts`
- Generated Markdown: `docs/discord-thread-mode-system-prompt.md`
- Review URL: https://pi-discord-system-prompt.wzrrd.sh/

Update/publish it with:

```bash
npm run publish-system-prompt
```

## Design invariants

- Runs locally and is portable; no host-specific assumptions.
- Pi SDK is the control plane.
- Pi session JSONL is the durable source of truth.
- Runtime instances are lazy and disposed after idle TTL.
- Redis run control, when enabled, owns in-flight run coordination; Pi JSONL remains canonical history.
- Run control uses at-least-once execution with idempotent finalization rather than exactly-once promises.
- `/pi fork` creates a child Discord thread and, when possible, a true Pi forked session with `parentSession` lineage.
- `/tree` is a future command that should navigate the current session in-place.
