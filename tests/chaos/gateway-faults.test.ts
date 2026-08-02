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
  let modelId = '';
  let pricingId = '';
  let firstProviderId = '';
  let standard: TenantFixture;
  let rateLimited: TenantFixture;
  let budgetLimited: TenantFixture;
  let ledgerLimited: TenantFixture;
  let periodRolled: TenantFixture;
  let concurrentBudget: TenantFixture;

  const makeTenant = async (
    label: string,
    rpm: number,
    budgetMicros: bigint,
    options: { period?: 'day' | 'month'; teamBudgetMicros?: bigint } = {},
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
        JSON.stringify({ models: [publicModel], endpoints: ['chat', 'embeddings'] }),
      ],
    );
    await query(
      `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,'failover_order',$2,1000000)`,
      [orgId, rpm],
    );
    await query(`INSERT INTO budgets(org_id,period,limit_micros,hard_stop) VALUES($1,$2,$3,true)`, [
      orgId,
      options.period ?? 'month',
      budgetMicros.toString(),
    ]);
    if (options.teamBudgetMicros !== undefined)
      await query(
        `INSERT INTO budgets(org_id,team_id,period,limit_micros,hard_stop) VALUES($1,$2,$3,$4,true)`,
        [orgId, teamId, options.period ?? 'month', options.teamBudgetMicros.toString()],
      );
    return { orgId, teamId, keyId, key: issued.plaintext };
  };

  const addHistoricalCharge = async (
    tenant: TenantFixture,
    amountMicros: bigint,
    createdAt: Date,
  ) => {
    const requestId = randomUUID();
    await query(
      `INSERT INTO requests(id,org_id,team_id,api_key_id,model_id,pricing_id,status,provider_id_used,created_at,finalized_at) VALUES($1,$2,$3,$4,$5,$6,'succeeded',$7,$8,$8)`,
      [
        requestId,
        tenant.orgId,
        tenant.teamId,
        tenant.keyId,
        modelId,
        pricingId,
        firstProviderId,
        createdAt,
      ],
    );
    await query(
      `INSERT INTO ledger_entries(org_id,team_id,request_id,amount_micros,kind,pricing_id,created_at) VALUES($1,$2,$3,$4,'charge',$5,$6)`,
      [tenant.orgId, tenant.teamId, requestId, amountMicros.toString(), pricingId, createdAt],
    );
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

    modelId = randomUUID();
    pricingId = randomUUID();
    firstProviderId = randomUUID();
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
    budgetLimited = await makeTenant('budget', 1000, 1_000_000_000n, {
      teamBudgetMicros: 1n,
    });
    ledgerLimited = await makeTenant('ledger-budget', 1000, 50n, { period: 'day' });
    periodRolled = await makeTenant('period-budget', 1000, 50n, { period: 'day' });
    concurrentBudget = await makeTenant('concurrent-budget', 1000, 25n, { period: 'day' });
    await addHistoricalCharge(ledgerLimited, 50n, new Date());
    await addHistoricalCharge(periodRolled, 100n, new Date(Date.now() - 86_400_000));

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
    const firstBody = (await first.json()) as { model: string };
    expect(firstBody.model).toBe(publicModel);
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
    const streamBody = await response.text();
    expect(streamBody).toContain('[DONE]');
    expect(streamBody).toContain(`"model":"${publicModel}"`);
    expect(streamBody).not.toContain('mock-primary');
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
    const accepted = await chat(rateLimited, { maxTokens: 1 });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { usage: { total_tokens: number } };
    const rejected = await chat(rateLimited, { maxTokens: 1 });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBeTruthy();
    const bucket = Math.floor(Date.now() / 60_000);
    for (const scope of [
      `org:${rateLimited.orgId}`,
      `team:${rateLimited.teamId}`,
      `key:${rateLimited.keyId}`,
    ]) {
      expect(
        await (
          await import('../../packages/gateway/src/auth.js')
        ).redis.get(`rl:rpm:${scope}:${bucket}`),
      ).toBe('1');
      expect(
        await (
          await import('../../packages/gateway/src/auth.js')
        ).redis.get(`rl:tpm:${scope}:${bucket}`),
      ).toBe(String(body.usage.total_tokens));
    }
  });

  it('returns a 400 without creating a request for malformed bodies', async () => {
    const before = await query<{ count: string }>(
      `SELECT count(*)::text count FROM requests WHERE api_key_id=$1`,
      [standard.keyId],
    );
    for (const [path, payload] of [
      ['/v1/chat/completions', { model: publicModel }],
      ['/v1/embeddings', { model: publicModel }],
    ] as const) {
      const response = await fetch(`${gatewayUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${standard.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request_error' },
      });
    }
    const after = await query<{ count: string }>(
      `SELECT count(*)::text count FROM requests WHERE api_key_id=$1`,
      [standard.keyId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
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

  it('makes a budget-rejected embedding request terminal', async () => {
    const response = await fetch(`${gatewayUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${budgetLimited.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: publicModel, input: 'budget rejection input' }),
    });
    expect(response.status).toBe(402);
    const request = await query<{ status: string; reservation_status: string }>(
      `SELECT q.status,r.status reservation_status FROM requests q JOIN reservations r ON r.request_id=q.id WHERE q.api_key_id=$1 ORDER BY q.created_at DESC LIMIT 1`,
      [budgetLimited.keyId],
    );
    expect(request.rows[0]).toEqual({ status: 'failed', reservation_status: 'released' });
  });

  it('rebuilds current-period spend from the ledger and ignores a prior period', async () => {
    expect((await chat(ledgerLimited, { maxTokens: 1 })).status).toBe(402);
    expect((await chat(periodRolled, { maxTokens: 1 })).status).toBe(200);
  });

  it('serializes concurrent reservations against the same hard budget', async () => {
    const responses = await Promise.all([
      chat(concurrentBudget, {
        maxTokens: 1,
        headers: { 'x-tollgate-ttft-ms': '100' },
      }),
      chat(concurrentBudget, {
        maxTokens: 1,
        headers: { 'x-tollgate-ttft-ms': '100' },
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
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
