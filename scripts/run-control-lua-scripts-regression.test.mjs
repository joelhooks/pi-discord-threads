import assert from "node:assert/strict";
import test from "node:test";
import {
  atomicEnqueueRunScript,
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

test("heartbeat, idle, and finalize scripts preserve existing invariants", () => {
  assert.match(heartbeatRunLeaseScript.source, /status ~= 'queued' and status ~= 'running' and status ~= 'finalizing'/);
  assert.match(heartbeatRunLeaseScript.source, /PEXPIRE/);
  assert.match(recordWorkerIdleScript.source, /'status', 'idle'/);
  assert.match(recordWorkerIdleScript.source, /HDEL', KEYS\[1\], 'runId'/);
  assert.match(completeFinalizeScript.source, /current == 'done'/);
});
