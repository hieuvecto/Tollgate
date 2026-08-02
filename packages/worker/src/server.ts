import Fastify from 'fastify';
import { Registry, Gauge } from 'prom-client';
import {
  settleBatch,
  reapReservations,
  closeWorkerResources,
  drainMeteringSpool,
  expireIdempotencyKeys,
} from './settlement.js';
import { query } from '@tollgate/db';

const registry = new Registry();
const outboxLag = new Gauge({
  name: 'tollgate_outbox_lag_seconds',
  help: 'Age of oldest unprocessed outbox item',
  registers: [registry],
});
const reservationLeaks = new Gauge({
  name: 'tollgate_reservation_leaks',
  help: 'Reservations beyond the settlement window',
  registers: [registry],
});
const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
app.get('/metrics', async (_request, reply) => {
  const state = await query<{ lag: string | null; leaks: string }>(
    `SELECT EXTRACT(EPOCH FROM (now()-(MIN(created_at) FILTER(WHERE processed_at IS NULL)))) lag,(SELECT count(*) FROM reservations WHERE status='reserved' AND created_at<now()-interval '10 minutes') leaks FROM outbox`,
  );
  outboxLag.set(Number(state.rows[0]?.lag ?? 0));
  reservationLeaks.set(Number(state.rows[0]?.leaks ?? 0));
  return reply.type(registry.contentType).send(await registry.metrics());
});
const loop = setInterval(() => {
  void drainMeteringSpool()
    .then(() => settleBatch())
    .then(() => expireIdempotencyKeys())
    .catch((error: unknown) => app.log.error(error));
  void reapReservations().catch((error: unknown) => app.log.error(error));
}, 500);
const shutdown = async () => {
  clearInterval(loop);
  await app.close();
  await closeWorkerResources();
  process.exit(0);
};
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
await app.listen({ host: '0.0.0.0', port: 3003 });
