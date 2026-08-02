import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  issueSecret,
  loadConfig,
  openSecret,
  sealSecret,
  secretPrefix,
  verifySecret,
} from '@tollgate/shared';

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

describe('provider credential envelope encryption', () => {
  it('wraps a unique data key and binds ciphertext to its tenant context', () => {
    const kek = Buffer.alloc(32, 7);
    const plaintext = randomBytes(24).toString('base64url');
    const sealed = sealSecret(plaintext, kek, 'org-1:provider-1');

    expect(JSON.stringify(sealed)).not.toContain(plaintext);
    expect(openSecret(sealed, kek, 'org-1:provider-1')).toBe(plaintext);
    expect(() => openSecret(sealed, kek, 'org-2:provider-1')).toThrow();
  });
});
