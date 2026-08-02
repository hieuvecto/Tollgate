export type ProviderFailure = 'client_4xx' | 'rate_limit' | 'server_5xx' | 'timeout';

export const mayFailOver = (failure: ProviderFailure, clientVisibleBytes: number) =>
  clientVisibleBytes === 0 && failure !== 'client_4xx';

export const streamFailureAction = (clientVisibleBytes: number) =>
  clientVisibleBytes === 0 ? 'retry_alternate' : 'emit_sse_error_and_settle_partial';

export const disconnectAction = () => 'abort_upstream_and_record_partial' as const;
export const usageSource = (providerUsagePresent: boolean) =>
  providerUsagePresent ? ('provider' as const) : ('estimated' as const);
export const idempotencyDisposition = (status: string | undefined) =>
  status === undefined ? 'start' : status === 'succeeded' ? 'replay' : 'conflict';
export const meteringDisposition = (
  policy: 'fail_open' | 'fail_closed',
  durableStoreAvailable: boolean,
) => (durableStoreAvailable ? 'serve' : policy === 'fail_open' ? 'durable_spool' : 'reject');
export const priceEffectiveAtStart = <T extends { from: number; to?: number }>(
  prices: T[],
  requestStartedAt: number,
) =>
  prices.find(
    (price) =>
      price.from <= requestStartedAt && (price.to === undefined || price.to > requestStartedAt),
  );
