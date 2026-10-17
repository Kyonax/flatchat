// SPDX-License-Identifier: AGPL-3.0-or-later
// Random tokens, their digests, passwords and sealed world keys. A token is shown once (to the
// client, or in the admin command line) and stored only as its SHA-256 digest, so a copy of the
// database opens no session. Passwords are Argon2id (RFC 9106) through Node's own crypto.
import { argon2, createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random token for URLs and headers: base64url, 32 bytes unless asked otherwise. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The PKCE S256 challenge of a verifier (RFC 7636, section 4.2). */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ------------------------------------------------------------------------------- passwords

export interface PasswordCost {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/** RFC 9106's second recommended setting: 64 MiB, 3 passes, 4 lanes (about 0.1 s here). */
export const STANDARD_COST: PasswordCost = { memoryKiB: 65_536, passes: 3, parallelism: 4 };
/** For tests only: the same algorithm, cheap. A PHC string records its cost, so both verify. */
export const TEST_COST: PasswordCost = { memoryKiB: 64, passes: 1, parallelism: 1 };

const TAG_BYTES = 32;

function argon2id(password: string, salt: Buffer, cost: PasswordCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: Buffer.from(password, 'utf8'), nonce: salt, memory: cost.memoryKiB, passes: cost.passes, parallelism: cost.parallelism, tagLength: TAG_BYTES },
      (err, tag) => (err ? reject(err) : resolve(Buffer.from(tag))),
    );
  });
}

/** `$argon2id$v=19$m=…,t=…,p=…$salt$hash`, the format every Argon2 library reads. */
export async function hashPassword(password: string, cost: PasswordCost = STANDARD_COST): Promise<string> {
  const salt = randomBytes(16);
  const tag = await argon2id(password, salt, cost);
  const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${cost.memoryKiB},t=${cost.passes},p=${cost.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,64})\$([A-Za-z0-9+/]{16,128})$/;

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const cost = { memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  const expected = Buffer.from(m[5]!, 'base64');
  const tag = await argon2id(password, Buffer.from(m[4]!, 'base64'), cost);
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}

/** Verifying against this costs the same as a real account, so a missing address cannot be timed. */
export async function decoyHash(cost: PasswordCost): Promise<string> {
  return hashPassword(newToken(16), cost);
}

// ------------------------------------------------------------------------------ world keys

const SEAL_NONCE = 12;
const SEAL_TAG = 16;

/** The key that seals world keys, derived from the core's secret for this one use. */
export function sealingKey(coreSecret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', coreSecret, Buffer.alloc(0), 'flatchat core: world keys v1', 32));
}

/** The key preserved evidence is sealed with (S3.12): apart from the world keys' key. */
export function evidenceKey(coreSecret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', coreSecret, Buffer.alloc(0), 'flatchat core: preserved evidence v1', 32));
}

/** Seals bytes under a key, bound to `label` (AES-256-GCM; the nonce first, the tag last). */
export function sealBytes(key: Buffer, label: string, bytes: Uint8Array): Buffer {
  const nonce = randomBytes(SEAL_NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: SEAL_TAG });
  cipher.setAAD(Buffer.from(label, 'utf8'));
  return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

export function openBytes(key: Buffer, label: string, sealed: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, SEAL_NONCE), { authTagLength: SEAL_TAG });
  decipher.setAAD(Buffer.from(label, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - SEAL_TAG));
  return Buffer.concat([decipher.update(sealed.subarray(SEAL_NONCE, sealed.length - SEAL_TAG)), decipher.final()]);
}

/** Seals a world key under the core's key, bound to the world's id (AES-256-GCM). */
export function sealWorldKey(sealing: Buffer, worldId: string, worldKey: Uint8Array): Buffer {
  const nonce = randomBytes(SEAL_NONCE);
  const cipher = createCipheriv('aes-256-gcm', sealing, nonce, { authTagLength: SEAL_TAG });
  cipher.setAAD(Buffer.from(worldId, 'utf8'));
  return Buffer.concat([nonce, cipher.update(worldKey), cipher.final(), cipher.getAuthTag()]);
}

export function openWorldKey(sealing: Buffer, worldId: string, sealed: Buffer): Uint8Array<ArrayBuffer> {
  const nonce = sealed.subarray(0, SEAL_NONCE);
  const tag = sealed.subarray(sealed.length - SEAL_TAG);
  const decipher = createDecipheriv('aes-256-gcm', sealing, nonce, { authTagLength: SEAL_TAG });
  decipher.setAAD(Buffer.from(worldId, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(sealed.subarray(SEAL_NONCE, sealed.length - SEAL_TAG)), decipher.final()]);
  return new Uint8Array(plain);
}
