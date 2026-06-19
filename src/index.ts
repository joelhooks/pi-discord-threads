#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AppConfig, type CliOptions, expandPath, loadConfig, parseCliArgs, writeDefaultConfig } from "./config.js";
import { runAppLifecycle } from "./app-runtime.js";
import { postDailyMessage } from "./daily-post.js";
import { SecretResolver } from "./secrets.js";
import { PI_SESSION_ENGINE_NAME, REGISTRY_ENGINE_NAME, RUN_QUEUE_ENGINE_NAME, createRegistryRuntimeClient, createRunQueueRuntimeClient } from "./engine/runtime.js";
import { buildRunControlDoctorReport, formatRunControlDoctorReport, loadRunControlDoctorRegistry } from "./run-control/doctor.js";
import { checkRunControlRedisHealth, getRunControlWorkerId } from "./run-control/redis-client.js";
import { formatReconcileReport, reconcileRunControl } from "./run-control/reconcile.js";
import { installLaunchAgent, printLaunchAgentStatus, uninstallLaunchAgent } from "./launch-agent.js";
import { createReleaseSnapshot, formatReleaseSnapshotList, formatReleaseSnapshotResult, listReleaseSnapshots } from "./release-snapshots.js";

installProcessGuards();

function installProcessGuards(): void {
  const isBenignLateAgentListener = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Agent listener invoked outside active run");
  };

  process.on("uncaughtException", (error) => {
    if (isBenignLateAgentListener(error)) {
      console.warn("Ignored late Pi agent listener event after active run ended.");
      return;
    }
    console.error(error);
    process.exitCode = 1;
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (isBenignLateAgentListener(reason)) {
      console.warn("Ignored late Pi agent listener rejection after active run ended.");
      return;
    }
    console.error(reason);
    process.exitCode = 1;
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.command === "help") {
    printHelp();
    return;
  }

  if (cli.command === "init-config") {
    const configPath = expandPath(cli.configPath);
    if (existsSync(configPath)) {
      console.log(`Config already exists: ${configPath}`);
      return;
    }
    await writeDefaultConfig(configPath);
    console.log(`Wrote ${configPath}`);
    return;
  }

  if (cli.command === "release" && (cli.releaseCommand === "deploy" || cli.releaseCommand === "rollback")) {
    throw new Error(`release ${cli.releaseCommand} is not implemented yet. First slice only supports release snapshot and release list.`);
  }

  const config = await loadConfig(cli.configPath);

  if (cli.command === "doctor") {
    await doctor(cli.configPath, config);
    return;
  }

  if (cli.command === "reconcile") {
    await reconcileCommand(config, cli.reconcileApply);
    return;
  }

  if (cli.command === "daily-post") {
    await dailyPostCommand(config, cli.dailyPostRequestPath);
    return;
  }

  if (cli.command === "install-launch-agent") {
    await installLaunchAgent({
      config,
      configPath: cli.configPath,
      roles: cli.roles ?? config.runControl.roles,
      start: cli.launchAgentStart,
      restart: cli.launchAgentRestart,
      force: cli.force,
    });
    return;
  }

  if (cli.command === "uninstall-launch-agent") {
    await uninstallLaunchAgent(config);
    return;
  }

  if (cli.command === "launch-agent-status") {
    await printLaunchAgentStatus(config);
    return;
  }

  if (cli.command === "release") {
    await releaseCommand(cli, config);
    return;
  }

  const roles = config.runControl.enabled ? (cli.roles ?? config.runControl.roles) : ["bot" as const];
  await runAppLifecycle({ config, roles });
}

