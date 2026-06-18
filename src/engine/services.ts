import type { AppConfig } from "../config.js";
import type {
  LinkIngestRecord,
  LinkIngestStatusUpdateRecord,
  MessageRecord,
  ThreadRecord,
} from "../registry.js";
import { Context, Effect, Option } from "effect";
import type {
  DiscordMessageId,
  MentionId,
  RegistryError,
  RegistryLinkIngestNotFound,
  RegistryThreadNotFound,
  RegistryWriteFailed,
  ThreadId,
} from "./domain.js";

export class AppConfigService extends Context.Service<AppConfigService, AppConfig>()(
  "pi-discord/AppConfigService",
) {}

export interface RegistryServiceShape {
  readonly getThread: (threadId: ThreadId) => Effect.Effect<Option.Option<ThreadRecord>>;
  readonly listThreads: () => Effect.Effect<readonly ThreadRecord[]>;
  readonly upsertThread: (input: Parameters<import("../registry.js").Registry["upsertThread"]>[0]) => Effect.Effect<ThreadRecord, RegistryWriteFailed>;
  readonly patchThread: (
    threadId: ThreadId,
    patch: Partial<Omit<ThreadRecord, "threadId" | "createdAt">>,
  ) => Effect.Effect<ThreadRecord, RegistryThreadNotFound | RegistryWriteFailed>;
  readonly markRunningThreadsInterrupted: () => Effect.Effect<number, RegistryWriteFailed>;
  readonly recordMessage: (record: MessageRecord) => Effect.Effect<void, RegistryWriteFailed>;
  readonly recordMessageEntry: (
    discordMessageId: DiscordMessageId,
    entryId: string | undefined,
  ) => Effect.Effect<void, RegistryWriteFailed>;
  readonly getMessage: (discordMessageId: DiscordMessageId) => Effect.Effect<Option.Option<MessageRecord>>;
  readonly upsertLinkIngest: (record: LinkIngestRecord) => Effect.Effect<void, RegistryWriteFailed>;
  readonly getLinkIngest: (mentionId: MentionId) => Effect.Effect<Option.Option<LinkIngestRecord>>;
  readonly listLinkIngests: () => Effect.Effect<readonly LinkIngestRecord[]>;
  readonly getLinkIngestStatusUpdate: (
    mentionId: MentionId,
    statusKey: string,
  ) => Effect.Effect<Option.Option<LinkIngestStatusUpdateRecord>>;
  readonly recordLinkIngestStatusUpdate: (
    update: LinkIngestStatusUpdateRecord,
  ) => Effect.Effect<void, RegistryLinkIngestNotFound | RegistryWriteFailed>;
}

export class RegistryService extends Context.Service<RegistryService, RegistryServiceShape>()(
  "pi-discord/RegistryService",
) {}

export type RegistryServiceError = RegistryError;
