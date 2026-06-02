#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AppConfig, expandPath, loadConfig, parseCliArgs, writeDefaultConfig } from "./config.js";
import { runBot } from "./discord-bot.js";
import { PiRuntimeManager } from "./pi-runtime.js";
import { Registry } from "./registry.js";
import { SecretResolver } from "./secrets.js";

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

  const runtimeManager = new PiRuntimeManager(config, registry);
  await runBot({
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
  console.log(`node: ${process.version}`);
  console.log("secrets: will use local `secrets lease` unless env vars are set");
  console.log("discord: requires Message Content Intent and permission to create/send in threads");
}

function printHelp(): void {
  console.log(`pi-discord-threads

Commands:
  start [--config path]        Start the Discord ↔ Pi bridge daemon
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
