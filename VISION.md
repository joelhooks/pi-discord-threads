# pi-discord-threads Vision

## Intent

`pi-discord-threads` is a portable Discord bridge for durable Pi coding-agent sessions.

Its job is to make Discord a usable operator surface for long-running agent work without making Discord the source of truth. Discord owns the visible thread, placeholder, buttons, and final answer. Pi session JSONL owns the conversation. The bridge registry owns the Discord-to-Pi projection. Redis run control, when enabled, owns cross-process coordination only.

## Who It Serves

- Operators who want to run and resume Pi sessions from Discord.
- Agents that need durable session files, stable workspace context, and clear recovery behavior.
- Local automation loops that should post into a thread operators can reply to, not dead log dumps.

## Product Bet

The bridge should feel boring under failure:

- date-coded automation threads can be registered as resumable Pi sessions;
- daemon restarts can recover interrupted threads;
- final answers are posted as fresh Discord messages so notifications work;
- active placeholders keep the thread readable while an agent runs;
- completed turns link into a stable Project Memory Portal instead of bloating Discord with duplicate summaries;
- optional Redis run control can coordinate active runs across process boundaries without replacing Pi JSONL.

## Priorities

1. **Durable session mapping.** Every Discord work thread should map to a clear Pi session file, cwd, workspace, and status.
2. **Correct recovery before clever UX.** On restart, inspect persisted Pi state before re-prompting.
3. **One active run per logical workroom.** New input during an active run becomes steer or follow-up input instead of racing the same session.
4. **Visible but restrained progress.** HUDs should help the operator understand the run without growing into noisy transcripts.
5. **Safe defaults.** Redis run control stays disabled unless configured. Secrets are leased or loaded locally and never printed.
6. **Project Memory Portal dogfood.** Emit stable session/workstream memory data and verified portal links so `joelhooks/pi-notes` can own the durable SvelteKit/MDSvX project-memory surface.

## Non-Goals

- Do not make Discord the canonical conversation store.
- Do not make Redis a required dependency for the default bridge path.
- Do not allow HUD or title sidecar actors to steer, abort, or mutate the main Pi session.
- Do not run duplicate Discord bot processes unless explicitly forced for a controlled operation.
- Do not hide workspace/cwd decisions in prompt memory.
- Do not fork the full Project Memory Portal inside this bridge; `pi-notes` owns the Document Host, `.brain` rendering, and session-history portal infrastructure.

## Merge By Default

Merge small, tested changes that:

- improve registry/session recovery;
- reduce duplicate final messages or stale placeholders;
- make daemon lifecycle safer under LaunchAgent;
- clarify workspace/context-channel resolution;
- harden attachment handling and prompt construction;
- improve doctor/reconcile output without adding customer-visible side effects;
- add narrow session-memory data/link seams that preserve Pi JSONL as conversation truth and `.brain` as curated project memory.

## Needs Owner Sign-Off

Stop for explicit approval before:

- enabling Redis run control by default;
- changing daemon security, auth, data retention, or exposed local ports;
- adding broad new attachment classes or larger default attachment limits;
- changing how sessions are forked, cloned, or mapped across Discord threads;
- making sidecar actors capable of mutating the main Pi run;
- changing Project Memory Portal ownership, tailnet exposure, or session-history retention semantics;
- adding public product promises beyond the local bridge use case.

## Evidence Of Progress

The bridge is working when:

- a Discord thread can be resumed after daemon restart;
- stale placeholders are retired or recovered without duplicate finals;
- daily automation threads remain replyable Pi sessions;
- doctor and reconcile explain what is wrong in one pass;
- run-control disabled mode remains simple and reliable;
- run-control enabled mode proves at-least-once execution with idempotent finalization well enough for live use;
- final HUDs and concise final answers point to a stable Project Memory Portal link when a verified phone-safe URL exists.
