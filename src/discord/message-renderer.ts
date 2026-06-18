import type { Message } from "discord.js";
import type { RichPayload } from "./payloads.js";

export interface DiscordEditableMessage {
  id?: string;
  edit(payload: RichPayload): Promise<unknown>;
  delete?(): Promise<unknown>;
}

export interface DiscordMessageRendererOptions {
  onError?: (error: Error) => void;
}

export interface DiscordMessageRendererPort {
  render(payload: RichPayload): Promise<void>;
  deactivate(payload?: RichPayload): Promise<void>;
  destroy(): Promise<void>;
  flush(): Promise<void>;
}

export class DiscordMessageRenderer implements DiscordMessageRendererPort {
  private queue: Promise<void> = Promise.resolve();
  private lastPayloadHash: string | undefined;
  private active = true;
  private destroyed = false;

  constructor(
    private readonly message: DiscordEditableMessage | Message,
    private readonly options: DiscordMessageRendererOptions = {},
  ) {}

  render(payload: RichPayload): Promise<void> {
    if (!this.active || this.destroyed) return this.queue;
    return this.enqueueEdit(payload, { dedupe: true });
  }

  async deactivate(payload?: RichPayload): Promise<void> {
    if (this.destroyed) return this.queue;
    if (payload) {
      await this.enqueueEdit(payload, { dedupe: false });
    }
    this.active = false;
    await this.queue;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return this.queue;
    this.destroyed = true;
    this.active = false;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (typeof this.message.delete === "function") {
          await this.message.delete();
        }
      })
      .catch((error) => this.reportError(error));
    await this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private enqueueEdit(payload: RichPayload, options: { dedupe: boolean }): Promise<void> {
    const hash = hashPayload(payload);
    if (options.dedupe && hash === this.lastPayloadHash) return this.queue;
    this.lastPayloadHash = hash;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (this.destroyed) return;
        await this.message.edit(payload);
      })
      .catch((error) => this.reportError(error));
    return this.queue;
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
  }
}

export function hashPayload(payload: RichPayload): string {
  return stableStringify(toPlainPayload(payload));
}

function toPlainPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const maybeSerializable = value as { toJSON?: () => unknown };
  if (typeof maybeSerializable.toJSON === "function") {
    try {
      return toPlainPayload(maybeSerializable.toJSON());
    } catch {
      // Fall back to object traversal below.
    }
  }
  if (Array.isArray(value)) return value.map(toPlainPayload);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "undefined") continue;
    output[key] = toPlainPayload(entry);
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry !== "undefined")
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
