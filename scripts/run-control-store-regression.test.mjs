import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { RunControlStore } from "../dist/run-control/store.js";

function createRun(id, status = "queued") {
  const now = new Date(0).toISOString();
  return {
    runId: id,
    logicalThreadId: "thread-1",
    threadId: "thread-1",
    kind: "discord-thread",
    status,
    sourceDiscordMessageId: `source-${id}`,
    placeholderDiscordMessageId: `placeholder-${id}`,
    prompt: `prompt ${id}`,
    promptPreview: `prompt ${id}`,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
  };
}

class FakeRedis {
  strings = new Map();
  hashes = new Map();
  streams = [];
  commands = [];
  failJobXadd = false;
  failEventSummary = false;
  failJobXrange = false;

  async sendCommand(args) {
    this.commands.push(args);
    const [command] = args;
    if (command === "EVAL") return this.eval(args);
    if (command === "GET") return this.strings.get(args[1]) ?? null;
    if (command === "HGETALL") {
      const hash = this.hashes.get(args[1]) ?? new Map();
      return [...hash.entries()].flat();
    }
    if (command === "XADD") {
      const id = `${this.streams.length + 1}-0`;
      this.streams.push({ key: args[1], id, args });
      return id;
    }
    if (command === "XLEN") return this.streams.filter((entry) => entry.key === args[1]).length;
    if (command === "XREVRANGE") {
      if (this.failEventSummary) throw new Error("Redis XREVRANGE exploded");
      const countIndex = args.indexOf("COUNT");
      const count = countIndex === -1 ? 100 : Number(args[countIndex + 1]);
      return this.streams
        .filter((entry) => entry.key === args[1])
        .slice()
        .reverse()
        .slice(0, count)
        .map((entry) => [entry.id, eventFields(entry.args)]);
    }
    if (command === "XRANGE") {
      if (this.failJobXrange) throw new Error("Redis XRANGE exploded");
      return this.streams
        .filter((entry) => entry.key === args[1] && entry.id === args[2])
        .map((entry) => [entry.id, eventFields(entry.args)]);
    }
    if (command === "XPENDING" && args.length > 3) {
      return [["1-0", "worker-1", 4321, 3]];
    }
    if (command === "XPENDING") return [1, "1-0", "1-0", [["worker-1", 1]]];
    if (command === "HSET") {
      const hash = this.hashes.get(args[1]) ?? new Map();
      for (let i = 2; i < args.length; i += 2) hash.set(args[i], args[i + 1]);
      this.hashes.set(args[1], hash);
      return 1;
    }
    if (command === "PEXPIRE") return 1;
    if (command === "PTTL") return 1234;
    if (command === "XAUTOCLAIM") return ["0-0", []];
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }

  async close() {}
  destroy() {}

