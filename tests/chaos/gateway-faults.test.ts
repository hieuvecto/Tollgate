import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueSecret } from '@tollgate/shared';
import { query } from '@tollgate/db';
import { buildMockProvider } from '../../services/mock-provider/src/app.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const pepper = 'integration-only-pepper-value';

interface TenantFixture {
  orgId: string;
  teamId: string;
  keyId: string;
  key: string;
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

suite('gateway fault and accounting contracts', () => {
  const mock = buildMockProvider();
  let gateway: FastifyInstance;
  let settleBatch: (batchSize?: number) => Promise<number>;
  let closeWorkerResources: () => Promise<void>;
  let gatewayUrl = '';
  let mockUrl = '';
  let publicModel = '';
  let standard: TenantFixture;
  let rateLimited: TenantFixture;
  let budgetLimited: TenantFixture;

  const makeTenant = async (
    label: string,
    rpm: number,
    budgetMicros: bigint,
  ): Promise<TenantFixture> => {
    const orgId = randomUUID();
    const teamId = randomUUID();
    const keyId = randomUUID();
    const issued = issueSecret('tg_live', pepper);
    await query(`INSERT INTO orgs(id,name) VALUES($1,$2)`, [orgId, `integration-${label}`]);
    await query(`INSERT INTO teams(id,org_id,name) VALUES($1,$2,$3)`, [
      teamId,
      orgId,
      `integration-${label}`,
    ]);
    await query(
      `INSERT INTO api_keys(id,org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        keyId,
        orgId,
        teamId,
        `integration-${label}`,
        issued.prefix,
        issued.hash,
        JSON.stringify({ models: [publicModel], endpoints: ['chat'] }),
      ],
    );
    await query(
      `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,'failover_order',$2,1000000)`,
      [orgId, rpm],
    );
    await query(
      `INSERT INTO budgets(org_id,period,limit_micros,hard_stop) VALUES($1,'month',$2,true)`,
      [orgId, budgetMicros.toString()],
    );
    return { orgId, teamId, keyId, key: issued.plaintext };
  };

  const chat = async (
    tenant: TenantFixture,
    options: {
      headers?: Record<string, string>;
      stream?: boolean;
      idempotencyKey?: string;
      maxTokens?: number;
    } = {},
  ) =>
    fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenant.key}`,
        'content-type': 'application/json',
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        model: publicModel,
        messages: [{ role: 'user', content: 'integration request' }],
        ...(options.stream ? { stream: true } : {}),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      }),
    });

  beforeAll(async () => {
    process.env.KEY_PEPPER = pepper;
    await mock.listen({ host: '127.0.0.1', port: 0 });
    const mockAddress = mock.server.address();
    if (!mockAddress || typeof mockAddress === 'string') throw new Error('mock did not bind');

    const modelId = randomUUID();
    const pricingId = randomUUID();
    const firstProviderId = randomUUID();
    const secondProviderId = randomUUID();
    publicModel = `integration-${randomUUID()}`;
    mockUrl = `http://127.0.0.1:${mockAddress.port}`;
    await query(
      `INSERT INTO providers(id,name,kind,base_url) VALUES($1,$2,'mock',$3),($4,$5,'openai_compatible',$3)`,
      [
        firstProviderId,
        `integration-primary-${randomUUID()}`,
        mockUrl,
        secondProviderId,
        `integration-secondary-${randomUUID()}`,
      ],
    );
    await query(
      `INSERT INTO models(id,public_name,context_window,default_max_output_tokens) VALUES($1,$2,8192,16)`,
      [modelId, publicModel],
    );
    await query(
      `INSERT INTO model_pricing(id,model_id,input_per_mtok,output_per_mtok,cached_input_per_mtok,effective_from) VALUES($1,$2,1000000,2000000,250000,'2020-01-01')`,
      [pricingId, modelId],
    );
    await query(
      `INSERT INTO provider_bindings(model_id,provider_id,provider_model_name,priority) VALUES($1,$2,'mock-primary',1),($1,$3,'mock-secondary',2)`,
      [modelId, firstProviderId, secondProviderId],
    );
    standard = await makeTenant('standard', 1000, 1_000_000_000n);
    rateLimited = await makeTenant('rate', 1, 1_000_000_000n);
    budgetLimited = await makeTenant('budget', 1000, 1n);

    const gatewayModule = await import('../../packages/gateway/src/app.js');
    const workerModule = await import('../../packages/worker/src/settlement.js');
    gateway = gatewayModule.buildGateway();
    settleBatch = workerModule.settleBatch;
    closeWorkerResources = workerModule.closeWorkerResources;
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();
    if (!gatewayAddress || typeof gatewayAddress === 'string')
      throw new Error('gateway did not bind');
    gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
  });

  afterAll(async () => {
    await gateway.close();
    await closeWorkerResources?.();
    await mock.close();
  });

  it('replays a completed idempotent request and rejects an in-progress duplicate', async () => {
    const replayKey = `replay-${randomUUID()}`;
    const first = await chat(standard, { idempotencyKey: replayKey, maxTokens: 4 });
    expect(first.status).toBe(200);
    const firstBody: unknown = await first.json();
    const replay = await chat(standard, { idempotencyKey: replayKey, maxTokens: 4 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const conflictKey = `conflict-${randomUUID()}`;
    const requests = await Promise.all([
      chat(standard, {
        idempotencyKey: conflictKey,
        headers: { 'x-tollgate-ttft-ms': '100' },
      }),
      chat(standard, {
        idempotencyKey: conflictKey,
        headers: { 'x-tollgate-ttft-ms': '100' },
      }),
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('settles provider usage exactly once and releases the reservation', async () => {
    const response = await chat(standard, { maxTokens: 8 });
    expect(response.status).toBe(200);
    const requestId = response.headers.get('x-tollgate-request-id');
    expect(requestId).toBeTruthy();
    await settleBatch(100);
    const facts = await query<Record<string, unknown>>(
      `SELECT u.source,u.input_tokens,u.output_tokens,l.kind,l.amount_micros,r.status reservation_status FROM usage_events u JOIN ledger_entries l ON l.request_id=u.request_id JOIN reservations r ON r.request_id=u.request_id WHERE u.request_id=$1`,
      [requestId],
    );
    expect(facts.rows).toEqual([
      expect.objectContaining({
        source: 'provider',
        output_tokens: 3,
        kind: 'charge',
        reservation_status: 'settled',
      }),
    ]);
    await settleBatch(100);
    const charges = await query<{ count: string }>(
      `SELECT count(*)::text count FROM ledger_entries WHERE request_id=$1 AND kind='charge'`,
      [requestId],
    );
    expect(charges.rows[0]?.count).toBe('1');
  });

  it('records provider-authoritative usage from a successful stream', async () => {
    const response = await chat(standard, { stream: true, maxTokens: 8 });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('[DONE]');
    const requestId = response.headers.get('x-tollgate-request-id');
    expect(requestId).toBeTruthy();
    await eventually(async () => {
      const outbox = await query<{ payload: { source: string; outputTokens: number } }>(
        `SELECT payload FROM outbox WHERE dedupe_key=$1`,
        [`usage:${requestId}`],
      );
      expect(outbox.rows[0]?.payload).toMatchObject({ source: 'provider', outputTokens: 3 });
    });
  });

  it('settles observed output as estimated usage after a mid-stream failure', async () => {
    const response = await chat(standard, {
      stream: true,
      maxTokens: 8,
      headers: { 'x-tollgate-fault': 'midstream_500', 'x-tollgate-fail-after-tokens': '2' },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('injected mid-stream failure');
    expect(body).not.toContain('[DONE]');
    const requestId = response.headers.get('x-tollgate-request-id');
    expect(requestId).toBeTruthy();
    await eventually(async () => {
      const recorded = await query<{
        status: string;
        payload: { source: string; outputTokens: number };
      }>(
        `SELECT r.status,o.payload FROM requests r JOIN outbox o ON o.dedupe_key='usage:'||r.id::text WHERE r.id=$1`,
        [requestId],
      );
      expect(recorded.rows[0]).toMatchObject({
        status: 'failed',
        payload: { source: 'estimated' },
      });
      expect(recorded.rows[0]!.payload.outputTokens).toBeGreaterThan(0);
    });
  });

  it('fails over only before client-visible bytes', async () => {
    const response = await chat(standard, {
      maxTokens: 4,
      headers: { 'x-tollgate-fault': 'pre_500' },
    });
    expect(response.status).toBe(200);
    const requestId = response.headers.get('x-tollgate-request-id');
    const request = await query<{ attempt_count: number }>(
      `SELECT attempt_count FROM requests WHERE id=$1`,
      [requestId],
    );
    expect(Number(request.rows[0]?.attempt_count)).toBe(2);
  });

  it('enforces rate-limit rejection through the HTTP surface', async () => {
    expect((await chat(rateLimited, { maxTokens: 1 })).status).toBe(200);
    const rejected = await chat(rateLimited, { maxTokens: 1 });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBeTruthy();
  });

  it('enforces a hard budget before invoking the provider', async () => {
    const before = ((await (await fetch(`${mockUrl}/invoice`)).json()) as { data: unknown[] }).data
      .length;
    const response = await chat(budgetLimited, { maxTokens: 1 });
    expect(response.status).toBe(402);
    const invoice = (await (await fetch(`${mockUrl}/invoice`)).json()) as {
      data: unknown[];
    };
    expect(invoice.data).toHaveLength(before);
  });

  it('aborts the upstream request when a streaming client disconnects', async () => {
    const url = new URL('/v1/chat/completions', gatewayUrl);
    const requestId = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${standard.key}`,
            'content-type': 'application/json',
            'x-tollgate-token-delay-ms': '500',
          },
        },
        (response) => {
          const tollgateRequestId = String(response.headers['x-tollgate-request-id'] ?? '');
          response.once('data', () => {
            response.destroy();
            request.destroy();
            resolve(tollgateRequestId);
          });
        },
      );
      request.once('error', (error) => {
        if (!request.destroyed) reject(error);
      });
      request.end(
        JSON.stringify({
          model: publicModel,
          stream: true,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'disconnect' }],
        }),
      );
    });
    expect(requestId).toBeTruthy();
    await eventually(async () => {
      const result = await query<{ status: string }>(`SELECT status FROM requests WHERE id=$1`, [
        requestId,
      ]);
      expect(result.rows[0]?.status).toBe('client_aborted');
    });
  });
});
