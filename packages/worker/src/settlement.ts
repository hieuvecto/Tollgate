import { Redis } from 'ioredis';
import { pool, query, transaction } from '@tollgate/db';
import { loadConfig, priceTokens, type UsageFact } from '@tollgate/shared';

const config = loadConfig();
export const workerRedis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

const streamField = (fields: string[], name: string) => {
  const index = fields.indexOf(name);
  return index < 0 ? undefined : fields[index + 1];
};

export async function drainMeteringSpool(batchSize = 50): Promise<number> {
  let drained = 0;
  const usage = await workerRedis.xrange('metering:spool', '-', '+', 'COUNT', batchSize);
  for (const [entryId, fields] of usage) {
    const raw = streamField(fields, 'payload');
    const requestId = streamField(fields, 'request_id');
    const status = streamField(fields, 'status');
    if (!raw || !requestId || !status) continue;
    const exists = await query('SELECT 1 FROM requests WHERE id=$1', [requestId]);
    if (!exists.rowCount) continue;
    await transaction(async (client) => {
      await client.query(
        `UPDATE requests SET status=$2,finalized_at=now() WHERE id=$1 AND status='in_progress'`,
        [requestId, status],
      );
      await client.query(
        `INSERT INTO outbox(kind,payload,dedupe_key) VALUES('usage',$1,$2) ON CONFLICT(dedupe_key) DO NOTHING`,
        [raw, `usage:${requestId}`],
      );
    });
    await workerRedis.xdel('metering:spool', entryId);
    drained += 1;
  }
  return drained;
}

export async function settleBatch(batchSize = 50): Promise<number> {
  const items = await query<{ id: string; payload: UsageFact }>(
    `SELECT id,payload FROM outbox WHERE processed_at IS NULL ORDER BY created_at LIMIT $1`,
    [batchSize],
  );
  for (const item of items.rows) {
    try {
      await transaction(async (client) => {
        const locked = await client.query<{ payload: UsageFact }>(
          'SELECT payload FROM outbox WHERE id=$1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED',
          [item.id],
        );
        if (!locked.rowCount) return;
        const fact = locked.rows[0]!.payload;
        const pricing = await client.query<{
          input_per_mtok: string;
          output_per_mtok: string;
          cached_input_per_mtok: string;
        }>(
          'SELECT input_per_mtok,output_per_mtok,cached_input_per_mtok FROM model_pricing WHERE id=$1',
          [fact.pricingId],
        );
        const price = pricing.rows[0];
        if (!price) throw new Error(`Missing pricing ${fact.pricingId}`);
        const amount = priceTokens(
          fact.inputTokens,
          fact.outputTokens,
          fact.cachedInputTokens,
          BigInt(price.input_per_mtok),
          BigInt(price.output_per_mtok),
          BigInt(price.cached_input_per_mtok),
        );
        await client.query(
          `INSERT INTO usage_events(request_id,org_id,team_id,api_key_id,model_id,input_tokens,output_tokens,cached_input_tokens,source,provider_raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_id) DO NOTHING`,
          [
            fact.requestId,
            fact.orgId,
            fact.teamId,
            fact.apiKeyId,
            fact.modelId,
            fact.inputTokens,
            fact.outputTokens,
            fact.cachedInputTokens,
            fact.source,
            fact.providerRaw,
          ],
        );
        await client.query(
          `INSERT INTO ledger_entries(org_id,team_id,request_id,amount_micros,kind,pricing_id) VALUES($1,$2,$3,$4,'charge',$5) ON CONFLICT(request_id) WHERE kind='charge' DO NOTHING`,
          [fact.orgId, fact.teamId, fact.requestId, amount.toString(), fact.pricingId],
        );
        await client.query(
          `UPDATE reservations SET status='settled',released_at=now() WHERE request_id=$1 AND status='reserved'`,
          [fact.requestId],
        );
        await client.query(
          'UPDATE outbox SET processed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1',
          [item.id],
        );
      });
    } catch (error) {
      await query('UPDATE outbox SET attempts=attempts+1,last_error=$2 WHERE id=$1', [
        item.id,
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  return items.rowCount ?? 0;
}

export async function reapReservations(maxAgeMinutes = 10): Promise<number> {
  const pending = await query(
    `UPDATE reservations SET status='released',released_at=now() WHERE status='pending' AND created_at < now()-($1 || ' minutes')::interval`,
    [maxAgeMinutes],
  );
  const stale = await query(
    `UPDATE reservations SET status='released',released_at=now() WHERE status='reserved' AND created_at < now()-($1 || ' minutes')::interval`,
    [maxAgeMinutes],
  );
  return (stale.rowCount ?? 0) + (pending.rowCount ?? 0);
}

export async function expireIdempotencyKeys(): Promise<number> {
  const result = await query(
    `UPDATE requests SET idempotency_key=NULL,idempotency_response=NULL,idempotency_expires_at=NULL WHERE status<>'in_progress' AND idempotency_expires_at<=now()`,
  );
  return result.rowCount ?? 0;
}

export async function closeWorkerResources() {
  await workerRedis.quit();
  await pool().end();
}
