# pi-discord-threads

A local Discord bot that lets Joel talk to Pi coding-agent sessions from Discord threads.

ELI5: Discord is the remote control. Pi is the worker. This bridge keeps a thread mapped to a real Pi session file so the conversation can continue later instead of becoming a disposable chat blob.

## What you can do right now

- Start a Pi session from Discord with `!pi <prompt>` or `/pi ask`.
- Keep talking in the created Discord thread to continue the same Pi session.
- Point a thread at a local workspace with `/pi workspace` or `!pi workspace`.
- Stop/escape active runs with `/pi esc`, `/pi abort`, `!pi esc`, or `!pi abort`.
- Attach files; allowed files are saved locally and passed to Pi as paths.
- Capture explicit URLs with `/pi ingest`, `/pi capture`, or `!pi ingest`.
- Run as a macOS user LaunchAgent for long-lived local use.
- Snapshot the current built release with `release snapshot` and list snapshots with `release list`.

## Requirements

- Node.js `>=22.19.0`
- Local Pi configured and usable from this machine
- Local `secrets` daemon with a Discord bot token
- A Discord bot with:
  - Message Content Intent
  - `applications.commands` scope
  - read/send message permissions
  - public thread creation permission

Optional but recommended:

- an allowed-user secret so only Joel can use the bot
- a config file at `~/.config/pi-discord-threads/config.json`

## Fast setup

```bash
npm install
npm run build
npm run start -- init-config
npm run start -- doctor
```

Start in the foreground:

```bash
npm run start -- start --config ~/.config/pi-discord-threads/config.json
```

The default config path is:

```text
~/.config/pi-discord-threads/config.json
```

See `config.example.json` for the full config shape.

## Run it as a macOS daemon

Use the LaunchAgent for normal local operation. Do not use random `nohup` shells unless you enjoy future pain.

The LaunchAgent prefers `config.dataDir/releases/current/dist/index.js` after you activate a release and rewrite the plist with `install-launch-agent`. If no current release exists yet, it falls back to the repo `dist/index.js`.

```bash
npm run build
node dist/index.js install-launch-agent --config ~/.config/pi-discord-threads/config.json
node dist/index.js install-launch-agent --config ~/.config/pi-discord-threads/config.json --start
node dist/index.js launch-agent-status --config ~/.config/pi-discord-threads/config.json
```

Restart intentionally from a normal terminal:

```bash
node dist/index.js install-launch-agent --config ~/.config/pi-discord-threads/config.json --restart
```

Remove it:

```bash
node dist/index.js uninstall-launch-agent --config ~/.config/pi-discord-threads/config.json
```

Safety notes:

- The start/restart path refuses to run from inside the active bridge process tree. That prevents the bot from killing the Discord turn that asked for the restart. Good.
- It also refuses to start when another matching daemon is already running unless you pass `--force`. Duplicate Discord bot connections are fucky.

## Discord usage

Slash commands:

```text
/pi ask prompt:<prompt> cwd:<optional>
/pi compose
/pi workspace name:<optional> prompt:<optional>
/pi workspaces
/pi sessions
/pi resume session:<session> prompt:<optional>
/pi fork prompt:<optional>
/pi ingest url:<url> note:<optional>
/pi capture url:<url> note:<optional>
/pi skill name:<skill> args:<optional> cwd:<optional>
/pi status
/pi debug
/pi reload
/pi compact instructions:<optional>
/pi esc
/pi abort
/pi help
```

Message context menu:

```text
Apps → Ask Pi about message
```

Prefix fallback:

```text
!pi <prompt>
!pi --cwd @Code/project <prompt>
!pi workspace <workspace> [prompt]
!pi ingest <url> [note]
!pi status
!pi reload
!pi compact [instructions]
!pi esc
!pi abort
!pi help
```

In a registered Discord thread, normal messages go to the same Pi session. If a run is already active, messages become steering input. Prefix with `followup:` or `after:` to queue work after the current turn.

## Workspaces

Workspace aliases live under `pi.workspaces`:

```json
{
  "pi": {
    "workspaces": {
      "my-project": "~/Code/my-project"
    }
  }
}
```

Use them from Discord:

```text
/pi workspace name:my-project prompt:fix the failing test
!pi workspace my-project fix the failing test
```

`cwd` accepts absolute paths, `~`, and `@` as home-relative shorthand:

```text
/pi ask prompt:check this cwd:@Code/my-project
```

## Context channels

A Discord channel can default to a workspace for new Pi threads. Configure it under `discord.contextChannels`:

```json
{
  "discord": {
    "contextChannels": {
      "DISCORD_CHANNEL_ID": { "workspace": "my-project" }
    }
  }
}
```

Explicit `cwd`, `/pi workspace`, compose-modal workspace, and existing thread registry records still win.

## Attachments

Attachments are controlled by the `attachments` config block.

The bridge downloads allowed files into the local data directory and adds local file paths to the Pi prompt. Small supported images are also attached inline for model vision.

## Link ingest

URL capture is explicit only. The bridge does not silently ingest every URL.

