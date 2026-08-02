import { describe, expect, it } from 'vitest';
import { singleFlight } from '../../packages/worker/src/loop.js';

describe('worker loop', () => {
  it('skips overlapping ticks and runs again after completion', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const task = async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const tick = singleFlight(task, () => undefined);
    const first = tick();
    await expect(tick()).resolves.toBe(false);
    expect(calls).toBe(1);
    release?.();
    await expect(first).resolves.toBe(true);

    const second = tick();
    release?.();
    await expect(second).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