  eval(args) {
    const script = args[1];
    if (script.includes("'leaseToken'")) {
      const activeKey = args[3];
      const leaseKey = args[4];
      const runKey = args[5];
      const runId = args[6];
      const leaseToken = args[7];
      const status = args[9];
      const workerId = args[10];
      const startedAt = args[11];
      const updatedAt = args[12];
      const expectedCurrentStatus = args[13];
      const leaseExpiresAt = args[14];
      if (this.strings.get(activeKey) !== runId) return 0;
      const hash = this.hashes.get(runKey) ?? new Map();
      const currentStatus = hash.get("status");
      if (currentStatus !== expectedCurrentStatus) return 0;
      if (currentStatus !== "queued" && currentStatus !== "running" && currentStatus !== "finalizing") return 0;
      if (this.strings.has(leaseKey)) return 0;
      this.strings.set(leaseKey, leaseToken);
      hash.set("status", status);
      hash.set("workerId", workerId);
      hash.set("leaseToken", leaseToken);
      hash.set("startedAt", startedAt);
      hash.set("updatedAt", updatedAt);
      hash.set("leaseExpiresAt", leaseExpiresAt);
      hash.set("leaseGeneration", String(Number(hash.get("leaseGeneration") ?? "0") + 1));
      this.hashes.set(runKey, hash);
      return 1;
    }
    if (script.includes("'lastRetryLaterAt'")) {
      const activeKey = args[3];
      const leaseKey = args[4];
      const runKey = args[5];
      const runId = args[6];
      const leaseToken = args[7];
      const workerId = args[8];
      const now = args[9];
      const reason = args[10];
      const maxAttempts = Number(args[11]);
      if (this.strings.get(activeKey) !== runId) return ["lost", "active"];
      if (this.strings.get(leaseKey) !== leaseToken) return ["lost", "lease"];
      const hash = this.hashes.get(runKey) ?? new Map();
      const status = hash.get("status");
      if (status !== "queued" && status !== "running" && status !== "finalizing") return ["lost", status ?? "missing"];
      const attempts = Number(hash.get("retryLaterCount") ?? "0") + 1;
      hash.set("retryLaterCount", String(attempts));
      hash.set("lastRetryLaterAt", now);
      hash.set("lastRetryLaterReason", reason);
      hash.set("lastRetryLaterWorkerId", workerId);
      hash.set("updatedAt", now);
      if (attempts >= maxAttempts) {
        const deadLetterReason = `run-control dead-lettered ${runId} after ${attempts} retry-later attempt(s): ${reason}`;
        hash.set("status", "interrupted");
        hash.set("finalizedAt", now);
        hash.set("deadLetteredAt", now);
        hash.set("deadLetterReason", deadLetterReason);
        hash.set("deadLetteredByWorkerId", workerId);
        hash.set("error", deadLetterReason);
        this.strings.delete(activeKey);
        this.strings.delete(leaseKey);
        this.hashes.set(runKey, hash);
        return ["dead_lettered", String(attempts)];
      }
      this.strings.delete(leaseKey);
      this.hashes.set(runKey, hash);
      return ["retry_later", String(attempts)];
    }
    if (script.includes("redis.call('PEXPIRE', KEYS[2], ARGV[3])")) {
      const activeKey = args[3];
      const leaseKey = args[4];
      const runKey = args[5];
      const runId = args[6];
      const leaseToken = args[7];
      const updatedAt = args[9];
      const workerId = args[10];
      const leaseExpiresAt = args[11];
      const hash = this.hashes.get(runKey) ?? new Map();
      const status = hash.get("status");
      if (this.strings.get(activeKey) !== runId) return 0;
      if (this.strings.get(leaseKey) !== leaseToken) return 0;
      if (status !== "queued" && status !== "running" && status !== "finalizing") return 0;
      hash.set("updatedAt", updatedAt);
      hash.set("workerId", workerId);
      hash.set("leaseExpiresAt", leaseExpiresAt);
      this.hashes.set(runKey, hash);
      return 1;
    }
    if (script.includes("redis.call('GET', KEYS[2]) ~= ARGV[2]")) {
      const activeKey = args[3];
      const leaseKey = args[4];
      const runKey = args[5];
      const runId = args[6];
      const leaseToken = args[7];
      const hash = this.hashes.get(runKey) ?? new Map();
      const status = hash.get("status");
      if (this.strings.get(activeKey) !== runId) return 0;
      if (this.strings.get(leaseKey) !== leaseToken) return 0;
      if (status !== "queued" && status !== "running" && status !== "finalizing") return 0;
      return 1;
    }
    if (script.includes("redis.call('HDEL', KEYS[1], 'runId')")) {
      const workerKey = args[3];
      const workerId = args[4];
      const updatedAt = args[5];
      const hash = this.hashes.get(workerKey) ?? new Map();
      hash.set("workerId", workerId);
      hash.set("status", "idle");
      hash.set("updatedAt", updatedAt);
      hash.delete("runId");
      this.hashes.set(workerKey, hash);
      return 1;
    }
    if (script.includes("return {'enqueued'")) {
      const activeKey = args[3];
      const runKey = args[4];
      const jobsKey = args[5];
      const runId = args[6];
      const active = this.strings.get(activeKey);
      if (active) return ["busy", active];
      this.strings.set(activeKey, runId);
      const hash = new Map();
      for (let i = 7; i < args.length; i += 2) {
        hash.set(args[i], args[i + 1]);
      }
      this.hashes.set(runKey, hash);
      if (this.failJobXadd) {
        this.strings.delete(activeKey);
        this.hashes.delete(runKey);
        return ["error", "WRONGTYPE Operation against a key holding the wrong kind of value"];
      }
      const jobId = `${this.streams.length + 1}-0`;
      this.streams.push({ key: jobsKey, id: jobId, args: ["XADD", jobsKey, "*", "runId", runId] });
      return ["enqueued", runId, jobId];
    }
    if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
      const key = args[3];
      const expected = args[4];
      if (this.strings.get(key) === expected) {
        this.strings.delete(key);
        return 1;
      }
      return 0;
    }
    throw new Error("unexpected EVAL script");
  }
}

