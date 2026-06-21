<!-- pi-notes-agent:start -->
## pi-notes Brain workflow

This repo uses pi-notes for durable project memory and local review surfaces.

- Read `BRAIN.md` and relevant `.brain/**/*.svx` notes before substantial planning, architecture claims, or code edits.
- Treat `.brain/` as source. Do not leave important decisions only in chat.
- Author Brain pages as MDSvX `.svx` files.
- Keep `.svx` readable: prose, links, short summaries, and component invocations.
- Put large structured data in `.brain/data/**`.
- Put reusable local renderers in `.brain/components/**/*.svelte`.
- Use the `brain-component-composition` skill before substantial `.brain`, component, or data-backed review work.
- Browser feedback should be handled as a Review Batch with a receipt, not as vague chat commentary.
- Commit regularly at logical inflection points. When live daemon work or overlapping dirty files make a normal commit risky, create a checkpoint patch first, then commit the smallest coherent slice as soon as it validates.
- Run `pi-notes brain check` after Brain changes and the normal project checks after code changes.
<!-- pi-notes-agent:end -->

## Project orientation for agents

This repo is a local Discord ↔ Pi bridge. Treat it like an operator daemon, not a toy script.

Start here before non-trivial work:

1. `BRAIN.md`
2. `.brain/resources/pi-discord-threads-architecture-review.svx`
3. `.brain/projects/redis-run-control-plane.svx`
4. `.brain/projects/release-snapshot-deploy-rollback.svx`
5. `.brain/projects/run-control-lua-command-builders.svx`
6. `.brain/projects/project-structure-cleanup.svx`

## Source map

- `src/index.ts` — CLI entrypoint and command dispatch.
- `src/config.ts` — config defaults and CLI parsing. Keep parser errors strict.
- `src/discord-bot.ts` — large Discord gateway/orchestration surface. Do not add more policy here if a narrower module exists.
- `src/discord/**` — extracted Discord rendering, HUD, final-answer, thread-title, and run-surface seams.
- `src/pi-runtime.ts` + `src/engine/**` — Pi runtime ownership and Effect service/layer seams.
- `src/run-control/**` — Redis run-control source of truth: Lua scripts, store, worker/lane/leased-run state machines, doctor, reconcile, and deploy safety inspection.
- `src/release-snapshots.ts` — local release bundle/ledger/config snapshot behavior.
- `src/release-transition.ts` — fakeable release deploy transition state machine.
- `src/release-deploy.ts` — public deploy/rollback command wiring, real adapters, and output formatting.
- `src/launch-agent.ts` — macOS user LaunchAgent plist/status/start/stop guardrails and guard-first plist seams.
- `src/registry.ts`, `src/work-graph.ts`, `src/thread-run-state.ts` — Discord ↔ Pi session projection.
- `src/link-ingest*.ts`, `src/daily-post.ts` — explicit URL capture/status bridge and daily post wiring.

## Current work tracks

- Architecture: typed Lua command builders next, starting with `recordRetryLaterScript`. Keep it behavior-preserving and boring.
- Deploy: `release deploy` and `release rollback` are wired through fakeable transition/rollback adapters. Next is live-ops hardening after the first real cutover receipt. Call the target **zero lost work + fast rollback**, not zero downtime.
- Cleanup: improve orientation and prune only evidence-backed dead code. No directory shuffle without tests and a clear PRD slice.

## Hard safety rules

- Preserve Redis run-control invariants: one active run per logical thread, at-least-once execution, idempotent finalization, ownership checks before side effects.
- Do not mutate LaunchAgent state, call `launchctl`, flip `releases/current`, restore config, or restart the live daemon except through explicit release deploy/rollback/operator commands requested by the user.
- Do not print secrets, Discord IDs, private config contents, or leased secret values in docs, logs, manifests, or summaries.
- Keep one writer in the active worktree. Use subagents for context/review, not parallel edits.
- Do not broaden a cleanup into a framework rewrite. Remove narrow dead code only when source search + typecheck prove it.
- If touching Effect code, use the Effect skills/source workflow first.

## Validation map

Run the smallest useful check, then report it:

- Brain/docs only: `npm run brain:check`
- Any TypeScript source edit: `npm run typecheck`
- Release snapshot/activate/canary/rollback helper parsing: `npm run test:release-snapshot`
- Release deploy/rollback wiring, transition, and safety classifier seams: `npm run test:release-transition`
- Redis Lua/store/worker: `npm run test:run-control-lua-scripts`, `npm run test:run-control-store`, `npm run test:run-control-worker`
- Pi runtime/layers: `npm run test:pi-runtime`, `npm run test:pi-session-service`, `npm run test:engine-layer`
- Discord final output/HUD: `npm run test:final-answer-outbox`, `npm run test:progress-hud`

## Commit discipline

Use ShitRat for agent-authored GitHub commits when available. Commit only coherent slices. Never use broad `git add .`; include the exact files intended.
