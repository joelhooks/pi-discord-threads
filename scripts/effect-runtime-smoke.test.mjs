import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { createRunQueueRuntimeClient } from "../dist/engine/index.js";
import { createRunControlRedisClient } from "../dist/run-control/redis-client.js";

const redisUrl = process.env.PI_DISCORD_THREADS_TEST_REDIS_URL
  ?? process.env.REDIS_URL
  ?? "redis://127.0.0.1:6379";

const timestamp = () => new Date().toISOString();
const valueToString = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");

function smokeConfig() {
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.redisUrl = redisUrl;
  config.runControl.redisUrlEnv = "PI_DISCORD_THREADS_TEST_REDIS_URL";
  config.runControl.keyPrefix = `pi-discord-threads:smoke:${process.pid}:${Date.now()}`;
  config.runControl.commandTimeoutMs = 1_000;
  config.runControl.leaseTtlMs = 5_000;
  config.runControl.heartbeatMs = 1_000;
  config.runControl.staleRunMs = 1_000;
  return config;
}

async function redisAvailable(config) {
  let client;
  try {
    client = await createRunControlRedisClient(config);
    return await client.sendCommand(["PING"]) === "PONG";
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function deletePrefix(config) {
  let client;
  try {
    client = await createRunControlRedisClient(config);
    const pattern = `${config.runControl.keyPrefix}:*`;
    let cursor = "0";
    do {
      const reply = await client.sendCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", "100"]);
      if (!Array.isArray(reply) || reply.length < 2) break;
      cursor = valueToString(reply[0]) || "0";
      const keys = Array.isArray(reply[1]) ? reply[1].map(valueToString).filter(Boolean) : [];
      if (keys.length > 0) await client.sendCommand(["DEL", ...keys]);
    } while (cursor !== "0");
  } finally {
    await client?.close().catch(() => undefined);
  }
}

test("Effect runtime smoke: Redis queue lifecycle with temp key prefix", async (t) => {
  const config = smokeConfig();
  if (!await redisAvailable(config)) {
    t.skip(`Redis unavailable at ${redisUrl}`);
    return;
  }

  const queue = createRunQueueRuntimeClient(config);
  const runId = "run-smoke-1";
  const logicalThreadId = "thread-smoke-1";
  const workerId = "worker-smoke-1";
  const leaseToken = "lease-smoke-1";
  const run = {
    runId,
    logicalThreadId,
    threadId: logicalThreadId,
    kind: "discord-thread",
    status: "queued",
    sourceDiscordMessageId: "source-smoke-1",
    placeholderDiscordMessageId: "placeholder-smoke-1",
    prompt: "effect smoke prompt",
    promptPreview: "effect smoke prompt",
    cwd: process.cwd(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };

  try {
    assert.equal(queue.engine, "effect-managed");
    await queue.warmup();
    await queue.ensureConsumerGroup();

    const enqueueResult = await queue.tryEnqueueRun(run);
    assert.equal(enqueueResult.enqueued, true);
    assert.equal(await queue.getActiveRunId(logicalThreadId), runId);

    const job = await queue.dequeueJob(workerId, 1_000);
    assert.equal(job?.runId, runId);
    assert.ok(job?.streamId);

    const queuedRun = await queue.getRun(runId);
    assert.equal(queuedRun?.status, "queued");

    assert.equal(await queue.claimRunLease(run, workerId, leaseToken), true);
    const runningRun = await queue.getRun(runId);
    assert.equal(runningRun?.status, "running");
    assert.equal(runningRun?.workerId, workerId);
    assert.ok(await queue.getRunLeaseTtl(runId) > 0);

    const inputId = await queue.appendInput({
      runId,
      logicalThreadId,
      mode: "followUp",
      text: "queued while running",
      createdAt: timestamp(),
    });
    assert.match(inputId, /^\d+-\d+$/);
    assert.equal(await queue.countInputsForRun(logicalThreadId, runId), 1);

    assert.equal(await queue.acquireFinalize(runId, leaseToken), "acquired");
    const terminalRun = await queue.markTerminal(runId, "succeeded", {
      resultText: "ok",
      userEntryId: "user-smoke-1",
      assistantEntryId: "assistant-smoke-1",
    });
    assert.equal(terminalRun?.status, "succeeded");
    assert.equal(terminalRun?.resultText, "ok");
    assert.equal(await queue.completeFinalize(runId, leaseToken), true);
    assert.equal(await queue.releaseRunLease(runId, leaseToken), true);
    await queue.acknowledgeJob(job);
    assert.equal(await queue.clearActiveIfMatches(logicalThreadId, runId), true);

    const runs = await queue.listRuns();
    assert.equal(runs.find((item) => item.runId === runId)?.status, "succeeded");
    assert.deepEqual(await queue.listActivePointers(), []);
  } finally {
    await queue.close().catch(() => undefined);
    await deletePrefix(config).catch(() => undefined);
  }
});
