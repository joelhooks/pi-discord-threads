import { hostname } from "node:os";
import { createClient } from "redis";
import type { AppConfig } from "../config.js";
import { formatUnknownError } from "../error-format.js";

export interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
  sendBlockingCommand?(command: string[], isolationKey: string): Promise<unknown>;
  close(): Promise<unknown>;
  destroy?(): Promise<unknown> | unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

type RedisNodeClient = ReturnType<typeof createClient>;

interface ManagedRedisConnection {
  label: string;
  activeClient?: RedisNodeClient;
  connectPromise?: Promise<RedisNodeClient>;
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
  const errorListeners: Array<(error: Error) => void> = [];
  const commandConnection: ManagedRedisConnection = { label: "command" };
  const blockingConnections = new Map<string, ManagedRedisConnection>();
  let closed = false;

  const attachListeners = (client: RedisNodeClient, label: string) => {
    client.on("error", (error) => {
      console.warn(`Redis run-control ${label} client error: ${formatUnknownError(error)}`);
      for (const listener of errorListeners) listener(error);
    });
  };

  const discardClient = (connection: ManagedRedisConnection, client: RedisNodeClient) => {
    if (connection.activeClient === client) connection.activeClient = undefined;
    try {
      client.destroy();
    } catch {
      // ignore cleanup failures; the original command error is the useful signal
    }
  };

  const openConnection = async (connection: ManagedRedisConnection): Promise<RedisNodeClient> => {
    if (closed) throw new Error("Redis run-control client is closed");
    if (connection.activeClient) return connection.activeClient;
    if (!connection.connectPromise) {
      const nextClient = createClient({
        url,
        socket: {
          connectTimeout: timeoutMs,
        },
      });
      attachListeners(nextClient, connection.label);
      connection.connectPromise = withRedisTimeout(
        nextClient.connect().then(() => nextClient),
        "CONNECT",
        timeoutMs,
        () => discardClient(connection, nextClient),
      ).then((connected) => {
        if (closed) {
          discardClient(connection, connected);
          throw new Error("Redis run-control client is closed");
        }
        connection.activeClient = connected;
        return connected;
      }).catch((error) => {
        discardClient(connection, nextClient);
        throw error;
      }).finally(() => {
        connection.connectPromise = undefined;
      });
    }
    return connection.connectPromise;
  };

  const sendOnConnection = async (connection: ManagedRedisConnection, command: string[]): Promise<unknown> => {
    const commandName = command[0]?.toUpperCase() || "UNKNOWN";
    const client = await openConnection(connection);
    try {
      return await withRedisTimeout(
        client.sendCommand(command),
        commandName,
        timeoutMs,
        () => discardClient(connection, client),
      );
    } catch (error) {
      if (error instanceof RedisCommandTimeoutError || isRedisClientClosedError(error)) {
        discardClient(connection, client);
      }
      throw error;
    }
  };

  const closeConnection = async (connection: ManagedRedisConnection): Promise<unknown> => {
    const client = connection.activeClient;
    connection.activeClient = undefined;
    const pendingConnect = connection.connectPromise;
    connection.connectPromise = undefined;
    if (client) {
      return withRedisTimeout(client.close(), "CLOSE", timeoutMs, () => discardClient(connection, client));
    }
    const connected = await pendingConnect?.catch(() => undefined);
    if (connected) {
      return withRedisTimeout(connected.close(), "CLOSE", timeoutMs, () => discardClient(connection, connected));
    }
    return undefined;
  };

  await openConnection(commandConnection);

  return {
    sendCommand(command: string[]) {
      return sendOnConnection(commandConnection, command);
    },
    sendBlockingCommand(command: string[], isolationKey: string) {
      const safeIsolationKey = isolationKey.trim() || "default";
      let connection = blockingConnections.get(safeIsolationKey);
      if (!connection) {
        connection = { label: `blocking:${safeIsolationKey}` };
        blockingConnections.set(safeIsolationKey, connection);
      }
      return sendOnConnection(connection, command);
    },
    async close() {
      closed = true;
      const connections = [commandConnection, ...blockingConnections.values()];
      blockingConnections.clear();
      const results = await Promise.allSettled(connections.map((connection) => closeConnection(connection)));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
      return undefined;
    },
    destroy() {
      closed = true;
      const connections = [commandConnection, ...blockingConnections.values()];
      blockingConnections.clear();
      for (const connection of connections) {
        const client = connection.activeClient;
        connection.activeClient = undefined;
        connection.connectPromise = undefined;
        if (client) discardClient(connection, client);
      }
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
  return name.includes("Closed") || message.includes("closed") || message.includes("socket closed") || message.includes("disconnects client");
}

export function getRunControlWorkerId(config: AppConfig): string {
  return config.runControl.workerId?.trim() || `${hostname()}-${process.pid}`;
}
