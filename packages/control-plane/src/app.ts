import Fastify, { type FastifyRequest } from 'fastify';
import { query } from '@tollgate/db';
import {
  createLogger,
  issueSecret,
  loadConfig,
  moneyJson,
  openAIError,
  secretPrefix,
  TollgateError,
  verifySecret,
  type Role,
} from '@tollgate/shared';
import { Redis } from 'ioredis';

const config = loadConfig();
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
interface Actor {
  userId: string;
  orgId: string;
  roles: Role[];
}

async function actor(request: FastifyRequest): Promise<Actor> {
  const secret = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : '';
  const prefix = secretPrefix(secret);
  if (!prefix?.startsWith('tg_admin_'))
    throw new TollgateError(401, 'invalid_token', 'Invalid control-plane token');
  const result = await query<Record<string, unknown>>(
    `SELECT t.user_id,t.token_hash,t.status,u.org_id,array_agg(DISTINCT m.role) roles FROM control_plane_tokens t JOIN users u ON u.id=t.user_id JOIN memberships m ON m.user_id=u.id WHERE t.token_prefix=$1 GROUP BY t.user_id,t.token_hash,t.status,u.org_id`,
    [prefix],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.status !== 'active' ||
    !verifySecret(secret, String(row.token_hash), config.KEY_PEPPER)
  )
    throw new TollgateError(401, 'invalid_token', 'Invalid control-plane token');
  return {
    userId: String(row.user_id),
    orgId: String(row.org_id),
    roles:
      typeof row.roles === 'string'
        ? (row.roles
            .replace(/^\{|\}$/g, '')
            .split(',')
            .filter(Boolean) as Role[])
        : (row.roles as Role[]),
  };
}

const allow =
  (...roles: Role[]) =>
  async (request: FastifyRequest) => {
    const authenticated = await actor(request);
    if (!authenticated.roles.some((role) => roles.includes(role)))
      throw new TollgateError(403, 'forbidden', 'Role does not permit this operation');
    return authenticated;
  };

