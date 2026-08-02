import { describe, expect, it } from 'vitest';
import { routeBindings } from '../../packages/gateway/src/routing.js';
import type { Catalog } from '../../packages/gateway/src/catalog.js';

const catalog = (strategy: Catalog['strategy']): Catalog => ({
  modelId: 'm',
  publicName: 'm',
  defaultMaxOutput: 10,
  pricingId: 'p',
  inputPrice: 1n,
  outputPrice: 1n,
  cachedPrice: 1n,
  rpm: 1,
  tpm: 1,
  strategy,
  bindings: [
    {
      providerId: 'slow',
      kind: 'mock',
      baseUrl: '',
      providerModel: '',
      priority: 2,
      weight: 1,
      inputCostPerMtok: 5n,
      outputCostPerMtok: 5n,
      ewmaTtftMs: 100,
    },
    {
      providerId: 'fast',
      kind: 'mock',
      baseUrl: '',
      providerModel: '',
      priority: 1,
      weight: 2,
      inputCostPerMtok: 1n,
      outputCostPerMtok: 1n,
      ewmaTtftMs: 10,
    },
  ],
});

describe('provider routing', () => {
  it('orders cheapest, latency, and failover strategies deterministically', () => {
    expect(routeBindings(catalog('cheapest'))[0]!.providerId).toBe('fast');
    expect(routeBindings(catalog('lowest_latency'))[0]!.providerId).toBe('fast');
    expect(routeBindings(catalog('failover_order'))[0]!.providerId).toBe('fast');
  });
});
