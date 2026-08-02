import type { PoolClient } from 'pg';
import { transaction } from '@tollgate/db';
import { redis } from './auth.js';
import { TollgateError, type UsageFact } from '@tollgate/shared';

interface ReservationBudgetTarget {
  org_id: string;
  team_id: string | null;
  created_at: Date;
}

interface BudgetRow {
  id: string;
  team_id: string | null;
  period: 'day' | 'month';
  limit_micros: string;
  hard_stop: boolean;
}

function periodBounds(period: BudgetRow['period'], createdAt: Date): [Date, Date] {
  const start =
    period === 'day'
      ? new Date(
          Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate()),
        )
      : new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1));
  const end =
    period === 'day'
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1))
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return [start, end];
}

export async function admitReservationBudget(reservationId: string): Promise<void> {
  await transaction(async (client) => {
    const targetResult = await client.query<ReservationBudgetTarget>(
      `SELECT r.org_id,r.team_id,q.created_at FROM reservations r JOIN requests q ON q.id=r.request_id WHERE r.id=$1 AND r.status='pending'`,
      [reservationId],
    );
    const target = targetResult.rows[0];
    if (!target) throw new Error(`Pending reservation ${reservationId} not found`);

    const budgets = await client.query<BudgetRow>(
      `SELECT id,team_id,period,limit_micros::text,hard_stop FROM budgets WHERE org_id=$1 AND (team_id IS NULL OR team_id=$2) ORDER BY team_id NULLS FIRST,period,id FOR UPDATE`,
      [target.org_id, target.team_id],
    );
    for (const budget of budgets.rows) {
      const [periodStart, periodEnd] = periodBounds(budget.period, target.created_at);
      const state = await client.query<{ spent: string; reserved: string }>(
        `SELECT COALESCE((SELECT SUM(l.amount_micros) FROM ledger_entries l JOIN requests q ON q.id=l.request_id WHERE l.org_id=$1 AND ($2::uuid IS NULL OR l.team_id=$2) AND q.created_at >= $3 AND q.created_at < $4),0)::text spent,COALESCE((SELECT SUM(r.amount_micros) FROM reservations r JOIN requests q ON q.id=r.request_id WHERE r.org_id=$1 AND ($2::uuid IS NULL OR r.team_id=$2) AND (r.status='reserved' OR r.id=$5) AND q.created_at >= $3 AND q.created_at < $4),0)::text reserved`,
        [target.org_id, budget.team_id, periodStart, periodEnd, reservationId],
      );
      const spent = BigInt(state.rows[0]?.spent ?? '0');
      const reserved = BigInt(state.rows[0]?.reserved ?? '0');
      if (budget.hard_stop && spent + reserved > BigInt(budget.limit_micros))
        throw new TollgateError(402, 'budget_exceeded', 'Budget exhausted');
    }
    await client.query(
      `UPDATE reservations SET status='reserved' WHERE id=$1 AND status='pending'`,
      [reservationId],
    );
  });
}

export async function rejectPendingReservation(
  reservationId: string,
  requestId: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE reservations SET status='released',released_at=now() WHERE id=$1 AND status='pending'`,
      [reservationId],
    );
    await client.query(
      `UPDATE requests SET status='failed',finalized_at=now() WHERE id=$1 AND status='in_progress'`,
      [requestId],
    );
  });
}

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
