import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
