import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { correctTokens, rateLimit } from '../../packages/gateway/src/limits.js';
import { redis } from '../../packages/gateway/src/auth.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

suite('atomic Redis admission', () => {
  const rateOrg = randomUUID();
  const rateTeam = randomUUID();
  const rateKey = randomUUID();
  afterAll(async () => {
    const rateKeys = await redis.keys(`rl:*:*:${rateOrg}:*`);
    if (rateKeys.length) await redis.del(...rateKeys);
    const teamKeys = await redis.keys(`rl:*:team:${rateTeam}:*`);
    if (teamKeys.length) await redis.del(...teamKeys);
    const keyKeys = await redis.keys(`rl:*:key:${rateKey}:*`);
    if (keyKeys.length) await redis.del(...keyKeys);
    await redis.quit();
  });

  it('does not consume RPM or TPM when an admission is rejected', async () => {
    const now = 120_000;
    const admitted = await rateLimit(rateOrg, rateTeam, rateKey, 1, 100, 20, now);
    expect(admitted.bucket).toBe(2);
    await expect(rateLimit(rateOrg, rateTeam, rateKey, 1, 100, 20, now)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    });
    for (const scope of [`org:${rateOrg}`, `team:${rateTeam}`, `key:${rateKey}`]) {
      expect(await redis.get(`rl:rpm:${scope}:2`)).toBe('1');
      expect(await redis.get(`rl:tpm:${scope}:2`)).toBe('20');
    }
  });

  it('corrects the original admission bucket after the wall clock advances', async () => {
    const admission = await rateLimit(rateOrg, rateTeam, rateKey, 10, 1000, 100, 180_000);
    await correctTokens(rateOrg, rateTeam, rateKey, admission.bucket, -95);
    for (const scope of [`org:${rateOrg}`, `team:${rateTeam}`, `key:${rateKey}`]) {
      expect(await redis.get(`rl:tpm:${scope}:3`)).toBe('5');
      expect(await redis.get(`rl:tpm:${scope}:4`)).toBeNull();
    }
  });
});