function createStore(fake = new FakeRedis()) {
  const config = defaultConfig();
  config.runControl.enabled = true;
  return { store: new RunControlStore(fake, config), fake };
}

function eventFields(args) {
  const start = args.includes("*") ? args.indexOf("*") + 1 : 3;
  return args.slice(start);
}

function streamField(args, field) {
  const index = args.indexOf(field);
  return index === -1 ? undefined : args[index + 1];
}

test("tryEnqueueRun creates active pointer, run hash, and job atomically", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-1");

  const result = await store.tryEnqueueRun(run);

  assert.deepEqual(result, { enqueued: true, run });
  assert.equal(fake.strings.get("pi-discord-threads:thread:thread-1:active"), "run-1");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-1").get("status"), "queued");
  assert.deepEqual(fake.streams.map((entry) => entry.key), [
    "pi-discord-threads:run:jobs",
    "pi-discord-threads:run:events",
  ]);
  assert.equal(fake.commands.filter((args) => args[0] === "EVAL").length, 1);
});

test("tryEnqueueRun cleans active state when the atomic job append fails", async () => {
  const fake = new FakeRedis();
  fake.failJobXadd = true;
  const { store } = createStore(fake);
  const run = createRun("run-poison");

  await assert.rejects(() => store.tryEnqueueRun(run), /Redis enqueue failed/);

  assert.equal(fake.strings.has("pi-discord-threads:thread:thread-1:active"), false);
  assert.equal(fake.hashes.has("pi-discord-threads:runs:run-poison"), false);
  assert.equal(fake.streams.length, 0);
});

test("run events are bounded and summarize high-volume and warning telemetry", async () => {
  const { store, fake } = createStore();

  await store.appendRunEvent("run-1", "thinking_delta", { sessionFile: "/private/session.jsonl" });
  await store.appendRunEvent("run-1", "thinking_delta", {});
  await store.appendRunEvent("run-1", "tool_start", {});
  await store.appendRunEvent("run-2", "retry_later", { isError: true });

  const eventCommands = fake.streams.filter((entry) => entry.key === "pi-discord-threads:run:events").map((entry) => entry.args);
  assert.equal(eventCommands.every((args) => args.includes("MAXLEN") && args.includes("50000")), true);
  assert.deepEqual(eventCommands[0].slice(0, 6), ["XADD", "pi-discord-threads:run:events", "MAXLEN", "~", "50000", "*"]);

  const summary = await store.getRunEventSummary({ sampleLimit: 10 });
  const xrevrangeCommand = fake.commands.find((args) => args[0] === "XREVRANGE");
  assert.deepEqual(xrevrangeCommand, ["XREVRANGE", "pi-discord-threads:run:events", "+", "-", "COUNT", "10"]);

  assert.equal(summary.streamLength, 4);
  assert.equal(summary.sampleCount, 4);
  assert.deepEqual(summary.typeCounts.map((count) => [count.type, count.count]), [
    ["thinking_delta", 2],
    ["retry_later", 1],
    ["tool_start", 1],
  ]);
  assert.deepEqual(summary.highVolumeTypeCounts.map((count) => [count.type, count.count]), [["thinking_delta", 2]]);
  assert.deepEqual(summary.warningTypeCounts.map((count) => [count.type, count.count]), [["retry_later", 1]]);
  assert.equal(JSON.stringify(summary).includes("/private/session.jsonl"), false);
});

