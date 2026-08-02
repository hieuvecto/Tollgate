import { query } from '@tollgate/db';

export interface Finding {
  category: string;
  requestId?: string;
  detail: string;
}

export async function reconcile(
  periodStart: Date,
  periodEnd: Date,
  providerInvoice: Array<{
    requestId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  }> = [],
) {
  const findings: Finding[] = [];
  const requests = await query<Record<string, unknown>>(
    `SELECT r.id,r.status,r.attempt_count,r.reservation_id,u.source,u.input_tokens,u.output_tokens FROM requests r LEFT JOIN usage_events u ON u.request_id=r.id WHERE r.created_at >= $1 AND r.created_at < $2`,
    [periodStart, periodEnd],
  );
  const invoice = new Map(providerInvoice.map((item) => [item.requestId, item]));
  for (const row of requests.rows) {
    const id = String(row.id);
    if (!row.source)
      findings.push({
        category: 'missing_usage',
        requestId: id,
        detail: 'Request has no usage event',
      });
    if (row.source === 'estimated')
      findings.push({
        category: 'estimated_usage',
        requestId: id,
        detail: 'Provider usage was unavailable',
      });
    if (row.status === 'client_aborted')
      findings.push({
        category: 'client_aborted',
        requestId: id,
        detail: 'Client disconnected during streaming',
      });
    if (Number(row.attempt_count) > 1)
      findings.push({
        category: 'retried_request',
        requestId: id,
        detail: `${String(row.attempt_count)} attempts`,
      });
    const reported = invoice.get(id);
    if (
      reported &&
      (reported.inputTokens !== Number(row.input_tokens) ||
        reported.outputTokens !== Number(row.output_tokens))
    )
      findings.push({
        category: 'provider_mismatch',
        requestId: id,
        detail: `ledger=${String(row.input_tokens)}/${String(row.output_tokens)} provider=${reported.inputTokens}/${reported.outputTokens}`,
      });
    invoice.delete(id);
  }
  for (const id of invoice.keys())
    findings.push({
      category: 'provider_only',
      requestId: id,
      detail: 'Provider reported usage without a matching request',
    });
  const orphaned = await query<{ request_id: string }>(
    `SELECT request_id FROM reservations WHERE status='reserved' AND created_at < now()-interval '10 minutes'`,
  );
  for (const row of orphaned.rows)
    findings.push({
      category: 'orphaned_reservation',
      requestId: row.request_id,
      detail: 'Reservation exceeded its settlement window',
    });
  const inserted = await query<{ id: string }>(
    `INSERT INTO reconciliation_runs(period_start,period_end,findings,proposed_adjustments) VALUES($1,$2,$3,'[]') RETURNING id`,
    [periodStart, periodEnd, JSON.stringify(findings)],
  );
  return { id: inserted.rows[0]!.id, findings };
}
