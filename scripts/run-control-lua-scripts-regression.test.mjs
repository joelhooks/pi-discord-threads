import assert from "node:assert/strict";
import test from "node:test";
import {
  atomicEnqueueRunScript,
  buildRecordRetryLaterEval,
  claimRunLeaseScript,
  completeFinalizeScript,
  heartbeatRunLeaseScript,
  recordRetryLaterScript,
  recordWorkerIdleScript,
  runControlLuaScripts,
  verifyRunOwnershipScript,
} from "../dist/run-control/lua-scripts.js";

test("run-control Lua scripts are named and non-empty", () => {
  const names = new Set();
  for (const script of runControlLuaScripts) {
    assert.equal(typeof script.name, "string");
    assert.equal(script.name.length > 0, true);
    assert.equal(typeof script.source, "string");
    assert.equal(script.source.trim().length > 0, true);
    assert.equal(names.has(script.name), false, `duplicate script name ${script.name}`);
    names.add(script.name);
  }
});

test("ownership-sensitive scripts check active pointer and lease before side effects", () => {
  for (const script of [verifyRunOwnershipScript, heartbeatRunLeaseScript, recordRetryLaterScript]) {
    const activeCheck = script.source.indexOf("redis.call('GET', KEYS[1])");
    const leaseCheck = script.source.indexOf("redis.call('GET', KEYS[2])");
    assert.notEqual(activeCheck, -1, `${script.name} missing active pointer check`);
    assert.notEqual(leaseCheck, -1, `${script.name} missing lease check`);
  }
  assert.notEqual(claimRunLeaseScript.source.indexOf("redis.call('GET', KEYS[1])"), -1, "claimRunLease missing active pointer check");
  assert.ok(claimRunLeaseScript.source.indexOf("'NX'") < claimRunLeaseScript.source.indexOf("HINCRBY"));

  assert.ok(recordRetryLaterScript.source.indexOf("redis.call('GET', KEYS[2])") < recordRetryLaterScript.source.indexOf("HINCRBY"));
  assert.ok(recordRetryLaterScript.source.indexOf("HINCRBY") < recordRetryLaterScript.source.indexOf("dead_lettered"));
});

test("enqueue and lease scripts clean up partial state on Redis write errors", () => {
  assert.match(atomicEnqueueRunScript.source, /redis\.call\('DEL', KEYS\[1\]\)[\s\S]*redis\.call\('DEL', KEYS\[2\]\)[\s\S]*return \{'error'/);
  assert.match(claimRunLeaseScript.source, /redis\.call\('DEL', KEYS\[2\]\)[\s\S]*return \{'error'/);
});

test("recordRetryLater command builder owns exact Redis EVAL shape", () => {
  const result = buildRecordRetryLaterEval({
    activeKey: "active-key",
    leaseKey: "lease-key",
    runKey: "run-key",
    runId: "run-1",
    leaseToken: "lease-1",
    workerId: "worker-1",
    now: "2026-06-21T00:00:00.000Z",
    reason: "registry mismatch",
    maxAttempts: 3.9,
  });

  assert.equal(result.boundedMaxAttempts, 3);
  assert.deepEqual(result.command, [
    "EVAL",
    recordRetryLaterScript.source,
    "3",
    "active-key",
    "lease-key",
    "run-key",
    "run-1",
    "lease-1",
    "worker-1",
    "2026-06-21T00:00:00.000Z",
    "registry mismatch",
    "3",
  ]);
});

test("recordRetryLater command builder bounds max attempts before stringifying", () => {
  const result = buildRecordRetryLaterEval({
    activeKey: "active-key",
    leaseKey: "lease-key",
    runKey: "run-key",
    runId: "run-1",
    leaseToken: "lease-1",
    workerId: "worker-1",
    now: "2026-06-21T00:00:00.000Z",
    reason: "registry mismatch",
    maxAttempts: 0.5,
  });

  assert.equal(result.boundedMaxAttempts, 1);
  assert.equal(result.command.at(-1), "1");
});

test("heartbeat, idle, and finalize scripts preserve existing invariants", () => {
  assert.match(heartbeatRunLeaseScript.source, /status ~= 'queued' and status ~= 'running' and status ~= 'finalizing'/);
  assert.match(heartbeatRunLeaseScript.source, /PEXPIRE/);
  assert.match(recordWorkerIdleScript.source, /'status', 'idle'/);
  assert.match(recordWorkerIdleScript.source, /HDEL', KEYS\[1\], 'runId'/);
  assert.match(completeFinalizeScript.source, /current == 'done'/);
});