test("run event summary reports Redis telemetry query failures", async () => {
  const fake = new FakeRedis();
  fake.failEventSummary = true;
  const { store } = createStore(fake);

  const summary = await store.getRunEventSummary({ sampleLimit: 10 });

  assert.equal(summary.streamLength, 0);
  assert.equal(summary.sampleCount, 0);
  assert.match(summary.error, /Redis XREVRANGE exploded/);
});

test("pending job details correlate Redis stream ownership with run lease metadata", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-pending", "running");
  fake.streams.push({ key: "pi-discord-threads:run:jobs", id: "1-0", args: ["XADD", "pi-discord-threads:run:jobs", "*", "runId", run.runId] });
  fake.hashes.set("pi-discord-threads:runs:run-pending", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
    workerId: "worker-lease",
  })));

  const details = await store.getPendingJobDetails();
  const pendingCommand = fake.commands.find((args) => args[0] === "XPENDING" && args.length > 3);
  const xrangeCommand = fake.commands.find((args) => args[0] === "XRANGE");

  assert.deepEqual(pendingCommand, ["XPENDING", "pi-discord-threads:run:jobs", "workers", "-", "+", "10"]);
  assert.deepEqual(xrangeCommand, ["XRANGE", "pi-discord-threads:run:jobs", "1-0", "1-0"]);
  assert.deepEqual(details, [{
    streamId: "1-0",
    consumer: "worker-1",
    idleMs: 4321,
    deliveries: 3,
    runId: "run-pending",
    runStatus: "running",
    leaseWorkerId: "worker-lease",
    leaseTtlMs: 1234,
  }]);
});

test("pending job details surface per-job Redis lookup failures", async () => {
  const fake = new FakeRedis();
  fake.failJobXrange = true;
  fake.streams.push({ key: "pi-discord-threads:run:jobs", id: "1-0", args: ["XADD", "pi-discord-threads:run:jobs", "*", "runId", "run-pending"] });
  const { store } = createStore(fake);

  await assert.rejects(() => store.getPendingJobDetails(), /Redis XRANGE exploded/);
});

test("tryEnqueueRun rejects a live active pointer without creating a second job", async () => {
  const { store, fake } = createStore();
  const first = createRun("run-1");
  const second = createRun("run-2");

  await store.tryEnqueueRun(first);
  const result = await store.tryEnqueueRun(second);

  assert.deepEqual(result, { enqueued: false, activeRunId: "run-1" });
  assert.equal(fake.hashes.has("pi-discord-threads:runs:run-2"), false);
  assert.equal(fake.streams.filter((entry) => entry.key === "pi-discord-threads:run:jobs").length, 1);
});

test("finalizing active pointer is not cleared or queueable", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-finalizing", "finalizing");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", run.runId);
  fake.hashes.set("pi-discord-threads:runs:run-finalizing", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
    resultText: "already answered",
  })));

  const queueable = await store.getQueueableActiveRunId("thread-1");

  assert.equal(queueable, undefined);
  assert.equal(fake.strings.get("pi-discord-threads:thread:thread-1:active"), run.runId);
});

test("patchRun round-trips retry-later and dead-letter metadata", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-retry-metadata");
  await store.tryEnqueueRun(run);

  await store.patchRun(run.runId, {
    retryLaterCount: 3,
    lastRetryLaterAt: new Date(1).toISOString(),
    lastRetryLaterReason: "registry idle patch failed",
    lastRetryLaterWorkerId: "worker-1",
    deadLetteredAt: new Date(2).toISOString(),
    deadLetterReason: "dead-lettered after retries",
    deadLetteredByWorkerId: "worker-1",
  });

  const persisted = await store.getRun(run.runId);
  assert.equal(persisted.retryLaterCount, 3);
  assert.equal(persisted.lastRetryLaterReason, "registry idle patch failed");
  assert.equal(persisted.deadLetterReason, "dead-lettered after retries");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-retry-metadata").get("retryLaterCount"), "3");
});

