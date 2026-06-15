#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AppConfig, expandPath, loadConfig, parseCliArgs, writeDefaultConfig } from "./config.js";
import { runBot } from "./discord-bot.js";
import { postDailyMessage } from "./daily-post.js";
import { PiRuntimeManager } from "./pi-runtime.js";
import { Registry } from "./registry.js";
import { SecretResolver } from "./secrets.js";
import { checkRunControlRedisHealth, createRunControlRedisClient, getRunControlWorkerId } from "./run-control/redis-client.js";
import { formatReconcileReport, reconcileRunControl, startRunControlReconcileLoop } from "./run-control/reconcile.js";
import { RunControlStore } from "./run-control/store.js";
import { installLaunchAgent, printLaunchAgentStatus, uninstallLaunchAgent } from "./launch-agent.js";

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

  const roles = config.runControl.enabled ? (cli.roles ?? config.runControl.roles) : ["bot" as const];
  const redisClient = config.runControl.enabled ? await createRunControlRedisClient(config) : undefined;
  const runControlStore = redisClient ? new RunControlStore(redisClient, config) : undefined;

  const secrets = new SecretResolver();
  const token = await secrets.resolveRequired({
    envName: config.discord.tokenEnv,
    secretName: config.discord.tokenSecretName,
    ttl: config.discord.tokenLeaseTtl,
    label: "Discord bot token",
  });

  const allowedFromSecret = await secrets.resolveOptional({
    envName: config.discord.allowedUserIdEnv,
    secretName: config.discord.allowedUserIdSecretName,
    ttl: config.discord.tokenLeaseTtl,
  });
  const allowedUserIds = mergeIds(config.discord.allowedUserIds, allowedFromSecret);

  const registry = new Registry(join(config.dataDir, "registry.json"));
  await registry.load();
  if (!config.runControl.enabled) {
    const interruptedCount = await registry.markRunningThreadsInterrupted();
    if (interruptedCount > 0) {
      console.log(`marked ${interruptedCount} stale running Pi session(s) as interrupted`);
    }
  }

  const stopReconcileLoop = config.runControl.enabled && runControlStore && roles.includes("reconcile")
    ? startRunControlReconcileLoop({ store: runControlStore, registry, config, apply: true })
    : undefined;

  if (config.runControl.enabled && runControlStore && !roles.includes("bot") && !roles.includes("worker") && roles.includes("reconcile")) {
    console.log("run-control reconcile role running; press Ctrl-C to stop");
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        stopReconcileLoop?.();
        await runControlStore.close();
        resolve();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
    return;
  }

  const runtimeManager = new PiRuntimeManager(config, registry);
  await runBot({
    runControlStore,
    runControlRoles: roles,
    runControlWorkerId: getRunControlWorkerId(config),
    runControlStopReconcileLoop: stopReconcileLoop,
    config,
    token,
    allowedUserIds,
    registry,
    runtimeManager,
  });
}

function mergeIds(configured: string[], secretValue: string | undefined): string[] {
  const ids = new Set(configured.map((id) => id.trim()).filter(Boolean));
  if (secretValue) {
    for (const id of secretValue.split(/[\s,]+/)) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return [...ids];
}

async function doctor(configPath: string, config: AppConfig): Promise<void> {
  console.log(`config: ${expandPath(configPath)}${existsSync(expandPath(configPath)) ? "" : " (using defaults; file missing)"}`);
  console.log(`dataDir: ${config.dataDir}`);
  console.log(`registry: ${join(config.dataDir, "registry.json")}`);
  console.log(`workspaces: ${Object.keys(config.pi.workspaces).length}`);
  console.log(`attachments: ${config.attachments.enabled ? "enabled" : "disabled"}, maxBytes=${config.attachments.maxBytes}`);
  console.log(`runControl: ${config.runControl.enabled ? "enabled" : "disabled"}, roles=${config.runControl.roles.join(",")}, keyPrefix=${config.runControl.keyPrefix}`);
  const redisHealth = await checkRunControlRedisHealth(config);
  console.log(redisHealth.message);
  console.log(`node: ${process.version}`);
  console.log("secrets: will use local `secrets lease` unless env vars are set");
  console.log("discord: requires Message Content Intent and permission to create/send in threads");
}

async function reconcileCommand(config: AppConfig, apply: boolean): Promise<void> {
  if (!config.runControl.enabled) {
    console.log("runControl is disabled; no Redis reconciliation to perform.");
    return;
  }
  const registry = new Registry(join(config.dataDir, "registry.json"));
  await registry.load();
  const redisClient = await createRunControlRedisClient(config);
  const store = new RunControlStore(redisClient, config);
  try {
    const report = await reconcileRunControl({ store, registry, config, apply });
    console.log(formatReconcileReport(report));
  } finally {
    await store.close();
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
                              Post a deterministic daily Brain Dump receipt into a Discord date thread
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
