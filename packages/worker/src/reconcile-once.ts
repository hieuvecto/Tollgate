import { reconcile } from './reconciliation.js';
import { pool } from '@tollgate/db';

const end = new Date();
const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
const invoiceUrl = `${process.env.MOCK_PROVIDER_URL ?? 'http://localhost:4010'}/invoice`;
let invoice: Array<{ requestId: string; inputTokens: number; outputTokens: number }> = [];
try {
  invoice = ((await (await fetch(invoiceUrl)).json()) as { data: typeof invoice }).data;
} catch {
  /* reconciliation still checks internal invariants */
}
process.stdout.write(`${JSON.stringify(await reconcile(start, end, invoice), null, 2)}\n`);
await pool().end();