test("recordRetryLater increments attempts and releases the lease below threshold", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-retry-later", "running");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", run.runId);
  fake.strings.set("pi-discord-threads:leases:run:run-retry-later", "lease-1");
  fake.hashes.set("pi-discord-threads:runs:run-retry-later", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
  })));

  const result = await store.recordRetryLater(run, "lease-1", "worker-1", "registry mismatch", 3);
  const persisted = await store.getRun(run.runId);

  assert.deepEqual(result, { attempts: 1, deadLettered: false });
  assert.equal(persisted.retryLaterCount, 1);
  assert.equal(persisted.lastRetryLaterReason, "registry mismatch");
  assert.equal(fake.strings.get("pi-discord-threads:thread:thread-1:active"), run.runId);
  assert.equal(fake.strings.has("pi-discord-threads:leases:run:run-retry-later"), false);
});

test("recordRetryLater uses bounded builder max attempts in retry-later event metadata", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-retry-bounded", "running");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", run.runId);
  fake.strings.set("pi-discord-threads:leases:run:run-retry-bounded", "lease-1");
  fake.hashes.set("pi-discord-threads:runs:run-retry-bounded", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
  })));

  await store.recordRetryLater(run, "lease-1", "worker-1", "registry mismatch", 2.9);

  const retryEvent = fake.streams.find((entry) => entry.key === "pi-discord-threads:run:events" && streamField(entry.args, "type") === "retry_later");
  const evalCommand = fake.commands.find((args) => args[0] === "EVAL" && args[1].includes("'lastRetryLaterAt'"));
  assert.equal(evalCommand.at(-1), "2");
  assert.equal(streamField(retryEvent.args, "maxAttempts"), "2");
});

test("recordRetryLater dead-letters atomically before releasing ownership", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-dead-letter", "running");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", run.runId);
  fake.strings.set("pi-discord-threads:leases:run:run-dead-letter", "lease-1");
  fake.hashes.set("pi-discord-threads:runs:run-dead-letter", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
    retryLaterCount: "2",
  })));

  const result = await store.recordRetryLater(run, "lease-1", "worker-1", "registry mismatch", 3);
  const persisted = await store.getRun(run.runId);

  assert.deepEqual(result, { attempts: 3, deadLettered: true });
  assert.equal(persisted.status, "interrupted");
  assert.equal(persisted.retryLaterCount, 3);
  assert.match(persisted.deadLetterReason, /registry mismatch/);
  assert.equal(fake.strings.has("pi-discord-threads:thread:thread-1:active"), false);
  assert.equal(fake.strings.has("pi-discord-threads:leases:run:run-dead-letter"), false);
});

test("recordRetryLater refuses to count attempts after ownership is gone", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-lost-retry", "running");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", run.runId);
  fake.strings.set("pi-discord-threads:leases:run:run-lost-retry", "someone-else");
  fake.hashes.set("pi-discord-threads:runs:run-lost-retry", new Map(Object.entries({
    ...run,
    imagesJson: "[]",
  })));

  await assert.rejects(() => store.recordRetryLater(run, "lease-1", "worker-1", "registry mismatch", 3), /ownership lost/);

  const persisted = await store.getRun(run.runId);
  assert.equal(persisted.retryLaterCount, undefined);
  assert.equal(fake.strings.get("pi-discord-threads:thread:thread-1:active"), run.runId);
  assert.equal(fake.strings.get("pi-discord-threads:leases:run:run-lost-retry"), "someone-else");
});

test("recordWorkerIdle clears stale worker run id", async () => {
  const { store, fake } = createStore();
  fake.hashes.set("pi-discord-threads:workers:worker-1", new Map([
    ["workerId", "worker-1"],
    ["status", "running"],
    ["runId", "run-old"],
  ]));

  await store.recordWorkerIdle("worker-1");

  const worker = fake.hashes.get("pi-discord-threads:workers:worker-1");
  assert.equal(worker.get("status"), "idle");
  assert.equal(worker.has("runId"), false);
  assert.equal(worker.get("workerId"), "worker-1");
});

