import { redis } from './auth.js';
import { TollgateError } from '@tollgate/shared';

const RATE_LUA = `
local now=tonumber(ARGV[1]); local window=tonumber(ARGV[2]); local rpm=tonumber(ARGV[3]); local tpm=tonumber(ARGV[4]); local tokens=tonumber(ARGV[5])
local bucket=math.floor(now/window); local suffix=':'..bucket
local minr=rpm; local mint=tpm; local admitted=1
for i=1,6,2 do
  local rc=redis.call('INCR',KEYS[i]..suffix); if rc==1 then redis.call('PEXPIRE',KEYS[i]..suffix,window*2) end
  local tc=redis.call('INCRBY',KEYS[i+1]..suffix,tokens); if tc==tokens then redis.call('PEXPIRE',KEYS[i+1]..suffix,window*2) end
  minr=math.min(minr,rpm-rc); mint=math.min(mint,tpm-tc); if rc>rpm or tc>tpm then admitted=0 end
end
return {admitted,math.max(0,minr),math.max(0,mint),window-(now%window)}
`;

const RESERVE_LUA = `
local limit=tonumber(ARGV[1]); local amount=tonumber(ARGV[2]); local hard=ARGV[3]=='1'; local ttl=tonumber(ARGV[4])
local spent=tonumber(redis.call('GET',KEYS[1]) or '0'); local reserved=tonumber(redis.call('GET',KEYS[2]) or '0')
if hard and spent+reserved+amount>limit then return {0,spent,reserved} end
redis.call('INCRBY',KEYS[2],amount); redis.call('PEXPIRE',KEYS[2],ttl); return {1,spent,reserved+amount}
`;

export async function rateLimit(
  orgId: string,
  teamId: string | null,
  keyId: string,
  rpm: number,
  tpm: number,
  estimate: number,
) {
  const scopes = [`org:${orgId}`, `team:${teamId ?? orgId}`, `key:${keyId}`];
  const keys = scopes.flatMap((scope) => [`rl:rpm:${scope}`, `rl:tpm:${scope}`]);
  const result = (await redis.eval(
    RATE_LUA,
    6,
    ...keys,
    Date.now(),
    60_000,
    rpm,
    tpm,
    estimate,
  )) as number[];
  if (result[0] !== 1)
    throw new TollgateError(
      429,
      'rate_limit_exceeded',
      'Rate limit exceeded',
      Math.ceil((result[3] ?? 1000) / 1000),
    );
  return { limit: rpm, remaining: result[1] ?? 0, resetMs: result[3] ?? 60_000 };
}

export async function correctTokens(
  orgId: string,
  teamId: string | null,
  keyId: string,
  delta: number,
) {
  const bucket = Math.floor(Date.now() / 60_000);
  const pipeline = redis.pipeline();
  for (const scope of [`org:${orgId}`, `team:${teamId ?? orgId}`, `key:${keyId}`])
    pipeline.incrby(`rl:tpm:${scope}:${bucket}`, delta);
  await pipeline.exec();
}

export async function reserveBudget(
  orgId: string,
  limit: bigint,
  amount: bigint,
  hard: boolean,
): Promise<void> {
  const result = (await redis.eval(
    RESERVE_LUA,
    2,
    `budget:spent:${orgId}`,
    `budget:reserved:${orgId}`,
    limit.toString(),
    amount.toString(),
    hard ? '1' : '0',
    3_600_000,
  )) as number[];
  if (result[0] !== 1) throw new TollgateError(402, 'budget_exceeded', 'Budget exhausted');
}

export async function releaseReservation(
  orgId: string,
  reserved: bigint,
  actual: bigint,
): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.decrby(`budget:reserved:${orgId}`, reserved.toString());
  pipeline.incrby(`budget:spent:${orgId}`, actual.toString());
  await pipeline.exec();
}
