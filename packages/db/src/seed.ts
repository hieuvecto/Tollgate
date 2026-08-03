import { issueSecret } from '@tollgate/shared';
import { pool, transaction } from './index.js';

const pepper = process.env.KEY_PEPPER ?? 'local-only-pepper-change-me';
const db = pool();
const issued: Array<{ purpose: string; plaintext: string }> = [];

await transaction(async (client) => {
  await client.query(
    'TRUNCATE reconciliation_runs, ledger_entries, usage_events, outbox, reservations, requests, budgets, provider_health, provider_bindings, model_pricing, routing_policies, models, providers, api_keys, control_plane_tokens, memberships, users, teams, orgs CASCADE',
  );
  const orgs = await client.query<{ id: string }>(
    `INSERT INTO orgs(name,on_metering_failure) VALUES ('Acme','fail_closed'),('Sandbox','fail_open') RETURNING id`,
  );
  const acme = orgs.rows[0]!.id;
  const sandbox = orgs.rows[1]!.id;
  const teams = await client.query<{ id: string; org_id: string }>(
    `INSERT INTO teams(org_id,name) VALUES ($1,'Platform'),($1,'Research'),($2,'Demo') RETURNING id,org_id`,
    [acme, sandbox],
  );
  const roles = ['owner', 'admin', 'member', 'billing_viewer'] as const;
  for (const [index, role] of roles.entries()) {
    const user = await client.query<{ id: string }>(
      'INSERT INTO users(org_id,email) VALUES($1,$2) RETURNING id',
      [acme, `${role}@tollgate.local`],
    );
    await client.query('INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)', [
      user.rows[0]!.id,
      teams.rows[index % 2]!.id,
      role,
    ]);
    const token = issueSecret('tg_admin', pepper);
    await client.query(
      'INSERT INTO control_plane_tokens(user_id,token_prefix,token_hash) VALUES($1,$2,$3)',
      [user.rows[0]!.id, token.prefix, token.hash],
    );
    issued.push({ purpose: `control-plane ${role}`, plaintext: token.plaintext });
  }
  for (const [index, team] of teams.rows.entries()) {
    const key = issueSecret('tg_live', pepper);
    await client.query(
      `INSERT INTO api_keys(org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        team.org_id,
        team.id,
        `seed-${index + 1}`,
        key.prefix,
        key.hash,
        JSON.stringify({
          models: ['tg-mock', 'tg-anthropic', 'tg-compatible'],
          endpoints: ['chat', 'embeddings'],
        }),
      ],
    );
    issued.push({ purpose: `gateway team ${index + 1}`, plaintext: key.plaintext });
  }
  const spare = issueSecret('tg_live', pepper);
  await client.query(
    `INSERT INTO api_keys(org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,'revoked-example',$3,$4,'{}')`,
    [acme, teams.rows[0]!.id, spare.prefix, spare.hash],
  );
  issued.push({ purpose: 'gateway revocation demo', plaintext: spare.plaintext });

  const providers = await client.query<{ id: string; kind: string }>(
    `INSERT INTO providers(name,kind,base_url) VALUES ('local-mock','mock',$1),('anthropic-shaped-mock','anthropic',$1),('generic-compatible-mock','openai_compatible',$1) RETURNING id,kind`,
    [process.env.MOCK_PROVIDER_URL ?? 'http://localhost:4010'],
  );
  const models = await client.query<{ id: string; public_name: string }>(
    `INSERT INTO models(public_name,context_window,default_max_output_tokens) VALUES ('tg-mock',8192,512),('tg-anthropic',8192,512),('tg-compatible',8192,512) RETURNING id,public_name`,
  );
  const mock = providers.rows.find((row) => row.kind === 'mock')!;
  const anthropic = providers.rows.find((row) => row.kind === 'anthropic')!;
  const compatible = providers.rows.find((row) => row.kind === 'openai_compatible')!;
  const publicMock = models.rows.find((row) => row.public_name === 'tg-mock')!;
  const publicAnthropic = models.rows.find((row) => row.public_name === 'tg-anthropic')!;
  const publicCompatible = models.rows.find((row) => row.public_name === 'tg-compatible')!;
  await client.query(
    `INSERT INTO provider_bindings(model_id,provider_id,provider_model_name,priority,input_cost_per_mtok,output_cost_per_mtok) VALUES($1,$2,'mock-chat',1,500000,1000000),($1,$3,'mock-chat',2,600000,1200000),($4,$5,'claude-mock',1,700000,1400000),($6,$3,'mock-chat',1,550000,1100000)`,
    [publicMock.id, mock.id, compatible.id, publicAnthropic.id, anthropic.id, publicCompatible.id],
  );
  for (const model of models.rows) {
    await client.query(
      `INSERT INTO model_pricing(model_id,input_per_mtok,output_per_mtok,cached_input_per_mtok,effective_from) VALUES($1,1000000,2000000,250000,'2020-01-01')`,
      [model.id],
    );
  }
  await client.query(
    `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,'failover_order',60,100000),($2,'weighted',120,200000)`,
    [acme, sandbox],
  );
  await client.query(
    `INSERT INTO budgets(org_id,period,limit_micros,hard_stop) VALUES($1,'month',100000000,true),($2,'month',100000000,false)`,
    [acme, sandbox],
  );
});

for (const item of issued) process.stdout.write(`${item.purpose}: ${item.plaintext}\n`);
process.stdout.write('These plaintext credentials are displayed once and are not stored.\n');
await db.end();
