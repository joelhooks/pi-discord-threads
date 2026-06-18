import { Data, Schema } from "effect";

export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = Schema.Schema.Type<typeof ThreadId>;

export const DiscordMessageId = Schema.String.pipe(Schema.brand("DiscordMessageId"));
export type DiscordMessageId = Schema.Schema.Type<typeof DiscordMessageId>;

export const MentionId = Schema.String.pipe(Schema.brand("MentionId"));
export type MentionId = Schema.Schema.Type<typeof MentionId>;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const SessionFile = Schema.String.pipe(Schema.brand("SessionFile"));
export type SessionFile = Schema.Schema.Type<typeof SessionFile>;

export class RegistryLoadFailed extends Data.TaggedError("RegistryLoadFailed")<{
  readonly cause: unknown;
}> {}

export class RegistryWriteFailed extends Data.TaggedError("RegistryWriteFailed")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RegistryThreadNotFound extends Data.TaggedError("RegistryThreadNotFound")<{
  readonly threadId: ThreadId;
}> {}

export class RegistryLinkIngestNotFound extends Data.TaggedError("RegistryLinkIngestNotFound")<{
  readonly mentionId: MentionId;
}> {}

export class InvalidExternalPayload extends Schema.TaggedErrorClass<InvalidExternalPayload>()(
  "InvalidExternalPayload",
  {
    source: Schema.Literals(["registry", "redis", "inngest", "discord", "executor"]),
    message: Schema.String,
  },
) {}

export class RunQueueConnectFailed extends Data.TaggedError("RunQueueConnectFailed")<{
  readonly cause: unknown;
}> {}

export class RunQueueOperationFailed extends Data.TaggedError("RunQueueOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RunQueueTimeout extends Data.TaggedError("RunQueueTimeout")<{
  readonly operation: string;
  readonly timeoutMs: number;
  readonly cause: unknown;
}> {}

export type RegistryError =
  | RegistryLoadFailed
  | RegistryWriteFailed
  | RegistryThreadNotFound
  | RegistryLinkIngestNotFound
  | InvalidExternalPayload;

export type RunQueueError = RunQueueConnectFailed | RunQueueOperationFailed | RunQueueTimeout;
