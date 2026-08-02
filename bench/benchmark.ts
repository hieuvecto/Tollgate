import { randomUUID } from 'node:crypto';
import { pool, query } from '@tollgate/db';
import { issueSecret, loadConfig } from '@tollgate/shared';

const config = loadConfig();
const baseUrl = process.env.BENCHMARK_URL ?? 'http://localhost:3000';
const model = process.env.BENCHMARK_MODEL ?? 'tg-mock';
const requestCount = Number(process.env.BENCHMARK_REQUESTS ?? 50);
const concurrency = Number(process.env.BENCHMARK_CONCURRENCY ?? 5);
const authenticate = process.env.BENCHMARK_AUTH !== 'false';

async function createBenchmarkKey(): Promise<string> {
  const orgId = randomUUID();
  const teamId = randomUUID();
  const keyId = randomUUID();
  const issued = issueSecret('tg_live', config.KEY_PEPPER);
  await query(`INSERT INTO orgs(id,name) VALUES($1,$2)`, [orgId, `benchmark-${orgId}`]);
  await query(`INSERT INTO teams(id,org_id,name) VALUES($1,$2,'benchmark')`, [teamId, orgId]);
  await query(
    `INSERT INTO api_keys(id,org_id,team_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,'benchmark',$4,$5,$6)`,
    [
      keyId,
      orgId,
      teamId,
      issued.prefix,
      issued.hash,
      JSON.stringify({ models: [model], endpoints: ['chat'] }),
    ],
  );
  await query(
    `INSERT INTO routing_policies(org_id,strategy,rpm_limit,tpm_limit) VALUES($1,'failover_order',$2,10000000)`,
    [orgId, requestCount + 10],
  );
  await query(
    `INSERT INTO budgets(org_id,period,limit_micros,hard_stop) VALUES($1,'month',1000000000,true)`,
    [orgId],
  );
  return issued.plaintext;
}

const key = authenticate ? await createBenchmarkKey() : undefined;
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (key) headers.authorization = `Bearer ${key}`;
const body = JSON.stringify({
  model,
  messages: [{ role: 'user', content: 'benchmark' }],
  stream: true,
  max_tokens: 32,
});

async function invoke(): Promise<number> {
  const began = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body });
  await response.text();
  if (!response.ok) throw new Error(`Benchmark request failed with ${response.status}`);
  return performance.now() - began;
}

for (let index = 0; index < concurrency; index++) await invoke();
const durations: number[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= requestCount) return;
      durations.push(await invoke());
    }
  }),
);
durations.sort((left, right) => left - right);
const percentile = (value: number) =>
  durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)] ?? 0;
process.stdout.write(
  `${JSON.stringify({
    url: baseUrl,
    requests: durations.length,
    concurrency,
    averageMs: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  })}\n`,
);
await pool().end();
