import { describe, expect, it } from 'vitest';
import { priceTokens } from '@tollgate/shared';

describe('integer money', () => {
  it('prices tokens with bigint micros and rounds up', () => {
    expect(priceTokens(10, 5, 2, 1_000_000n, 2_000_000n, 250_000n)).toBe(19n);
  });
});
