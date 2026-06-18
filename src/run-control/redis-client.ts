import { hostname } from "node:os";
import { createClient } from "redis";
import type { AppConfig } from "../config.js";
import { formatUnknownError } from "../error-format.js";

export interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
  close(): Promise<unknown>;
  destroy?(): Promise<unknown> | unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

type RedisNodeClient = ReturnType<typeof createClient>;

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
  const errorListeners: Array<(error: Error) => void> = [];
  let activeClient: RedisNodeClient | undefined;
  let connectPromise: Promise<RedisNodeClient> | undefined;
  let closed = false;

  const attachListeners = (client: RedisNodeClient) => {
    client.on("error", (error) => {
      console.warn(`Redis run-control client error: ${formatUnknownError(error)}`);
      for (const listener of errorListeners) listener(error);
    });
  };

  const discardClient = (client: RedisNodeClient) => {
    if (activeClient === client) activeClient = undefined;
    try {
      client.destroy();
    } catch {
      // ignore cleanup failures; the original command error is the useful signal
    }
  };

  const openClient = async (): Promise<RedisNodeClient> => {
    if (closed) throw new Error("Redis run-control client is closed");
    if (activeClient) return activeClient;
    if (!connectPromise) {
      const nextClient = createClient({
        url,
        socket: {
          connectTimeout: timeoutMs,
        },
      });
      attachListeners(nextClient);
      connectPromise = withRedisTimeout(
        nextClient.connect().then(() => nextClient),
        "CONNECT",
        timeoutMs,
        () => discardClient(nextClient),
      ).then((connected) => {
        if (closed) {
          discardClient(connected);
          throw new Error("Redis run-control client is closed");
        }
        activeClient = connected;
        return connected;
      }).catch((error) => {
        discardClient(nextClient);
        throw error;
      }).finally(() => {
        connectPromise = undefined;
      });
    }
    return connectPromise;
  };

  await openClient();

  return {
    async sendCommand(command: string[]) {
      const commandName = command[0]?.toUpperCase() || "UNKNOWN";
      const client = await openClient();
      try {
        return await withRedisTimeout(
          client.sendCommand(command),
          commandName,
          timeoutMs,
          () => discardClient(client),
        );
      } catch (error) {
        if (error instanceof RedisCommandTimeoutError || isRedisClientClosedError(error)) {
          discardClient(client);
        }
        throw error;
      }
    },
    async close() {
      closed = true;
      const client = activeClient;
      activeClient = undefined;
      const pendingConnect = connectPromise;
      connectPromise = undefined;
      if (client) {
        return withRedisTimeout(client.close(), "CLOSE", timeoutMs, () => discardClient(client));
      }
      const connected = await pendingConnect?.catch(() => undefined);
      if (connected) {
        return withRedisTimeout(connected.close(), "CLOSE", timeoutMs, () => discardClient(connected));
      }
      return undefined;
    },
    destroy() {
      closed = true;
      const client = activeClient;
      activeClient = undefined;
      connectPromise = undefined;
      if (client) discardClient(client);
    },
    on(event: "error", listener: (error: Error) => void) {
      if (event === "error") errorListeners.push(listener);
      return undefined;
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
    return { ok: false, message: `runControl Redis: ${formatUnknownError(error)}` };
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

function isRedisClientClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name || error.constructor.name;
  const message = error.message.toLowerCase();
  return name.includes("Closed") || message.includes("closed") || message.includes("socket closed");
}

export function getRunControlWorkerId(config: AppConfig): string {
  return config.runControl.workerId?.trim() || `${hostname()}-${process.pid}`;
}
