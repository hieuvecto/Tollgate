import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '@tollgate/db';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

suite('database money invariants', () => {
  const db = pool();
  beforeAll(async () => {
    await db.query('SELECT 1');
  });
  afterAll(async () => {
    await db.end();
  });

  it('rejects updates and deletes on both append-only tables', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const org = randomUUID();
      const team = randomUUID();
      const key = randomUUID();
      const provider = randomUUID();
      const model = randomUUID();
      const pricing = randomUUID();
      const request = randomUUID();
      const usage = randomUUID();
      const ledger = randomUUID();
      await client.query(`INSERT INTO orgs(id,name) VALUES($1,'test')`, [org]);
      await client.query(`INSERT INTO teams(id,org_id,name) VALUES($1,$2,'team')`, [team, org]);
      await client.query(
        `INSERT INTO api_keys(id,org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,'key',$4,'hash','{}')`,
        [key, org, team, `tg_live_${randomUUID().slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO providers(id,name,kind,base_url) VALUES($1,$2,'mock','http://mock')`,
        [provider, `p-${provider}`],
      );
      await client.query(`INSERT INTO models(id,public_name,context_window) VALUES($1,$2,1000)`, [
        model,
        `m-${model}`,
      ]);
      await client.query(
        `INSERT INTO model_pricing(id,model_id,input_per_mtok,output_per_mtok,cached_input_per_mtok,effective_from) VALUES($1,$2,1,1,1,'2020-01-01')`,
        [pricing, model],
      );
      await client.query(
        `INSERT INTO requests(id,org_id,team_id,api_key_id,model_id,pricing_id,status) VALUES($1,$2,$3,$4,$5,$6,'succeeded')`,
        [request, org, team, key, model, pricing],
      );
      await client.query(
        `INSERT INTO usage_events(id,request_id,org_id,team_id,api_key_id,model_id,input_tokens,output_tokens,source) VALUES($1,$2,$3,$4,$5,$6,1,1,'provider')`,
        [usage, request, org, team, key, model],
      );
      await client.query(
        `INSERT INTO ledger_entries(id,org_id,team_id,request_id,amount_micros,kind,pricing_id) VALUES($1,$2,$3,$4,1,'charge',$5)`,
        [ledger, org, team, request, pricing],
      );
      for (const statement of [
        `UPDATE usage_events SET input_tokens=2 WHERE id='${usage}'`,
        `DELETE FROM ledger_entries WHERE id='${ledger}'`,
      ]) {
        await client.query('SAVEPOINT mutation');
        await expect(client.query(statement)).rejects.toThrow(/append-only/);
        await client.query('ROLLBACK TO SAVEPOINT mutation');
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('has mandatory request and pricing references plus single-charge constraints', async () => {
    const constraints = await db.query<{ name: string }>(
      `SELECT conname name FROM pg_constraint WHERE conrelid='ledger_entries'::regclass UNION SELECT indexname FROM pg_indexes WHERE tablename='ledger_entries'`,
    );
    const names = constraints.rows.map((row) => row.name);
    expect(names).toContain('ledger_entries_request_id_fkey');
    expect(names).toContain('ledger_entries_pricing_id_fkey');
    expect(names).toContain('one_charge_per_request');
  });

  it('has supporting indexes for worker and reporting scans', async () => {
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'outbox_ready_for_processing',
        'ledger_entries_org_created_at',
        'requests_created_at',
        'reservations_active_created_at',
      ]),
    );
  });
});
