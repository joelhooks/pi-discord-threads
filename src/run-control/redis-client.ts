import { hostname } from "node:os";
import { createClient } from "redis";
import type { AppConfig } from "../config.js";

export interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
  close(): Promise<unknown>;
  destroy?(): Promise<unknown> | unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export class RedisCommandTimeoutError extends Error {
  constructor(commandName: string, timeoutMs: number) {
    super(`Redis command ${commandName} timed out after ${timeoutMs}ms`);
    this.name = "RedisCommandTimeoutError";
  }
}

export function resolveRunControlRedisUrl(config: AppConfig): string | undefined {
  const explicit = config.runControl.redisUrl?.trim();
  if (explicit) return explicit;
  const envName = config.runControl.redisUrlEnv?.trim() || "REDIS_URL";
  return process.env[envName]?.trim() || undefined;
}

export async function createRunControlRedisClient(config: AppConfig): Promise<RedisCommandClient> {
  const url = resolveRunControlRedisUrl(config);
  const envName = config.runControl.redisUrlEnv?.trim() || "REDIS_URL";
  if (!url) {
    throw new Error(`runControl is enabled but no Redis URL was configured. Set runControl.redisUrl or ${envName}.`);
  }

  const timeoutMs = config.runControl.commandTimeoutMs;
  const client = createClient({
    url,
    socket: {
      connectTimeout: timeoutMs,
    },
  });
  client.on("error", (error) => {
    console.warn(`Redis run-control client error: ${error.message}`);
  });
  await withRedisTimeout(client.connect(), "CONNECT", timeoutMs, () => client.destroy());
  return {
    sendCommand(command: string[]) {
      return withRedisTimeout(
        client.sendCommand(command),
        command[0]?.toUpperCase() || "UNKNOWN",
        timeoutMs,
        () => client.destroy(),
      );
    },
    close() {
      return withRedisTimeout(client.close(), "CLOSE", timeoutMs, () => client.destroy());
    },
    destroy() {
      return client.destroy();
    },
    on(event: "error", listener: (error: Error) => void) {
      return client.on(event, listener);
    },
  };
}

export async function checkRunControlRedisHealth(config: AppConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.runControl.enabled) {
    return { ok: true, message: "runControl: disabled; Redis not checked" };
  }

  const url = resolveRunControlRedisUrl(config);
  if (!url) {
    const envName = config.runControl.redisUrlEnv?.trim() || "REDIS_URL";
    return { ok: false, message: `runControl: enabled but ${envName} / runControl.redisUrl is missing` };
  }

  let client: RedisCommandClient | undefined;
  try {
    client = await createRunControlRedisClient(config);
    const pong = await client.sendCommand(["PING"]);
    return { ok: pong === "PONG", message: `runControl Redis: ${String(pong)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `runControl Redis: ${message}` };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function withRedisTimeout<T>(promise: Promise<T>, commandName: string, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // ignore cleanup failures; the timeout error is the useful signal
      }
      reject(new RedisCommandTimeoutError(commandName, timeoutMs));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => resolve(value),
      (error) => reject(error),
    ).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

export function getRunControlWorkerId(config: AppConfig): string {
  return config.runControl.workerId?.trim() || `${hostname()}-${process.pid}`;
}
