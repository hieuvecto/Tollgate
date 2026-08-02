import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const requests = new Counter({
  name: 'tollgate_requests_total',
  help: 'Gateway requests',
  labelNames: ['model', 'provider', 'status'],
  registers: [registry],
});
export const latency = new Histogram({
  name: 'tollgate_request_duration_seconds',
  help: 'End-to-end latency',
  labelNames: ['model'],
  registers: [registry],
});
export const ttft = new Histogram({
  name: 'tollgate_ttft_seconds',
  help: 'Time to first token',
  labelNames: ['model', 'provider'],
  registers: [registry],
});
export const tokens = new Counter({
  name: 'tollgate_tokens_total',
  help: 'Accounted tokens',
  labelNames: ['model', 'direction', 'source'],
  registers: [registry],
});
export const cost = new Counter({
  name: 'tollgate_cost_micros_total',
  help: 'Settled cost in integer micros',
  labelNames: ['model'],
  registers: [registry],
});
export const inFlight = new Gauge({
  name: 'tollgate_in_flight_requests',
  help: 'Active gateway requests',
  registers: [registry],
});
