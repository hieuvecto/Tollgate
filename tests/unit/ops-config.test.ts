import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Prometheus alerting', () => {
  it('loads rules for the production failure signals', async () => {
    const prometheus = await readFile('ops/prometheus.yml', 'utf8');
    const rules = await readFile('ops/alerts/tollgate.yml', 'utf8');
    expect(prometheus).toContain('rule_files:');
    for (const alert of [
      'TollgateHighErrorRate',
      'TollgateOutboxLag',
      'TollgateReservationLeak',
      'TollgateProviderBreakerOpen',
      'TollgateOutboxDeadLetter',
    ])
      expect(rules).toContain(`alert: ${alert}`);
  });
});
