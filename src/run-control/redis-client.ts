import { hostname } from "node:os";
import { createClient } from "redis";
import type { AppConfig } from "../config.js";

export interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
  close(): Promise<unknown>;
  destroy?(): Promise<unknown> | unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
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

  const client = createClient({ url });
  client.on("error", (error) => {
    console.warn(`Redis run-control client error: ${error.message}`);
  });
  await client.connect();
  return client as unknown as RedisCommandClient;
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

  const client = await createRunControlRedisClient(config);
  try {
    const pong = await client.sendCommand(["PING"]);
    return { ok: pong === "PONG", message: `runControl Redis: ${String(pong)}` };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function getRunControlWorkerId(config: AppConfig): string {
  return config.runControl.workerId?.trim() || `${hostname()}-${process.pid}`;
}