test("claimRunLease atomically verifies the active pointer before taking the lease", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-claim");
  await store.tryEnqueueRun(run);

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-newer");
  const staleClaim = await store.claimRunLease(run, "worker-1", "token-stale");
  assert.equal(staleClaim, false);
  assert.equal(fake.strings.has("pi-discord-threads:leases:run:run-claim"), false);
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-claim").get("status"), "queued");

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-claim");
  fake.hashes.get("pi-discord-threads:runs:run-claim").set("status", "succeeded");
  const terminalRaceClaim = await store.claimRunLease(run, "worker-1", "token-terminal");
  assert.equal(terminalRaceClaim, false);
  assert.equal(fake.strings.has("pi-discord-threads:leases:run:run-claim"), false);

  fake.hashes.get("pi-discord-threads:runs:run-claim").set("status", "queued");
  const liveClaim = await store.claimRunLease(run, "worker-1", "token-live");
  assert.equal(liveClaim, true);
  assert.equal(fake.strings.get("pi-discord-threads:leases:run:run-claim"), "token-live");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-claim").get("status"), "running");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-claim").get("workerId"), "worker-1");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-claim").get("leaseGeneration"), "1");
  assert.match(fake.hashes.get("pi-discord-threads:runs:run-claim").get("leaseExpiresAt"), /^\d{4}-\d{2}-\d{2}T/);
});

test("heartbeatRunLease requires active pointer, lease token, and non-terminal status", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-heartbeat");
  await store.tryEnqueueRun(run);
  assert.equal(await store.claimRunLease(run, "worker-1", "token-1"), true);

  assert.equal(await store.heartbeatRunLease("run-heartbeat", "thread-1", "token-1", "worker-1"), true);
  assert.match(fake.hashes.get("pi-discord-threads:runs:run-heartbeat").get("leaseExpiresAt"), /^\d{4}-\d{2}-\d{2}T/);

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-newer");
  assert.equal(await store.heartbeatRunLease("run-heartbeat", "thread-1", "token-1", "worker-1"), false);

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-heartbeat");
  fake.hashes.get("pi-discord-threads:runs:run-heartbeat").set("status", "succeeded");
  assert.equal(await store.heartbeatRunLease("run-heartbeat", "thread-1", "token-1", "worker-1"), false);
});

test("verifyRunOwnership requires active pointer, lease token, and non-terminal status", async () => {
  const { store, fake } = createStore();
  const run = createRun("run-owned");
  await store.tryEnqueueRun(run);
  assert.equal(await store.claimRunLease(run, "worker-1", "token-1"), true);

  assert.equal(await store.verifyRunOwnership("run-owned", "thread-1", "token-1"), true);
  assert.equal(await store.verifyRunOwnership("run-owned", "thread-1", "wrong-token"), false);

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-newer");
  assert.equal(await store.verifyRunOwnership("run-owned", "thread-1", "token-1"), false);

  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-owned");
  fake.hashes.get("pi-discord-threads:runs:run-owned").set("status", "succeeded");
  assert.equal(await store.verifyRunOwnership("run-owned", "thread-1", "token-1"), false);
});

test("tryEnqueueRun clears stale terminal active pointer and retries", async () => {
  const { store, fake } = createStore();
  const terminal = createRun("run-old", "succeeded");
  fake.strings.set("pi-discord-threads:thread:thread-1:active", "run-old");
  fake.hashes.set("pi-discord-threads:runs:run-old", new Map(Object.entries({
    ...terminal,
    imagesJson: "[]",
  })));

  const next = createRun("run-next");
  const result = await store.tryEnqueueRun(next);

  assert.deepEqual(result, { enqueued: true, run: next });
  assert.equal(fake.strings.get("pi-discord-threads:thread:thread-1:active"), "run-next");
  assert.equal(fake.hashes.get("pi-discord-threads:runs:run-next").get("status"), "queued");
});

test("claimStaleJob reclaims after the worker lease TTL instead of the broader stale run window", async () => {
  const fake = new FakeRedis();
  const config = defaultConfig();
  config.runControl.enabled = true;
  config.runControl.leaseTtlMs = 12_345;
  config.runControl.staleRunMs = 999_999;
  const store = new RunControlStore(fake, config);

  await store.claimStaleJob("worker-1");

  const command = fake.commands.find((args) => args[0] === "XAUTOCLAIM");
  assert.ok(command, "expected XAUTOCLAIM command");
  assert.equal(command[4], "12345");
});
