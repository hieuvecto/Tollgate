import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type IssuedSecret = { plaintext: string; prefix: string; hash: string };

export function issueSecret(namespace: 'tg_live' | 'tg_admin', pepper: string): IssuedSecret {
  const random = randomBytes(32).toString('base64url');
  const prefix = `${namespace}_${random.slice(0, 8)}`;
  const plaintext = `${prefix}_${random}`;
  return { plaintext, prefix, hash: hashSecret(plaintext, pepper) };
}

export function hashSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function verifySecret(secret: string, expected: string, pepper: string): boolean {
  const actual = Buffer.from(hashSecret(secret, pepper), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function secretPrefix(secret: string): string | null {
  const match = /^(tg_(?:live|admin)_[A-Za-z0-9_-]{8})_/.exec(secret);
  return match?.[1] ?? null;
}
