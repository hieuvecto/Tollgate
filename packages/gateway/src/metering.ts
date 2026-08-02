import type { PoolClient } from 'pg';
import { transaction } from '@tollgate/db';
import { redis } from './auth.js';
import type { UsageFact } from '@tollgate/shared';

export async function finalizeRequest(
  fact: UsageFact,
  status: 'succeeded' | 'failed' | 'client_aborted',
  providerId: string,
  timings: { firstTokenMs?: number; totalMs: number },
  idempotencyResponse?: unknown,
): Promise<void> {
  const write = async (client: PoolClient) => {
    await client.query(
      `UPDATE requests SET status=$2,provider_id_used=$3,first_token_ms=$4,total_ms=$5,finalized_at=now(),idempotency_response=$6 WHERE id=$1`,
      [
        fact.requestId,
        status,
        providerId,
        timings.firstTokenMs ?? null,
        timings.totalMs,
        idempotencyResponse ?? null,
      ],
    );
    await client.query(
      `INSERT INTO outbox(kind,payload,dedupe_key) VALUES('usage',$1,$2) ON CONFLICT(dedupe_key) DO NOTHING`,
      [JSON.stringify(fact), `usage:${fact.requestId}`],
    );
  };
  await transaction(write);
}

export async function spoolUsage(fact: UsageFact, status: string): Promise<void> {
  await redis.xadd(
    'metering:spool',
    '*',
    'request_id',
    fact.requestId,
    'status',
    status,
    'payload',
    JSON.stringify(fact),
  );
}
