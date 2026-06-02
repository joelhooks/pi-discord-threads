# pi-discord-threads

Portable local Discord bridge for durable Pi coding-agent sessions.

## Current MVP

- `!pi <prompt>` in a server text channel creates a Discord thread and a persistent Pi session.
- `/pi workspace name:<workspace>` or `!pi workspace <workspace>` creates a thread rooted in a configured workspace cwd.
- `/pi compose` opens a multi-line prompt modal; active run messages include only a minimal ESC button.
- Message context menu `Ask Pi about message` starts a Pi thread from a selected Discord message.
- Messages inside a registered Discord thread continue that Pi session.
- Pi skills behave normally, including model auto-invocation. Discord slash equivalent is `/pi skill name:<skill>`.
- Local secrets are leased from `secrets`; values are never printed.
- Registry stores `discord_thread_id -> pi_session_file` and message-to-entry IDs when available.
- Run status uses compact Discord embeds and typing indicators while running; final output is plain message content so the answer stays front-and-center.

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

Attachment ingestion is controlled under `attachments` with an enabled flag, maximum byte size, content-type prefixes, and extension allowlist. Defaults accept common text, image, audio, video, and PDF uploads up to 25 MB; use `"*"` in `allowedContentTypePrefixes` if you intentionally want to accept every file type.

## Discord usage

Slash commands:

```text
/pi ask prompt:<prompt> cwd:<optional>                  create/continue a Discord thread + durable Pi session
/pi skill name:<skill> args:<optional> cwd:<optional>   invoke a Pi skill as /skill:name
/pi workspace name:<optional> prompt:<optional>         create a workspace-rooted thread; no name shows a picker
/pi workspaces                                          list configured workspace aliases
/pi sessions                                            list recent Discord ↔ Pi session mappings
/pi resume session:<session> prompt:<optional>          resume a recent Pi session, with autocomplete
/pi fork prompt:<optional>                              create a fresh thread/session from the current thread cwd
/pi compose                                             open a multi-line prompt modal
/pi status                                              show the current thread mapping
/pi debug                                               show full ephemeral bridge/session debug details
/pi reload                                              reload Pi resources for the current thread session
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
!pi esc                              escape/stop the active Pi run in the current thread
!pi abort                            abort the active Pi run in the current thread
!pi help                             show help
```

In a registered thread, normal messages are sent to the Pi session. If a turn is already running, new messages are queued as steering messages for the active turn; prefix a message with `followup:` or `after:` to queue it as a follow-up after the current turn completes. Attachments on normal thread messages, workspace messages, and context-menu-selected messages are downloaded into the bridge data directory and appended to the prompt as local file paths when they pass the configured size/type allowlist. Supported images are also attached inline for model vision when small enough; audio/video/PDF uploads are saved and surfaced with guidance for Pi to inspect/extract/process them with local tools when needed.

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
- `/tree` is a future command that should navigate the current session in-place.
