import { redis } from './auth.js';
import { TollgateError } from '@tollgate/shared';

const RATE_LUA = `
local now=tonumber(ARGV[1]); local window=tonumber(ARGV[2]); local rpm=tonumber(ARGV[3]); local tpm=tonumber(ARGV[4]); local tokens=tonumber(ARGV[5])
local bucket=math.floor(now/window); local suffix=':'..bucket
local minr=rpm; local mint=tpm; local admitted=1
local counts={}
for i=1,6,2 do
  local rc=tonumber(redis.call('GET',KEYS[i]..suffix) or '0')+1
  local tc=tonumber(redis.call('GET',KEYS[i+1]..suffix) or '0')+tokens
  counts[i]=rc; counts[i+1]=tc
  minr=math.min(minr,rpm-rc); mint=math.min(mint,tpm-tc)
  if rc>rpm or tc>tpm then admitted=0 end
end
if admitted==0 then return {0,math.max(0,minr),math.max(0,mint),window-(now%window),bucket} end
for i=1,6,2 do
  redis.call('INCR',KEYS[i]..suffix); if counts[i]==1 then redis.call('PEXPIRE',KEYS[i]..suffix,window*2) end
  redis.call('INCRBY',KEYS[i+1]..suffix,tokens); if counts[i+1]==tokens then redis.call('PEXPIRE',KEYS[i+1]..suffix,window*2) end
end
return {1,math.max(0,minr),math.max(0,mint),window-(now%window),bucket}
`;

const CORRECT_TOKENS_LUA = `
local delta=tonumber(ARGV[1])
for i=1,#KEYS do
  if redis.call('EXISTS',KEYS[i])==1 then redis.call('INCRBY',KEYS[i],delta) end
end
return 1
`;

export async function rateLimit(
  orgId: string,
  teamId: string | null,
  keyId: string,
  rpm: number,
  tpm: number,
  estimate: number,
  nowMs = Date.now(),
) {
  const scopes = [`org:${orgId}`, `team:${teamId ?? orgId}`, `key:${keyId}`];
  const keys = scopes.flatMap((scope) => [`rl:rpm:${scope}`, `rl:tpm:${scope}`]);
  const result = (await redis.eval(
    RATE_LUA,
    6,
    ...keys,
    nowMs,
    60_000,
    rpm,
    tpm,
    estimate,
  )) as number[];
  if (result[0] !== 1) {
    throw new TollgateError(
      429,
      'rate_limit_exceeded',
      'Rate limit exceeded',
      Math.ceil((result[3] ?? 1000) / 1000),
    );
  }
  return {
    limit: rpm,
    remaining: result[1] ?? 0,
    resetMs: result[3] ?? 60_000,
    bucket: result[4] ?? Math.floor(nowMs / 60_000),
  };
}

export async function correctTokens(
  orgId: string,
  teamId: string | null,
  keyId: string,
  bucket: number,
  delta: number,
) {
  const keys = [`org:${orgId}`, `team:${teamId ?? orgId}`, `key:${keyId}`].map(
    (scope) => `rl:tpm:${scope}:${bucket}`,
  );
  await redis.eval(CORRECT_TOKENS_LUA, keys.length, ...keys, delta);
}
