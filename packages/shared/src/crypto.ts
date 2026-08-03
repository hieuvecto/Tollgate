import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export interface IssuedSecret {
  plaintext: string;
  prefix: string;
  hash: string;
}
export interface SealedSecret {
  ciphertext: string;
  secretIv: string;
  secretTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
  keyVersion: number;
}

function assertAesKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Provider credential encryption key must be 32 bytes');
}

function encrypt(value: Buffer, key: Buffer, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  return {
    ciphertext: Buffer.concat([cipher.update(value), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}

function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer, context: string) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decodeProviderCredentialKek(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error('PROVIDER_CREDENTIAL_KEK is not configured');
  const key = Buffer.from(encoded, 'base64');
  assertAesKey(key);
  return key;
}

export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export function sealSecret(
  plaintext: string,
  keyEncryptionKey: Buffer,
  context: string,
): SealedSecret {
  assertAesKey(keyEncryptionKey);
  const dek = randomBytes(32);
  const secret = encrypt(Buffer.from(plaintext), dek, `secret:${context}`);
  const wrapped = encrypt(dek, keyEncryptionKey, `dek:${context}`);
  return {
    ciphertext: secret.ciphertext.toString('base64'),
    secretIv: secret.iv.toString('base64'),
    secretTag: secret.tag.toString('base64'),
    wrappedDek: wrapped.ciphertext.toString('base64'),
    wrapIv: wrapped.iv.toString('base64'),
    wrapTag: wrapped.tag.toString('base64'),
    keyVersion: 1,
  };
}

export function openSecret(
  sealed: SealedSecret,
  keyEncryptionKey: Buffer,
  context: string,
): string {
  assertAesKey(keyEncryptionKey);
  const dek = decrypt(
    Buffer.from(sealed.wrappedDek, 'base64'),
    Buffer.from(sealed.wrapIv, 'base64'),
    Buffer.from(sealed.wrapTag, 'base64'),
    keyEncryptionKey,
    `dek:${context}`,
  );
  return decrypt(
    Buffer.from(sealed.ciphertext, 'base64'),
    Buffer.from(sealed.secretIv, 'base64'),
    Buffer.from(sealed.secretTag, 'base64'),
    dek,
    `secret:${context}`,
  ).toString();
}

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
