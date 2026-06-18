import { createActor, waitFor } from "xstate";
import type { AppConfig, RunControlRole } from "./config.js";
import { SecretResolver } from "./secrets.js";
import { createPiSessionRuntimeClient, createRegistryRuntimeClient, createRunQueueRuntimeClient } from "./engine/runtime.js";
import { getRunControlWorkerId } from "./run-control/redis-client.js";
import { startRunControlReconcileLoop } from "./run-control/reconcile.js";
import { startBot } from "./discord-bot.js";
import { appLifecycleMachine, type AppLifecycleAdapters } from "./app-lifecycle-machine.js";

export interface RunAppLifecycleOptions {
  config: AppConfig;
  roles: RunControlRole[];
  adapters?: AppLifecycleAdapters;
}

export async function runAppLifecycle(options: RunAppLifecycleOptions): Promise<void> {
  const actor = createActor(appLifecycleMachine, {
    input: {
      config: options.config,
      roles: options.roles,
      adapters: options.adapters ?? createDefaultAppLifecycleAdapters(),
    },
  });

  actor.start();
  actor.send({ type: "START" });

  const snapshot = await waitFor(actor, (state) => state.hasTag("stopped") || state.hasTag("failed"));
  actor.stop();

  if (snapshot.hasTag("failed")) {
    throw new Error(snapshot.context.lastError ?? "app lifecycle failed");
  }
}

export function createDefaultAppLifecycleAdapters(): AppLifecycleAdapters {
  return {
    createRunControlStore(config) {
      return config.runControl.enabled ? createRunQueueRuntimeClient(config) : undefined;
    },
    createRegistry(config) {
      return createRegistryRuntimeClient(config);
    },
    createPiSessionRuntime(config, registry) {
      return createPiSessionRuntimeClient(config, registry);
    },
    async resolveDiscordSecrets(config) {
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
      return {
        token,
        allowedUserIds: mergeIds(config.discord.allowedUserIds, allowedFromSecret),
      };
    },
    startReconcileLoop({ store, registry, config }) {
      return startRunControlReconcileLoop({ store, registry, config, apply: true });
    },
    startDiscordBot(options) {
      return startBot(options);
    },
    getWorkerId(config) {
      return getRunControlWorkerId(config);
    },
    log(message) {
      console.log(message);
    },
    warn(message) {
      console.warn(message);
    },
  };
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

