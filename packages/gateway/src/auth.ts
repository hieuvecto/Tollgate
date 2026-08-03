import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { query } from '@tollgate/db';
import {
  loadConfig,
  secretPrefix,
  TollgateError,
  verifySecret,
  type MeteringFailurePolicy,
} from '@tollgate/shared';

export interface Principal {
  apiKeyId: string;
  orgId: string;
  teamId: string | null;
  scopes: { models?: string[]; endpoints?: string[] };
  meteringFailure: MeteringFailurePolicy;
}

const config = loadConfig();
export const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

export async function authenticate(request: FastifyRequest): Promise<Principal> {
  const header = request.headers.authorization;
  const secret = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const prefix = secretPrefix(secret);
  if (!prefix?.startsWith('tg_live_')) {
    throw new TollgateError(401, 'invalid_api_key', 'Invalid API key');
  }
  const cacheKey = `policy:${prefix}`;
  let row: Record<string, unknown> | null = null;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) row = JSON.parse(cached) as Record<string, unknown>;
  } catch {
    /* Postgres remains the source of truth. */
  }
  if (!row) {
    const result = await query<Record<string, unknown>>(
      `SELECT k.id AS api_key_id,k.org_id,k.team_id,k.key_hash,k.scopes,k.status,o.on_metering_failure FROM api_keys k JOIN orgs o ON o.id=k.org_id WHERE k.key_prefix=$1`,
      [prefix],
    );
    row = result.rows[0] ?? null;
    if (row) {
      try {
        await redis.set(cacheKey, JSON.stringify(row), 'EX', config.POLICY_CACHE_TTL_SECONDS);
      } catch {
        /* cache optional */
      }
    }
  }
  if (
    !row ||
    row.status !== 'active' ||
    !verifySecret(secret, String(row.key_hash), config.KEY_PEPPER)
  ) {
    throw new TollgateError(401, 'invalid_api_key', 'Invalid API key');
  }
  void query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.api_key_id]).catch(
    () => undefined,
  );
  return {
    apiKeyId: String(row.api_key_id),
    orgId: String(row.org_id),
    teamId: typeof row.team_id === 'string' ? row.team_id : null,
    scopes: row.scopes as Principal['scopes'],
    meteringFailure: row.on_metering_failure as MeteringFailurePolicy,
  };
}
