import { describe, expect, it } from 'vitest';
import { issueSecret, loadConfig, secretPrefix, verifySecret } from '@tollgate/shared';

describe('secret hashing', () => {
  it('issues verifiable secrets while separating display prefix and hash', () => {
    const issued = issueSecret('tg_live', 'a-test-pepper-long-enough');
    expect(issued.hash).not.toContain(issued.plaintext);
    expect(secretPrefix(issued.plaintext)).toBe(issued.prefix);
    expect(verifySecret(issued.plaintext, issued.hash, 'a-test-pepper-long-enough')).toBe(true);
  });
});

describe('production secret configuration', () => {
  it('rejects the bundled development pepper in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/KEY_PEPPER/);
  });

  it('accepts an explicitly configured production pepper', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      KEY_PEPPER: 'production-pepper-at-least-sixteen-characters',
    });

    expect(config.NODE_ENV).toBe('production');
  });
});
