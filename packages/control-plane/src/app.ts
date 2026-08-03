import Fastify, { type FastifyRequest } from 'fastify';
import { query, transaction } from '@tollgate/db';
import type { PoolClient } from 'pg';
import {
  createLogger,
  decodeProviderCredentialKek,
  issueSecret,
  loadConfig,
  moneyJson,
  openAiError,
  secretPrefix,
  sealSecret,
  secretFingerprint,
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
  if (!prefix?.startsWith('tg_admin_')) {
    throw new TollgateError(401, 'invalid_token', 'Invalid control-plane token');
  }
  const result = await query<Record<string, unknown>>(
    `SELECT t.user_id,t.token_hash,t.status,u.org_id,array_agg(DISTINCT m.role) roles FROM control_plane_tokens t JOIN users u ON u.id=t.user_id JOIN memberships m ON m.user_id=u.id WHERE t.token_prefix=$1 GROUP BY t.user_id,t.token_hash,t.status,u.org_id`,
    [prefix],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.status !== 'active' ||
    !verifySecret(secret, String(row.token_hash), config.KEY_PEPPER)
  ) {
    throw new TollgateError(401, 'invalid_token', 'Invalid control-plane token');
  }
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

async function requireTeamInOrg(teamId: string, orgId: string): Promise<void> {
  const team = await query('SELECT 1 FROM teams WHERE id=$1 AND org_id=$2', [teamId, orgId]);
  if (!team.rowCount) throw new TollgateError(404, 'team_not_found', 'Team not found');
}

async function requireProvider(providerId: string): Promise<void> {
  const provider = await query('SELECT 1 FROM providers WHERE id=$1 AND enabled', [providerId]);
  if (!provider.rowCount) throw new TollgateError(404, 'provider_not_found', 'Provider not found');
}

async function appendAdminAudit(
  client: PoolClient,
  authenticated: Actor,
  action: string,
  targetType: string,
  targetId: string,
  changes: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_log(org_id,actor_user_id,action,target_type,target_id,changes,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      authenticated.orgId,
      authenticated.userId,
      action,
      targetType,
      targetId,
      JSON.stringify(changes),
      requestId,
    ],
  );
}

