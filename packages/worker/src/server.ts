import Fastify from 'fastify';
import {
  settleBatch,
  reapReservations,
  closeWorkerResources,
  drainMeteringSpool,
  expireIdempotencyKeys,
} from './settlement.js';
import { query } from '@tollgate/db';
import { singleFlight } from './loop.js';
import { loadConfig } from '@tollgate/shared';
import { outboxDeadLetters, outboxLag, registry, reservationLeaks } from './metrics.js';

const config = loadConfig();
const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
app.get('/metrics', async (_request, reply) => {
  const state = await query<{ lag: string | null; leaks: string; dead_letters: string }>(
    `SELECT EXTRACT(EPOCH FROM (now()-(MIN(created_at) FILTER(WHERE processed_at IS NULL AND attempts < $1 AND next_attempt_at <= now())))) lag,(SELECT count(*) FROM reservations WHERE status='reserved' AND created_at<now()-interval '10 minutes') leaks,count(*) FILTER(WHERE processed_at IS NULL AND attempts >= $1) dead_letters FROM outbox`,
    [config.OUTBOX_MAX_ATTEMPTS],
  );
  outboxLag.set(Number(state.rows[0]?.lag ?? 0));
  reservationLeaks.set(Number(state.rows[0]?.leaks ?? 0));
  outboxDeadLetters.set(Number(state.rows[0]?.dead_letters ?? 0));
  return reply.type(registry.contentType).send(await registry.metrics());
});
const runCycle = singleFlight(
  async () => {
    await drainMeteringSpool();
    await settleBatch();
    await reapReservations();
    await expireIdempotencyKeys();
  },
  (error) => app.log.error(error),
);
const loop = setInterval(() => void runCycle(), 500);
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