async function doctor(configPath: string, config: AppConfig): Promise<void> {
  console.log(`config: ${expandPath(configPath)}${existsSync(expandPath(configPath)) ? "" : " (using defaults; file missing)"}`);
  console.log(`dataDir: ${config.dataDir}`);
  console.log(`registry: ${join(config.dataDir, "registry.json")}`);
  console.log(`registryEngine: ${REGISTRY_ENGINE_NAME}`);
  console.log(`piSessionEngine: ${PI_SESSION_ENGINE_NAME}`);
  console.log(`workspaces: ${Object.keys(config.pi.workspaces).length}`);
  console.log(`attachments: ${config.attachments.enabled ? "enabled" : "disabled"}, maxBytes=${config.attachments.maxBytes}`);
  console.log(`linkIngest: ${config.linkIngest.enabled ? "enabled" : "disabled"}, url=${config.linkIngest.inngestUrl}, eventKeyEnv=${config.linkIngest.eventKeyEnv ?? "(none)"}, eventKeySecret=${config.linkIngest.eventKeySecretName ?? "(none)"}, signingKeyEnv=${config.linkIngest.signingKeyEnv ?? "(none)"}, signingKeySecret=${config.linkIngest.signingKeySecretName ?? "(none)"}, statusBridge=${config.linkIngest.statusBridgeEnabled ? "enabled" : "disabled"}`);
  console.log(`runControl: ${config.runControl.enabled ? "enabled" : "disabled"}, roles=${config.runControl.roles.join(",")}, keyPrefix=${config.runControl.keyPrefix}, maxConcurrentRuns=${config.runControl.maxConcurrentRuns}`);
  console.log(`runQueueEngine: ${config.runControl.enabled ? RUN_QUEUE_ENGINE_NAME : "disabled"}`);
  console.log(`runControlWorkerId: ${getRunControlWorkerId(config)}`);
  const redisHealth = await checkRunControlRedisHealth(config);
  console.log(redisHealth.message);
  if (config.runControl.enabled) {
    const registry = await loadRunControlDoctorRegistry(config);
    const store = createRunQueueRuntimeClient(config);
    try {
      await store.warmup();
      console.log(formatRunControlDoctorReport(await buildRunControlDoctorReport({ store, registry, config })));
    } finally {
      await store.close();
    }
  }
  console.log(`node: ${process.version}`);
  console.log("secrets: will use local `secrets lease` unless env vars are set");
  console.log("discord: requires Message Content Intent and permission to create/send in threads");
}

async function reconcileCommand(config: AppConfig, apply: boolean): Promise<void> {
  if (!config.runControl.enabled) {
    console.log("runControl is disabled; no Redis reconciliation to perform.");
    return;
  }
  const registry = createRegistryRuntimeClient(config);
  const store = createRunQueueRuntimeClient(config);
  try {
    await registry.warmup();
    console.log(`Effect RegistryRuntime warmed: engine=${registry.engine}`);
    await store.warmup();
    console.log(`Effect RunQueueRuntime warmed: engine=${store.engine}, workerId=${getRunControlWorkerId(config)}, keyPrefix=${config.runControl.keyPrefix}`);
    const report = await reconcileRunControl({ store, registry, config, apply });
    console.log(formatReconcileReport(report));
  } finally {
    await store.close();
    await registry.close();
  }
}

async function dailyPostCommand(
  config: AppConfig,
  requestPath: string | undefined
): Promise<void> {
  if (!requestPath) throw new Error("daily-post requires --request <path>");
  const secrets = new SecretResolver();
  const token = await secrets.resolveRequired({
    envName: config.discord.tokenEnv,
    secretName: config.discord.tokenSecretName,
    ttl: config.discord.tokenLeaseTtl,
    label: "Discord bot token",
  });
  const result = await postDailyMessage({
    config,
    token,
    requestPath,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function releaseCommand(cli: CliOptions, config: AppConfig): Promise<void> {
  if (cli.releaseCommand === "snapshot") {
    const result = await createReleaseSnapshot({
      config,
      configPath: expandPath(cli.configPath),
      allowDirty: cli.releaseAllowDirty,
    });
    console.log(formatReleaseSnapshotResult(result));
    return;
  }

  if (cli.releaseCommand === "list") {
    console.log(formatReleaseSnapshotList(await listReleaseSnapshots({ config }), config));
    return;
  }

  throw new Error(`release ${cli.releaseCommand ?? "(missing)"} is not implemented yet. First slice only supports release snapshot and release list.`);
}

function printHelp(): void {
  console.log(`pi-discord-threads

Commands:
  start [--config path] [--roles bot,worker,reconcile]
                              Start the Discord ↔ Pi bridge daemon
  install-launch-agent [--config path] [--roles bot,worker,reconcile] [--start|--restart] [--force]
                              Write the macOS user LaunchAgent; optionally bootstrap it in gui/$UID
  launch-agent-status [--config path]
                              Show LaunchAgent label/plist/load state and matching daemon PIDs
  uninstall-launch-agent [--config path]
                              Boot out and remove the LaunchAgent plist
  reconcile [--config path] [--dry-run|--apply]
                              Inspect/apply Redis run-control reconciliation
  daily-post [--config path] --request path
                              Post a daily Brain Dump receipt and register the date thread as a resumable Pi session
  release snapshot [--config path] [--allow-dirty]
                              Snapshot built dist/package/config under config.dataDir/releases
  release list [--config path] List release snapshots without printing secrets
  init-config [--config path]  Write a default JSON config
  doctor [--config path]       Print non-secret runtime diagnostics

Defaults:
  config: ~/.config/pi-discord-threads/config.json
  token secret: discord_bot_token
  allowed-user secret: discord_allowed_user_id

MVP usage in Discord:
  !pi <prompt>   Create a thread + durable Pi session from a channel message
  !pi status     Show current thread mapping
  !pi abort      Abort active run in current thread
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
