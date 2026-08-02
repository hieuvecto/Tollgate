import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const outboxLag = new Gauge({
  name: 'tollgate_outbox_lag_seconds',
  help: 'Age of oldest ready, unprocessed outbox item',
  registers: [registry],
});
export const reservationLeaks = new Gauge({
  name: 'tollgate_reservation_leaks',
  help: 'Reservations beyond the settlement window',
  registers: [registry],
});
export const outboxDeadLetters = new Gauge({
  name: 'tollgate_outbox_dead_letters',
  help: 'Unprocessed outbox items that exhausted automatic retries',
  registers: [registry],
});
