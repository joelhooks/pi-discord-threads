export interface RunControlLuaScript {
  name: string;
  source: string;
}

export const verifyRunOwnershipScript: RunControlLuaScript = {
  name: "verifyRunOwnership",
  source: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return 0
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return 0
end
return 1
`,
};

export const atomicEnqueueRunScript: RunControlLuaScript = {
  name: "atomicEnqueueRun",
  source: `
local active = redis.call('GET', KEYS[1])
if active then
  return {'busy', active}
end
redis.call('SET', KEYS[1], ARGV[1])
for i = 2, #ARGV, 2 do
  local hset = redis.pcall('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
  if type(hset) == 'table' and hset['err'] then
    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[2])
    return {'error', hset['err']}
  end
end
local jobId = redis.pcall('XADD', KEYS[3], '*', 'runId', ARGV[1])
if type(jobId) == 'table' and jobId['err'] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return {'error', jobId['err']}
end
return {'enqueued', ARGV[1], jobId}
`,
};

export const claimRunLeaseScript: RunControlLuaScript = {
  name: "claimRunLease",
  source: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= ARGV[8] then
  return 0
end
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return 0
end
local claimed = redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3])
if not ((type(claimed) == 'table' and claimed['ok'] == 'OK') or claimed == 'OK') then
  return 0
end
local generation = redis.pcall('HINCRBY', KEYS[3], 'leaseGeneration', 1)
if type(generation) == 'table' and generation['err'] then
  redis.call('DEL', KEYS[2])
  return {'error', generation['err']}
end
local hset = redis.pcall('HSET', KEYS[3],
  'status', ARGV[4],
  'workerId', ARGV[5],
  'leaseToken', ARGV[2],
  'startedAt', ARGV[6],
  'updatedAt', ARGV[7],
  'leaseExpiresAt', ARGV[9],
  'leaseGeneration', generation
)
if type(hset) == 'table' and hset['err'] then
  redis.call('DEL', KEYS[2])
  return {'error', hset['err']}
end
return 1
`,
};

export const recordRetryLaterScript: RunControlLuaScript = {
  name: "recordRetryLater",
  source: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return {'lost', 'active'}
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return {'lost', 'lease'}
end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then
  return {'lost', status or 'missing'}
end
local attempts = redis.pcall('HINCRBY', KEYS[3], 'retryLaterCount', 1)
if type(attempts) == 'table' and attempts['err'] then
  return {'error', attempts['err']}
end
local hset = redis.pcall('HSET', KEYS[3],
  'lastRetryLaterAt', ARGV[4],
  'lastRetryLaterReason', ARGV[5],
  'lastRetryLaterWorkerId', ARGV[3],
  'updatedAt', ARGV[4]
)
if type(hset) == 'table' and hset['err'] then
  return {'error', hset['err']}
end
if attempts >= tonumber(ARGV[6]) then
  local deadLetterReason = 'run-control dead-lettered ' .. ARGV[1] .. ' after ' .. attempts .. ' retry-later attempt(s): ' .. ARGV[5]
  local terminal = redis.pcall('HSET', KEYS[3],
    'status', 'interrupted',
    'updatedAt', ARGV[4],
    'finalizedAt', ARGV[4],
    'deadLetteredAt', ARGV[4],
    'deadLetterReason', deadLetterReason,
    'deadLetteredByWorkerId', ARGV[3],
    'error', deadLetterReason
  )
  if type(terminal) == 'table' and terminal['err'] then
    return {'error', terminal['err']}
  end
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return {'dead_lettered', tostring(attempts)}
end
redis.call('DEL', KEYS[2])
return {'retry_later', tostring(attempts)}
`,
};

export const heartbeatRunLeaseScript: RunControlLuaScript = {
  name: "heartbeatRunLease",
  source: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
local status = redis.call('HGET', KEYS[3], 'status')
if status ~= 'queued' and status ~= 'running' and status ~= 'finalizing' then return 0 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('HSET', KEYS[3], 'updatedAt', ARGV[4], 'workerId', ARGV[5], 'leaseExpiresAt', ARGV[6])
return 1
`,
};

export const clearActiveIfMatchesScript: RunControlLuaScript = {
  name: "clearActiveIfMatches",
  source: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
};

export const releaseRunLeaseScript: RunControlLuaScript = {
  name: "releaseRunLease",
  source: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
};

export const completeFinalizeScript: RunControlLuaScript = {
  name: "completeFinalize",
  source: "local current = redis.call('GET', KEYS[1]); if current == ARGV[1] then redis.call('SET', KEYS[1], 'done'); return 1 elseif current == 'done' then return 1 else return 0 end",
};

export const runControlLuaScripts = [
  verifyRunOwnershipScript,
  atomicEnqueueRunScript,
  claimRunLeaseScript,
  recordRetryLaterScript,
  heartbeatRunLeaseScript,
  clearActiveIfMatchesScript,
  releaseRunLeaseScript,
  completeFinalizeScript,
] as const;
