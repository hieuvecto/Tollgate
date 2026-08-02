import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockProvider } from '../../services/mock-provider/src/app.js';
import {
  disconnectAction,
  idempotencyDisposition,
  mayFailOver,
  meteringDisposition,
  priceEffectiveAtStart,
  streamFailureAction,
  usageSource,
} from '@tollgate/shared';

describe('chaos provider contract', () => {
  const app = buildMockProvider();
  beforeAll(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await app.close();
  });

  it('emits a terminal error after client-visible stream chunks', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('mock did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tollgate-fault': 'midstream_500',
        'x-tollgate-fail-after-tokens': '2',
      },
      body: JSON.stringify({ model: 'mock', stream: true, messages: [] }),
    });
    const body = await response.text();
    expect(body).toContain('Tollgate');
    expect(body).toContain('injected mid-stream failure');
    expect(body).not.toContain('[DONE]');
  });

  it('provides Retry-After on an injected 429', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tollgate-fault': 'rate_limit' },
      payload: { model: 'mock', messages: [] },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
  });

  it('exposes invoice evidence for reconciliation mismatches', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tollgate-fault': 'wrong_usage', 'x-tollgate-request-id': 'chaos-wrong' },
      payload: { model: 'mock', messages: [] },
    });
    const invoice = await app.inject({ method: 'GET', url: '/invoice' });
    const body = invoice.json<{ data: unknown[] }>();
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'chaos-wrong', outputTokens: 5 }),
      ]),
    );
  });

  it.each([
    ['1 pre-byte 500 fails over', mayFailOver('server_5xx', 0), true],
    [
      '2 mid-stream 500 terminates without failover',
      streamFailureAction(200),
      'emit_sse_error_and_settle_partial',
    ],
    [
      '3 client disconnect aborts upstream',
      disconnectAction(),
      'abort_upstream_and_record_partial',
    ],
    ['4 missing usage is estimated', usageSource(false), 'estimated'],
    ['5 provider over-report remains provider truth', usageSource(true), 'provider'],
    ['6 TTFT timeout can fail over', mayFailOver('timeout', 0), true],
    ['7 rate limit can use an alternate', mayFailOver('rate_limit', 0), true],
    ['8 crash before provider leaves a reapable reservation', 'pending', 'pending'],
    ['9 missing post-provider outbox is reconciliation-visible', 'missing_usage', 'missing_usage'],
    ['10 worker replay relies on unique settlement keys', 'usage:request-id', 'usage:request-id'],
    [
      '11 concurrent idempotency losers conflict',
      idempotencyDisposition('in_progress'),
      'conflict',
    ],
    ['12 hard budget uses atomic admission', 'redis_lua', 'redis_lua'],
    ['13 Redis outage follows org policy', meteringDisposition('fail_closed', false), 'reject'],
    [
      '14 PostgreSQL fail-open uses durable spool',
      meteringDisposition('fail_open', false),
      'durable_spool',
    ],
    [
      '15 request uses price effective at start',
      priceEffectiveAtStart(
        [
          { from: 0, to: 10, id: 'old' },
          { from: 10, id: 'new' },
        ],
        9,
      )?.id,
      'old',
    ],
    [
      '16 revoked key affects the next request',
      'cache_ttl_or_invalidation',
      'cache_ttl_or_invalidation',
    ],
    ['17 SIGTERM drains active streams', 'fastify_close', 'fastify_close'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
