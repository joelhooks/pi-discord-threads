import test from "node:test";
import assert from "node:assert/strict";
import { createActor, waitFor } from "xstate";
import { appLifecycleMachine } from "../dist/app-lifecycle-machine.js";

function config({ enabled = true } = {}) {
  return {
    runControl: {
      enabled,
      roles: enabled ? ["bot", "worker", "reconcile"] : ["bot"],
      keyPrefix: "test:lifecycle",
    },
    discord: {
      allowedUserIds: ["configured-user"],
    },
  };
}

function createAdapters(events, options = {}) {
  return {
    createRunControlStore(appConfig) {
      if (!appConfig.runControl.enabled) return undefined;
      events.push("runQueue.create");
      return {
        engine: "effect-managed",
        async warmup() {
          events.push("runQueue.warmup");
        },
        async close() {
          events.push("runQueue.close");
        },
      };
    },
    createRegistry() {
      events.push("registry.create");
      return {
        engine: "effect-managed",
        async warmup() {
          events.push("registry.warmup");
        },
        async close() {
          events.push("registry.close");
        },
        async markRunningThreadsInterrupted() {
          events.push("registry.markInterrupted");
          return options.interruptedCount ?? 0;
        },
      };
    },
    createPiSessionRuntime() {
      events.push("pi.create");
      return {
        engine: "effect-managed",
        async warmup() {
          events.push("pi.warmup");
        },
        async close() {
          events.push("pi.close");
        },
      };
    },
    async resolveDiscordSecrets() {
      events.push("secrets.resolve");
      if (options.failSecrets) throw new Error("secret boom");
      return { token: "discord-token", allowedUserIds: ["configured-user", "secret-user"] };
    },
    startReconcileLoop() {
      events.push("reconcile.start");
      return () => events.push("reconcile.stop");
    },
    startDiscordBot() {
      events.push("discord.start");
      return {
        ready: options.discordReady ?? Promise.resolve(),
        async stop() {
          events.push("discord.stop");
        },
      };
    },
    getWorkerId() {
      return "worker-test";
    },
    log(message) {
      events.push(`log:${message}`);
    },
    warn(message) {
      events.push(`warn:${message}`);
    },
  };
}

async function startLifecycle({ roles, adapters, appConfig = config() }) {
  const actor = createActor(appLifecycleMachine, {
    input: {
      config: appConfig,
      roles,
      adapters,
    },
  });
  actor.start();
  actor.send({ type: "START" });
  return actor;
}

test("AppLifecycleMachine starts the root actor and exposes ready role regions", async () => {
  const events = [];
  const actor = await startLifecycle({
    roles: ["bot", "worker", "reconcile"],
    adapters: createAdapters(events),
  });

  const running = await waitFor(actor, (snapshot) => snapshot.hasTag("running"), { timeout: 1000 });
  assert.deepEqual(running.value, {
    active: {
      running: {
        bot: "ready",
        worker: "ready",
        reconcile: "ready",
      },
    },
  });

  actor.send({ type: "SIGTERM", signal: "test" });
  const stopped = await waitFor(actor, (snapshot) => snapshot.hasTag("stopped"), { timeout: 1000 });
  assert.equal(stopped.context.shutdownReason, "test");
  actor.stop();

  assert.deepEqual(events.filter((event) => [
    "runQueue.warmup",
    "registry.warmup",
    "reconcile.start",
    "secrets.resolve",
    "pi.warmup",
    "discord.start",
    "reconcile.stop",
    "discord.stop",
    "pi.close",
    "runQueue.close",
    "registry.close",
  ].includes(event)), [
    "runQueue.warmup",
    "registry.warmup",
    "reconcile.start",
    "secrets.resolve",
    "pi.warmup",
    "discord.start",
    "reconcile.stop",
    "discord.stop",
    "pi.close",
    "runQueue.close",
    "registry.close",
  ]);
});

test("AppLifecycleMachine supports reconcile-only mode without Discord or Pi runtime", async () => {
  const events = [];
  const actor = await startLifecycle({
    roles: ["reconcile"],
    appConfig: config({ enabled: true }),
    adapters: createAdapters(events),
  });

  const running = await waitFor(actor, (snapshot) => snapshot.hasTag("running"), { timeout: 1000 });
  assert.deepEqual(running.value, {
    active: {
      running: {
        bot: "disabled",
        worker: "disabled",
        reconcile: "ready",
      },
    },
  });
  assert.equal(events.includes("secrets.resolve"), false);
  assert.equal(events.includes("pi.warmup"), false);
  assert.equal(events.includes("discord.start"), false);

  actor.send({ type: "SIGTERM", signal: "test" });
  await waitFor(actor, (snapshot) => snapshot.hasTag("stopped"), { timeout: 1000 });
  actor.stop();

  assert.deepEqual(events.filter((event) => [
    "runQueue.close",
    "registry.close",
    "reconcile.stop",
  ].includes(event)), [
    "reconcile.stop",
    "runQueue.close",
    "registry.close",
  ]);
});

test("AppLifecycleMachine stops warmed resources when Discord startup fails", async () => {
  const events = [];
  const actor = await startLifecycle({
    roles: ["bot", "worker"],
    adapters: createAdapters(events, {
      discordReady: Promise.reject(new Error("discord boom")),
    }),
  });

  const failed = await waitFor(actor, (snapshot) => snapshot.hasTag("failed"), { timeout: 1000 });
  assert.match(failed.context.lastError ?? "", /discord boom/);
  actor.stop();

  assert.deepEqual(events.filter((event) => [
    "discord.stop",
    "pi.close",
    "runQueue.close",
    "registry.close",
  ].includes(event)), [
    "discord.stop",
    "pi.close",
    "runQueue.close",
    "registry.close",
  ]);
});