export function buildControlPlane() {
  const actors = new WeakMap<FastifyRequest, Actor>();
  const allow =
    (...roles: Role[]) =>
    async (request: FastifyRequest) => {
      const authenticated = await actor(request);
      if (!authenticated.roles.some((role) => roles.includes(role))) {
        throw new TollgateError(403, 'forbidden', 'Role does not permit this operation');
      }
      actors.set(request, authenticated);
    };
  const actorFor = (request: FastifyRequest): Actor => {
    const authenticated = actors.get(request);
    if (!authenticated) throw new Error('Authenticated actor missing from request context');
    return authenticated;
  };
  const app = Fastify({ loggerInstance: createLogger(), disableRequestLogging: true });
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    const known =
      error instanceof TollgateError
        ? error
        : new TollgateError(500, 'internal_error', 'Internal control-plane error');
    void reply.code(known.status).send(openAiError(known));
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get(
    '/admin/org',
    { preHandler: allow('owner', 'admin', 'member', 'billing_viewer') },
    async (request) => {
      const a = actorFor(request);
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
      const a = actorFor(request);
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
    const a = actorFor(request);
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
    const a = actorFor(request);
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
      const a = actorFor(request);
      if (request.body.teamId) await requireTeamInOrg(request.body.teamId, a.orgId);
      const issued = issueSecret('tg_live', config.KEY_PEPPER);
      const created = await transaction(async (client) => {
        const result = await client.query<{ id: string }>(
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
        await appendAdminAudit(
          client,
          a,
          'api_key.create',
          'api_key',
          result.rows[0]!.id,
          {
            teamId: request.body.teamId ?? null,
            name: request.body.name,
            scopes: request.body.scopes,
            prefix: issued.prefix,
          },
          request.id,
        );
        return result;
      });
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
      const a = actorFor(request);
      const keyPrefix = await transaction(async (client) => {
        const result = await client.query<{ key_prefix: string }>(
          `UPDATE api_keys SET status='revoked',revoked_at=now() WHERE id=$1 AND org_id=$2 AND status='active' RETURNING key_prefix`,
          [request.params.id, a.orgId],
        );
        if (!result.rowCount) throw new TollgateError(404, 'not_found', 'Active API key not found');
        await appendAdminAudit(
          client,
          a,
          'api_key.revoke',
          'api_key',
          request.params.id,
          { status: 'revoked', prefix: result.rows[0]!.key_prefix },
          request.id,
        );
        return result.rows[0]!.key_prefix;
      });
      await redis.del(`policy:${keyPrefix}`);
      return { revoked: true, maximumRevocationLagSeconds: config.POLICY_CACHE_TTL_SECONDS };
    },
  );
  app.get(
    '/admin/budgets',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async (request) => {
      const a = actorFor(request);
      const rows = await query<Record<string, unknown>>('SELECT * FROM budgets WHERE org_id=$1', [
        a.orgId,
      ]);
      return { data: rows.rows.map((row) => ({ ...row, limit_micros: String(row.limit_micros) })) };
    },
  );
  app.put<{
    Body: { teamId?: string; period: 'day' | 'month'; limitMicros: string; hardStop: boolean };
  }>('/admin/budgets', { preHandler: allow('owner', 'admin') }, async (request) => {
    const a = actorFor(request);
    if (request.body.teamId) await requireTeamInOrg(request.body.teamId, a.orgId);
    const limitMicros = BigInt(request.body.limitMicros).toString();
    await transaction(async (client) => {
      const budget = await client.query<{ id: string }>(
        `INSERT INTO budgets(org_id,team_id,period,limit_micros,hard_stop) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,team_id,period) DO UPDATE SET limit_micros=EXCLUDED.limit_micros,hard_stop=EXCLUDED.hard_stop RETURNING id`,
        [
          a.orgId,
          request.body.teamId ?? null,
          request.body.period,
          limitMicros,
          request.body.hardStop,
        ],
      );
      await appendAdminAudit(
        client,
        a,
        'budget.upsert',
        'budget',
        budget.rows[0]!.id,
        {
          teamId: request.body.teamId ?? null,
          period: request.body.period,
          limitMicros,
          hardStop: request.body.hardStop,
        },
        request.id,
      );
    });
    return { updated: true };
  });
  app.put<{ Body: { strategy: string; rpmLimit: number; tpmLimit: number } }>(
    '/admin/routing-policy',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = actorFor(request);
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,$2,$3,$4) ON CONFLICT(org_id) DO UPDATE SET strategy=EXCLUDED.strategy,rpm_limit=EXCLUDED.rpm_limit,tpm_limit=EXCLUDED.tpm_limit`,
          [a.orgId, request.body.strategy, request.body.rpmLimit, request.body.tpmLimit],
        );
        await appendAdminAudit(
          client,
          a,
          'routing_policy.upsert',
          'organization',
          a.orgId,
          {
            strategy: request.body.strategy,
            rpmLimit: request.body.rpmLimit,
            tpmLimit: request.body.tpmLimit,
          },
          request.id,
        );
      });
      return { updated: true };
    },
  );
  app.get('/admin/providers', { preHandler: allow('owner', 'admin', 'member') }, async () => ({
    data: (await query('SELECT id,name,kind,base_url,enabled FROM providers ORDER BY name')).rows,
  }));
  app.get(
    '/admin/provider-credentials',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = actorFor(request);
      return {
        data: (
          await query(
            `SELECT provider_id,secret_fingerprint,status,key_version,created_at,updated_at,revoked_at FROM provider_credentials WHERE org_id=$1 ORDER BY created_at`,
            [a.orgId],
          )
        ).rows,
      };
    },
  );
  app.put<{ Params: { providerId: string }; Body: { apiKey?: string } }>(
    '/admin/provider-credentials/:providerId',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = actorFor(request);
      if (!request.body.apiKey || request.body.apiKey.length < 8) {
        throw new TollgateError(
          400,
          'invalid_request_error',
          'Provider apiKey must be at least 8 characters',
        );
      }
      await requireProvider(request.params.providerId);
      let kek: Buffer;
      try {
        kek = decodeProviderCredentialKek(config.PROVIDER_CREDENTIAL_KEK);
      } catch {
        throw new TollgateError(
          503,
          'credential_encryption_unavailable',
          'Provider credential encryption is not configured',
        );
      }
      const context = `${a.orgId}:${request.params.providerId}`;
      const sealed = sealSecret(request.body.apiKey, kek, context);
      const fingerprint = secretFingerprint(request.body.apiKey);
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO provider_credentials(org_id,provider_id,encrypted_secret,secret_iv,secret_tag,wrapped_dek,wrap_iv,wrap_tag,key_version,secret_fingerprint,status,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)
           ON CONFLICT(org_id,provider_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,secret_iv=EXCLUDED.secret_iv,secret_tag=EXCLUDED.secret_tag,wrapped_dek=EXCLUDED.wrapped_dek,wrap_iv=EXCLUDED.wrap_iv,wrap_tag=EXCLUDED.wrap_tag,key_version=EXCLUDED.key_version,secret_fingerprint=EXCLUDED.secret_fingerprint,status='active',updated_at=now(),revoked_at=NULL`,
          [
            a.orgId,
            request.params.providerId,
            Buffer.from(sealed.ciphertext, 'base64'),
            Buffer.from(sealed.secretIv, 'base64'),
            Buffer.from(sealed.secretTag, 'base64'),
            Buffer.from(sealed.wrappedDek, 'base64'),
            Buffer.from(sealed.wrapIv, 'base64'),
            Buffer.from(sealed.wrapTag, 'base64'),
            sealed.keyVersion,
            fingerprint,
            a.userId,
          ],
        );
        await appendAdminAudit(
          client,
          a,
          'provider_credential.rotate',
          'provider',
          request.params.providerId,
          { fingerprint, keyVersion: sealed.keyVersion, status: 'active' },
          request.id,
        );
      });
      return { providerId: request.params.providerId, fingerprint, status: 'active' };
    },
  );
  app.delete<{ Params: { providerId: string } }>(
    '/admin/provider-credentials/:providerId',
    { preHandler: allow('owner', 'admin') },
    async (request) => {
      const a = actorFor(request);
      await transaction(async (client) => {
        const result = await client.query(
          `UPDATE provider_credentials SET status='revoked',revoked_at=now(),updated_at=now() WHERE org_id=$1 AND provider_id=$2 AND status='active'`,
          [a.orgId, request.params.providerId],
        );
        if (!result.rowCount) {
          throw new TollgateError(404, 'credential_not_found', 'Active credential not found');
        }
        await appendAdminAudit(
          client,
          a,
          'provider_credential.revoke',
          'provider',
          request.params.providerId,
          { status: 'revoked' },
          request.id,
        );
      });
      return { revoked: true };
    },
  );
  app.get(
    '/admin/audit-log',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async (request) => {
      const a = actorFor(request);
      return {
        data: (
          await query(
            `SELECT id,actor_user_id,action,target_type,target_id,changes,request_id,created_at FROM admin_audit_log WHERE org_id=$1 ORDER BY created_at DESC LIMIT 200`,
            [a.orgId],
          )
        ).rows,
      };
    },
  );
  app.get('/admin/models', { preHandler: allow('owner', 'admin', 'member') }, async () => ({
    data: (
      await query(
        `SELECT m.*,json_agg(json_build_object('provider_id',pb.provider_id,'provider_model_name',pb.provider_model_name,'priority',pb.priority)) bindings FROM models m LEFT JOIN provider_bindings pb ON pb.model_id=m.id GROUP BY m.id ORDER BY m.public_name`,
      )
    ).rows,
  }));
  app.get<{ Querystring: { groupBy?: string; from?: string; to?: string; format?: string } }>(
    '/reports/spend',
    { preHandler: allow('owner', 'admin', 'billing_viewer') },
    async (request, reply) => {
      const a = actorFor(request);
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
      if (request.query.format === 'csv') {
        return reply
          .type('text/csv')
          .send(
            `bucket,amount_micros\n${rows.rows.map((row) => `${row.bucket},${row.amount_micros}`).join('\n')}\n`,
          );
      }
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
