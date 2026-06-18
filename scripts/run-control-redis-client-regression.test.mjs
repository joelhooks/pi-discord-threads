import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { formatUnknownError } from "../dist/error-format.js";
import { createRunControlRedisClient } from "../dist/run-control/redis-client.js";

test("formatUnknownError surfaces Effect tagged errors with nested causes", () => {
  const error = Object.assign(new Error(""), {
    _tag: "RunQueueOperationFailed",
    operation: "ensureConsumerGroup",
    cause: Object.assign(new Error("The client is closed"), { name: "ClientClosedError" }),
  });

  assert.equal(
    formatUnknownError(error),
    "RunQueueOperationFailed: operation=ensureConsumerGroup: cause=ClientClosedError: The client is closed",
  );
});

test("Redis command timeout reconnects for the next command", async (t) => {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.redisUrl = process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379";
  config.runControl.commandTimeoutMs = 200;

  let client;
  try {
    client = await createRunControlRedisClient(config);
    assert.equal(await client.sendCommand(["PING"]), "PONG");
  } catch (error) {
    t.skip(`Redis unavailable for reconnect regression: ${formatUnknownError(error)}`);
    return;
  }

  const blockingKey = `${config.runControl.keyPrefix}:test:${process.pid}:empty-stream`;
  await assert.rejects(
    () => client.sendCommand(["XREAD", "BLOCK", "1000", "STREAMS", blockingKey, "$"]),
    /Redis command XREAD timed out after 200ms/,
  );

  assert.equal(await client.sendCommand(["PING"]), "PONG");
  await client.close();
});
