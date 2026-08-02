import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reserveBudget } from '../../packages/gateway/src/limits.js';
import { redis } from '../../packages/gateway/src/auth.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

suite('atomic Redis admission', () => {
  const org = randomUUID();
  afterAll(async () => {
    await redis.del(`budget:spent:${org}`, `budget:reserved:${org}`);
    await redis.quit();
  });

  it('admits only the requests covered by a hard budget under concurrency', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => reserveBudget(org, 300n, 10n, true)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(30);
    expect(await redis.get(`budget:reserved:${org}`)).toBe('300');
  });
});
