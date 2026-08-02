import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueSecret } from '@tollgate/shared';
import { pool, query } from '@tollgate/db';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const pepper = 'control-plane-test-pepper';

suite('control-plane tenant boundaries', () => {
  let app: FastifyInstance;
  let token = '';
  let orgId = '';
  let ownTeamId = '';
  let foreignTeamId = '';
  let providerId = '';

  const headers = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.KEY_PEPPER = pepper;
    process.env.PROVIDER_CREDENTIAL_KEK = Buffer.alloc(32, 9).toString('base64');
    orgId = randomUUID();
    ownTeamId = randomUUID();
    foreignTeamId = randomUUID();
    const foreignOrgId = randomUUID();
    const userId = randomUUID();
    const issued = issueSecret('tg_admin', pepper);
    token = issued.plaintext;
    await query(`INSERT INTO orgs(id,name) VALUES($1,$2),($3,$4)`, [
      orgId,
      `control-${orgId}`,
      foreignOrgId,
      `control-${foreignOrgId}`,
    ]);
    await query(`INSERT INTO teams(id,org_id,name) VALUES($1,$2,'own'),($3,$4,'foreign')`, [
      ownTeamId,
      orgId,
      foreignTeamId,
      foreignOrgId,
    ]);
    await query(`INSERT INTO users(id,org_id,email) VALUES($1,$2,$3)`, [
      userId,
      orgId,
      `owner-${userId}@tollgate.local`,
    ]);
    await query(`INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,'owner')`, [
      userId,
      ownTeamId,
    ]);
    await query(
      `INSERT INTO control_plane_tokens(user_id,token_prefix,token_hash) VALUES($1,$2,$3)`,
      [userId, issued.prefix, issued.hash],
    );
    providerId = randomUUID();
    await query(
      `INSERT INTO providers(id,name,kind,base_url) VALUES($1,$2,'openai','https://provider.invalid')`,
      [providerId, `byok-${providerId}`],
    );
    app = (await import('../../packages/control-plane/src/app.js')).buildControlPlane();
  });

  afterAll(async () => {
    await app.close();
    await pool().end();
  });

  it('rejects API-key creation for a team from another organization', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: headers(),
      payload: { teamId: foreignTeamId, name: 'cross-tenant', scopes: {} },
    });
    expect(response.statusCode).toBe(404);
    expect(
      (
        await query<{ count: string }>(
          `SELECT count(*)::text count FROM api_keys WHERE org_id=$1 AND team_id=$2`,
          [orgId, foreignTeamId],
        )
      ).rows[0]?.count,
    ).toBe('0');
  });

  it('rejects budget mutation for a team from another organization', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/budgets',
      headers: headers(),
      payload: {
        teamId: foreignTeamId,
        period: 'month',
        limitMicros: '1000',
        hardStop: true,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('allows a team-scoped key for the authenticated organization without storing plaintext', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: headers(),
      payload: { teamId: ownTeamId, name: 'own-team', scopes: {} },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; key: string }>();
    const stored = await query<{ key_hash: string }>(`SELECT key_hash FROM api_keys WHERE id=$1`, [
      body.id,
    ]);
    expect(stored.rows[0]?.key_hash).not.toBe(body.key);
  });

  it('does not expose global pricing mutation to tenant owners', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/pricing',
      headers: headers(),
      payload: {
        modelId: randomUUID(),
        inputPerMtok: '1',
        outputPerMtok: '1',
        cachedInputPerMtok: '1',
        effectiveFrom: new Date().toISOString(),
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('stores an organization provider credential only as envelope ciphertext', async () => {
    const plaintext = randomBytes(24).toString('base64url');
    const response = await app.inject({
      method: 'PUT',
      url: `/admin/provider-credentials/${providerId}`,
      headers: headers(),
      payload: { apiKey: plaintext },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(plaintext);
    const stored = await query<{
      encrypted_secret: string;
      wrapped_dek: string;
      secret_fingerprint: string;
    }>(
      `SELECT encode(encrypted_secret,'base64') encrypted_secret,encode(wrapped_dek,'base64') wrapped_dek,secret_fingerprint FROM provider_credentials WHERE org_id=$1 AND provider_id=$2`,
      [orgId, providerId],
    );
    expect(stored.rows[0]?.encrypted_secret).not.toContain(plaintext);
    expect(stored.rows[0]?.wrapped_dek).not.toContain(plaintext);
    expect(stored.rows[0]?.secret_fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
});