Use:

```text
/pi ingest url:<url> note:<optional>
/pi capture url:<url> note:<optional>
!pi ingest <url> [note]
```

`/pi capture` is the human-facing “save this source” alias. The event key and signing key come from env vars or local secrets, not committed config.

## Redis run control

Redis run control is disabled by default.

When enabled, Redis owns active run coordination across bridge processes:

- one active run per logical Discord thread/workroom
- queued vs running HUD truth
- worker leases and heartbeats
- at-least-once execution
- idempotent final-answer posting
- doctor/reconcile reporting

Run with roles:

```bash
node dist/index.js start --roles bot,worker,reconcile
node dist/index.js reconcile --dry-run
node dist/index.js reconcile --apply
```

Check health:

```bash
node dist/index.js doctor --config ~/.config/pi-discord-threads/config.json
```

If `runControl.enabled` is false, the bridge does not connect to Redis.

## Release snapshots

Release snapshots are local rollback bundles. Activation can now flip the local `releases/current` symlink, but it still does not restart or deploy by itself.

Create one:

```bash
npm run build
node dist/index.js release snapshot --config ~/.config/pi-discord-threads/config.json
```

List snapshots:

```bash
node dist/index.js release list --config ~/.config/pi-discord-threads/config.json
```

Activate one without restarting anything:

```bash
node dist/index.js release activate <release-id-or-sha> --config ~/.config/pi-discord-threads/config.json
```

Run a no-Discord-start, no-`launchctl` canary from an activated/current release:

```bash
node dist/index.js release canary current --config ~/.config/pi-discord-threads/config.json
```

Current behavior:

- copies built `dist/`
- copies `package.json` and `package-lock.json`
- copies the exact private config file for local rollback
- writes safe manifest/ledger metadata
- records `distSha256`
- refuses dirty worktrees unless `--allow-dirty` is explicit
- `release activate` flips `releases/current` atomically and creates a `releases/node_modules` symlink back to the repo install
- LaunchAgent install/status understands the `releases/current` entrypoint
- `release canary` verifies `distSha256` and runs `doctor` from the release artifact without starting Discord or calling `launchctl`; it may create/verify the `releases/node_modules` dependency symlink
- config restore helper exists for future deploy/rollback, but the public `release rollback` restart flow is still planned
- `release deploy` and full `release rollback` are planned, not implemented

Target framing: **zero lost work + fast rollback**, not true zero downtime. The Discord Gateway is still a singleton, so restarts can reconnect.

## Project map

| Area | Files | What lives there |
| --- | --- | --- |
| CLI/config | `src/index.ts`, `src/config.ts` | command parsing, config defaults, dispatch |
| Discord | `src/discord-bot.ts`, `src/discord/**` | slash/prefix commands, thread UX, HUD/final rendering |
| Pi runtime | `src/pi-runtime.ts`, `src/engine/**` | Pi runtime manager, Effect layers/services |
| Redis run control | `src/run-control/**` | leases, Lua scripts, worker state machines, doctor/reconcile, deploy safety inspection |
| Registry/work graph | `src/registry.ts`, `src/work-graph.ts`, `src/thread-run-state.ts` | Discord ↔ Pi session mapping |
| Release/daemon ops | `src/release-snapshots.ts`, `src/release-transition.ts`, `src/launch-agent.ts` | release bundles, fakeable deploy transition state machine, LaunchAgent plist/status/restart guard |
| Link ingest | `src/link-ingest*.ts`, `src/daily-post.ts` | explicit source capture and status bridge |
| Docs/Brain | `README.md`, `AGENTS.md`, `.brain/**/*.svx` | human setup, agent orientation, durable decisions |

## Checks

Docs/Brain only:

```bash
npm run brain:check
```

Any TypeScript edit:

```bash
npm run typecheck
```

Release snapshots and transition seams:

```bash
npm run test:release-snapshot
npm run test:release-transition
```

Run control:

```bash
npm run test:run-control-lua-scripts
npm run test:run-control-store
npm run test:run-control-worker
```

Pi runtime/effect layer:

```bash
npm run test:pi-runtime
npm run test:pi-session-service
npm run test:engine-layer
```

Discord final/HUD:

```bash
npm run test:final-answer-outbox
npm run test:progress-hud
```

## Design invariants

- Pi session JSONL is durable conversation truth.
- Discord is the operator surface.
- Registry maps Discord threads to Pi sessions.
- Redis run control, when enabled, owns in-flight coordination.
- Run control is at-least-once with idempotent finalization, not exactly-once magic.
- XState owns lifecycle state machines.
- Effect owns resource/service/finalizer seams.
- Do not casually mutate LaunchAgent or live Redis state from inside a Discord-carried run.

## Current planning docs

- `.brain/resources/pi-discord-threads-architecture-review.svx`
- `.brain/projects/redis-run-control-plane.svx`
- `.brain/projects/run-control-lua-command-builders.svx`
- `.brain/projects/release-snapshot-deploy-rollback.svx`
- `.brain/projects/project-structure-cleanup.svx`
