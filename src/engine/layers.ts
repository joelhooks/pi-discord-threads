import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { Registry } from "../registry.js";
import { Effect, Layer, Option, Scope } from "effect";
import {
  RegistryLinkIngestNotFound,
  RegistryLoadFailed,
  RegistryThreadNotFound,
  RegistryWriteFailed,
  type DiscordMessageId,
  type MentionId,
  type ThreadId,
} from "./domain.js";
import { AppConfigService, RegistryService, type RegistryServiceShape } from "./services.js";

export const AppConfigLive = (config: AppConfig): Layer.Layer<AppConfigService> =>
  Layer.succeed(AppConfigService, config);

export const JsonRegistryLive: Layer.Layer<RegistryService, RegistryLoadFailed, AppConfigService> = Layer.effect(
  RegistryService,
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const registry = new Registry(join(config.dataDir, "registry.json"));

    yield* Effect.tryPromise({
      try: () => registry.load(),
      catch: (cause) => new RegistryLoadFailed({ cause }),
    });

    const saveOnClose = Effect.ignore(Effect.tryPromise({
      try: () => registry.save(),
      catch: (cause) => new RegistryWriteFailed({ operation: "saveOnClose", cause }),
    }));

    const scope = yield* Effect.scope;
    yield* Scope.addFinalizer(scope, saveOnClose);

    const write = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RegistryWriteFailed> =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new RegistryWriteFailed({ operation, cause }),
      });

    const service: RegistryServiceShape = {
      getThread: Effect.fn("RegistryService.getThread")((threadId: ThreadId) =>
        Effect.sync(() => Option.fromNullishOr(registry.getThread(threadId))),
      ),

      listThreads: Effect.fn("RegistryService.listThreads")(() =>
        Effect.sync(() => registry.listThreads()),
      ),

      upsertThread: Effect.fn("RegistryService.upsertThread")((input) =>
        write("upsertThread", () => registry.upsertThread(input)),
      ),

      patchThread: Effect.fn("RegistryService.patchThread")(function* (threadId, patch) {
        if (!registry.getThread(threadId)) {
          return yield* new RegistryThreadNotFound({ threadId });
        }
        return yield* write("patchThread", () => registry.patchThread(threadId, patch));
      }),

      markRunningThreadsInterrupted: Effect.fn("RegistryService.markRunningThreadsInterrupted")(() =>
        write("markRunningThreadsInterrupted", () => registry.markRunningThreadsInterrupted()),
      ),

      recordMessage: Effect.fn("RegistryService.recordMessage")((record) =>
        write("recordMessage", () => registry.recordMessage(record)),
      ),

      recordMessageEntry: Effect.fn("RegistryService.recordMessageEntry")((discordMessageId: DiscordMessageId, entryId) =>
        write("recordMessageEntry", () => registry.recordMessageEntry(discordMessageId, entryId)),
      ),

      getMessage: Effect.fn("RegistryService.getMessage")((discordMessageId: DiscordMessageId) =>
        Effect.sync(() => Option.fromNullishOr(registry.getMessage(discordMessageId))),
      ),

      upsertLinkIngest: Effect.fn("RegistryService.upsertLinkIngest")((record) =>
        write("upsertLinkIngest", () => registry.upsertLinkIngest(record)),
      ),

      getLinkIngest: Effect.fn("RegistryService.getLinkIngest")((mentionId: MentionId) =>
        Effect.sync(() => Option.fromNullishOr(registry.getLinkIngest(mentionId))),
      ),

      listLinkIngests: Effect.fn("RegistryService.listLinkIngests")(() =>
        Effect.sync(() => registry.listLinkIngests()),
      ),

      getLinkIngestStatusUpdate: Effect.fn("RegistryService.getLinkIngestStatusUpdate")((mentionId: MentionId, statusKey) =>
        Effect.sync(() => Option.fromNullishOr(registry.getLinkIngestStatusUpdate(mentionId, statusKey))),
      ),

      recordLinkIngestStatusUpdate: Effect.fn("RegistryService.recordLinkIngestStatusUpdate")(function* (update) {
        if (!registry.getLinkIngest(update.mentionId)) {
          return yield* new RegistryLinkIngestNotFound({ mentionId: update.mentionId as MentionId });
        }
        return yield* write("recordLinkIngestStatusUpdate", () => registry.recordLinkIngestStatusUpdate(update));
      }),
    };

    return service;
  }),
);

export const RegistryEngineLive = (config: AppConfig): Layer.Layer<RegistryService, RegistryLoadFailed> =>
  JsonRegistryLive.pipe(Layer.provide(AppConfigLive(config)));
