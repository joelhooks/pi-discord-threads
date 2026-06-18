import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer, Option, Schema } from "effect";
import { defaultConfig } from "../dist/config.js";
import {
  DiscordMessageId,
  RegistryEngineLive,
  RegistryService,
  ThreadId,
  createRegistryRuntimeClient,
} from "../dist/engine/index.js";

const decode = (schema, value) => Effect.runPromise(Schema.decodeUnknownEffect(schema)(value));

const withTempConfig = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-effect-engine-"));
  const config = defaultConfig();
  config.dataDir = dataDir;
  config.runControl.enabled = false;
  return { config, dataDir };
};

test("Effect registry layer persists thread and message records", async () => {
  const { config, dataDir } = await withTempConfig();
  try {
    const threadId = await decode(ThreadId, "thread-effect-1");
    const discordMessageId = await decode(DiscordMessageId, "message-effect-1");

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RegistryService;
        const before = yield* registry.getThread(threadId);
        assert.equal(Option.isNone(before), true);

        const thread = yield* registry.upsertThread({
          threadId,
          cwd: dataDir,
          status: "idle",
          sessionName: "Effect Engine Test",
        });
        assert.equal(thread.threadId, threadId);

        yield* registry.recordMessage({
          discordMessageId,
          threadId,
          direction: "user",
          createdAt: new Date(0).toISOString(),
        });

        const after = yield* registry.getThread(threadId);
        assert.equal(Option.isSome(after), true);

        const message = yield* registry.getMessage(discordMessageId);
        assert.equal(Option.isSome(message), true);
      }).pipe(Effect.provide(RegistryEngineLive(config))),
    );

    const persisted = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
    assert.equal(persisted.threads[threadId].sessionName, "Effect Engine Test");
    assert.equal(persisted.messages[discordMessageId].direction, "user");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Registry runtime client preserves sync reads over Effect-backed writes", async () => {
  const { config, dataDir } = await withTempConfig();
  const registry = createRegistryRuntimeClient(config);
  try {
    await registry.warmup();
    assert.equal(registry.engine, "effect-managed");
    assert.equal(registry.getThread("thread-runtime-1"), undefined);

    await registry.upsertThread({
      threadId: "thread-runtime-1",
      cwd: dataDir,
      status: "idle",
      sessionName: "Registry Runtime Test",
    });
    assert.equal(registry.getThread("thread-runtime-1")?.sessionName, "Registry Runtime Test");

    await registry.recordMessage({
      discordMessageId: "message-runtime-1",
      threadId: "thread-runtime-1",
      direction: "assistant",
      createdAt: new Date(0).toISOString(),
    });
    assert.equal(registry.getMessage("message-runtime-1")?.direction, "assistant");
  } finally {
    await registry.close().catch(() => undefined);
    const persisted = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8"));
    assert.equal(persisted.threads["thread-runtime-1"].sessionName, "Registry Runtime Test");
    assert.equal(persisted.messages["message-runtime-1"].direction, "assistant");
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Registry runtime client loads persisted file before sync reads", async () => {
  const { config, dataDir } = await withTempConfig();
  await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
    version: 1,
    threads: {
      "thread-seeded-1": {
        threadId: "thread-seeded-1",
        kind: "discord-thread",
        cwd: dataDir,
        status: "idle",
        sessionName: "Seeded Registry Runtime Test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    },
    messages: {},
    linkIngests: {},
  }, null, 2)}\n`, "utf8");

  const registry = createRegistryRuntimeClient(config);
  try {
    await registry.warmup();
    assert.equal(registry.getThread("thread-seeded-1")?.sessionName, "Seeded Registry Runtime Test");
  } finally {
    await registry.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RegistryService can be swapped with a fake layer", async () => {
  const threadId = await decode(ThreadId, "thread-fake-1");
  const fakeLayer = Layer.mock(RegistryService, {
    getThread: () => Effect.succeed(Option.some({
      threadId,
      cwd: "/tmp/fake",
      status: "idle",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RegistryService;
      return yield* registry.getThread(threadId);
    }).pipe(Effect.provide(fakeLayer)),
  );

  assert.equal(Option.isSome(result), true);
  assert.equal(result.value.cwd, "/tmp/fake");
});
