import { describe, expect, it } from 'vitest';
import { issueSecret, secretPrefix, verifySecret } from '@tollgate/shared';

describe('secret hashing', () => {
  it('issues verifiable secrets while separating display prefix and hash', () => {
    const issued = issueSecret('tg_live', 'a-test-pepper-long-enough');
    expect(issued.hash).not.toContain(issued.plaintext);
    expect(secretPrefix(issued.plaintext)).toBe(issued.prefix);
    expect(verifySecret(issued.plaintext, issued.hash, 'a-test-pepper-long-enough')).toBe(true);
  });
});
