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

describe('production packaging', () => {
  it('runs compiled services as a non-root user and verifies images in CI', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8');
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(dockerfile).toContain('ENV NODE_ENV=production');
    expect(dockerfile).toContain('USER tollgate');
    expect(dockerfile).toContain('packages/gateway/dist/server.js');
    expect(dockerfile).not.toContain('CMD ["pnpm"');
    expect(workflow).toContain('pnpm format:check');
    expect(workflow).toContain('docker build --target gateway');
  });
});