export function buildControlPlane() {
  const app = Fastify({ loggerInstance: createLogger(), disableRequestLogging: true });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const known =
      error instanceof TollgateError
        ? error
        : new TollgateError(500, 'internal_error', 'Internal control-plane error');
    void reply.code(known.status).send(openAIError(known));
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get(
    '/admin/org',
    { preHandler: allow('owner', 'admin', 'member', 'billing_viewer') },
    async (request) => {
      const a = await actor(request);
      return (
        await query(
          'SELECT id,name,on_metering_failure,prompt_logging,prompt_retention_days,created_at FROM orgs WHERE id=$1',
          [a.orgId],
        )
      ).rows[0];
    },
  );
  app.get(
    '/admin/teams',
    { preHandler: allow('owner', 'admin', 'member', 'billing_viewer') },
    async (request) => {
      const a = await actor(request);
      return {
        data: (
          await query('SELECT id,name,created_at FROM teams WHERE org_id=$1 ORDER BY name', [
            a.orgId,
          ])
        ).rows,
      };
    },
  );
  app.get('/admin/memberships', { preHandler: allow('owner', 'admin') }, async (request) => {
    const a = await actor(request);
    return {
      data: (
        await query(
          `SELECT u.email,t.name team,m.role FROM memberships m JOIN users u ON u.id=m.user_id JOIN teams t ON t.id=m.team_id WHERE u.org_id=$1`,
          [a.orgId],
        )
      ).rows,
    };
  });
  app.get('/admin/api-keys', { preHandler: allow('owner', 'admin') }, async (request) => {
    const a = await actor(request);
    return {
      data: (
        await query(
          'SELECT id,team_id,name,key_prefix,scopes,status,last_used_at,created_at,revoked_at FROM api_keys WHERE org_id=$1',
          [a.orgId],
        )
      ).rows,
    };
  });
  app.post<{ Body: { teamId?: string; name: string; scopes: unknown } }>(
    '/admin/api-keys',
    { preHandler: allow('owner', 'admin') },
    async (request, reply) => {
      const a = await actor(request);
      const issued = issueSecret('tg_live', config.KEY_PEPPER);
      const created = await query<{ id: string }>(
        `INSERT INTO api_keys(org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          a.orgId,
          request.body.teamId ?? null,
          request.body.name,
          issued.prefix,
          issued.hash,
          JSON.stringify(request.body.scopes),
        ],
      );
      return reply.code(201).send({
        id: created.rows[0]!.id,
        key: issued.plaintext,
        prefix: issued.prefix,
        warning: 'This key is shown exactly once.',
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/admin/api-keys/:id/revoke',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = await actor(request);
      const result = await query<{ key_prefix: string }>(
        `UPDATE api_keys SET status='revoked',revoked_at=now() WHERE id=$1 AND org_id=$2 AND status='active' RETURNING key_prefix`,
        [request.params.id, a.orgId],
      );
      if (!result.rowCount) throw new TollgateError(404, 'not_found', 'Active API key not found');
      await redis.del(`policy:${result.rows[0]!.key_prefix}`);
      return { revoked: true, maximumRevocationLagSeconds: config.POLICY_CACHE_TTL_SECONDS };
    },
  );
  app.get(
    '/admin/budgets',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async (request) => {
      const a = await actor(request);
      const rows = await query<Record<string, unknown>>('SELECT * FROM budgets WHERE org_id=$1', [
        a.orgId,
      ]);
      return { data: rows.rows.map((row) => ({ ...row, limit_micros: String(row.limit_micros) })) };
    },
  );
  app.put<{
    Body: { teamId?: string; period: 'day' | 'month'; limitMicros: string; hardStop: boolean };
  }>('/admin/budgets', { preHandler: allow('owner', 'admin') }, async (request) => {
    const a = await actor(request);
    await query(
      `INSERT INTO budgets(org_id,team_id,period,limit_micros,hard_stop) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,team_id,period) DO UPDATE SET limit_micros=EXCLUDED.limit_micros,hard_stop=EXCLUDED.hard_stop`,
      [
        a.orgId,
        request.body.teamId ?? null,
        request.body.period,
        BigInt(request.body.limitMicros).toString(),
        request.body.hardStop,
      ],
    );
    return { updated: true };
  });
  app.put<{ Body: { strategy: string; rpmLimit: number; tpmLimit: number } }>(
    '/admin/routing-policy',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = await actor(request);
      await query(
        `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,$2,$3,$4) ON CONFLICT(org_id) DO UPDATE SET strategy=EXCLUDED.strategy,rpm_limit=EXCLUDED.rpm_limit,tpm_limit=EXCLUDED.tpm_limit`,
        [a.orgId, request.body.strategy, request.body.rpmLimit, request.body.tpmLimit],
      );
      return { updated: true };
    },
  );
  app.get('/admin/providers', { preHandler: allow('owner', 'admin', 'member') }, async () => ({
    data: (await query('SELECT id,name,kind,base_url,enabled FROM providers ORDER BY name')).rows,
  }));
  app.get('/admin/models', { preHandler: allow('owner', 'admin', 'member') }, async () => ({
    data: (
      await query(
        `SELECT m.*,json_agg(json_build_object('provider_id',pb.provider_id,'provider_model_name',pb.provider_model_name,'priority',pb.priority)) bindings FROM models m LEFT JOIN provider_bindings pb ON pb.model_id=m.id GROUP BY m.id ORDER BY m.public_name`,
      )
    ).rows,
  }));
  app.post<{
    Body: {
      modelId: string;
      inputPerMtok: string;
      outputPerMtok: string;
      cachedInputPerMtok: string;
      effectiveFrom: string;
    };
  }>('/admin/pricing', { preHandler: allow('owner') }, async (request, reply) => {
    const b = request.body;
    const row = await query<{ id: string }>(
      `INSERT INTO model_pricing(model_id,input_per_mtok,output_per_mtok,cached_input_per_mtok,effective_from) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [
        b.modelId,
        BigInt(b.inputPerMtok).toString(),
        BigInt(b.outputPerMtok).toString(),
        BigInt(b.cachedInputPerMtok).toString(),
        b.effectiveFrom,
      ],
    );
    return reply.code(201).send(row.rows[0]);
  });
  app.get<{ Querystring: { groupBy?: string; from?: string; to?: string; format?: string } }>(
    '/reports/spend',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async (request, reply) => {
      const a = await actor(request);
      const allowed: Record<string, string> = {
        org: 'l.org_id',
        team: 'l.team_id',
        key: 'r.api_key_id',
        model: 'r.model_id',
        day: `date_trunc('day',l.created_at)`,
      };
      const expression = allowed[request.query.groupBy ?? 'day'] ?? allowed.day!;
      const rows = await query<{ bucket: string; amount_micros: string }>(
        `SELECT ${expression}::text bucket,SUM(l.amount_micros)::text amount_micros FROM ledger_entries l JOIN requests r ON r.id=l.request_id WHERE l.org_id=$1 AND l.created_at>=COALESCE($2::timestamptz,'epoch') AND l.created_at<COALESCE($3::timestamptz,'infinity') GROUP BY ${expression} ORDER BY ${expression}`,
        [a.orgId, request.query.from ?? null, request.query.to ?? null],
      );
      if (request.query.format === 'csv')
        return reply
          .type('text/csv')
          .send(
            `bucket,amount_micros\n${rows.rows.map((row) => `${row.bucket},${row.amount_micros}`).join('\n')}\n`,
          );
      return {
        data: rows.rows.map((row) => ({
          bucket: row.bucket,
          amountMicros: moneyJson(BigInt(row.amount_micros)),
        })),
      };
    },
  );
  app.get(
    '/reports/reconciliation',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async () => ({
      data: (await query('SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT 100'))
        .rows,
    }),
  );
  app.addHook('onClose', async () => {
    await redis.quit();
  });
  return app;
}
