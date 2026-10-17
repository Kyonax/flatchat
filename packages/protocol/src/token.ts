// SPDX-License-Identifier: Apache-2.0
// The connect token (sf-001, dp-006): what the core vouches for about one player, sealed for one
// world with AES-256-GCM under the 32-byte key the core and that world share (issued when the world
// is approved). The client carries it unread and hands it over in its hello; the world server opens
// it without calling the core. The header (format version, world, expiry, nonce) travels readable
// and is authenticated as the cipher's additional data; the claims are encrypted. Web Crypto only,
// so the same code runs in Node.js and in the client's renderer.
import { BitReader, BitWriter } from './bits.ts';
import type { Infer } from './codec.ts';
import { ProtocolError } from './errors.ts';
import { TOKEN_CLAIMS, TOKEN_HEADER, TOKEN_VERSION } from './schema.ts';

export type TokenClaims = Infer<typeof TOKEN_CLAIMS>;
export type TokenHeader = Infer<typeof TOKEN_HEADER>;

export const TOKEN_HEADER_BYTES = 37;
export const TOKEN_TAG_BYTES = 16;
export const WORLD_KEY_BYTES = 32;
export const TOKEN_NONCE_BYTES = 12;

export const TOKEN_ERROR_CODES = ['malformed', 'unsupported-version', 'wrong-world', 'expired', 'invalid'] as const;
export type TokenErrorCode = (typeof TOKEN_ERROR_CODES)[number];

export class TokenError extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'TokenError';
    this.code = code;
  }
}

/** A new random world key, made by the core when it approves a world. */
export function newWorldKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(WORLD_KEY_BYTES));
}

// Web Crypto wants views over a plain ArrayBuffer, so keys and inputs are copied first.
function keyBytes(key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || key.length !== WORLD_KEY_BYTES) throw new RangeError(`a world key is ${WORLD_KEY_BYTES} bytes`);
  return new Uint8Array(key);
}

/** Reads the token's readable part, without the key. Throws TokenError. */
export function readTokenHeader(sealed: Uint8Array): TokenHeader {
  if (!(sealed instanceof Uint8Array) || sealed.length < TOKEN_HEADER_BYTES + TOKEN_TAG_BYTES) {
    throw new TokenError('malformed', `a token has at least ${TOKEN_HEADER_BYTES + TOKEN_TAG_BYTES} bytes`);
  }
  if (sealed[0] !== TOKEN_VERSION) throw new TokenError('unsupported-version', `token format ${sealed[0]}, this build reads ${TOKEN_VERSION}`);
  try {
    const r = new BitReader(sealed.subarray(0, TOKEN_HEADER_BYTES));
    const header = TOKEN_HEADER.read(r);
    r.end();
    return header;
  } catch (err) {
    if (err instanceof ProtocolError) throw new TokenError('malformed', err.message, { cause: err });
    throw err;
  }
}

export interface SealOptions {
  /** The world's 32-byte key. */
  key: Uint8Array;
  /** The world the token admits to. */
  world: string;
  /** Unix time in seconds after which the world refuses it (about a minute after issue). */
  expiresAt: number;
  /** 12 bytes; random when left out. Only tests and the golden files fix it. */
  nonce?: Uint8Array;
}

/** The core's side: seals the claims for one world. */
export async function sealToken(claims: TokenClaims, options: SealOptions): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = new Uint8Array(options.nonce ?? crypto.getRandomValues(new Uint8Array(TOKEN_NONCE_BYTES)));
  const hw = new BitWriter(TOKEN_HEADER_BYTES);
  TOKEN_HEADER.write(hw, { version: TOKEN_VERSION, world: options.world, expiresAt: options.expiresAt, nonce });
  const header = hw.finish();
  const cw = new BitWriter(128);
  TOKEN_CLAIMS.write(cw, claims);
  const key = await crypto.subtle.importKey('raw', keyBytes(options.key), 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 }, key, cw.finish()));
  const out = new Uint8Array(header.length + cipher.length);
  out.set(header);
  out.set(cipher, header.length);
  return out;
}

export interface OpenOptions {
  /** The world's 32-byte key. */
  key: Uint8Array;
  /** This world's ID: a token for another world is refused. */
  world: string;
  /** The current unix time in seconds. */
  now: number;
}

/** The world server's side: checks and opens a token. Throws TokenError. Refusing a token seen
 *  before (by its nonce, until it expires) is the caller's job. */
export async function openToken(sealed: Uint8Array, options: OpenOptions): Promise<{ header: TokenHeader; claims: TokenClaims }> {
  const header = readTokenHeader(sealed);
  if (header.world !== options.world) throw new TokenError('wrong-world', `the token admits to world ${header.world}`);
  if (options.now >= header.expiresAt) throw new TokenError('expired', `it expired at ${header.expiresAt}; now is ${options.now}`);
  const key = await crypto.subtle.importKey('raw', keyBytes(options.key), 'AES-GCM', false, ['decrypt']);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(header.nonce), additionalData: new Uint8Array(sealed.subarray(0, TOKEN_HEADER_BYTES)), tagLength: 128 },
        key,
        new Uint8Array(sealed.subarray(TOKEN_HEADER_BYTES)),
      ),
    );
  } catch (err) {
    throw new TokenError('invalid', 'the token does not authenticate: another key, or changed on the way', { cause: err });
  }
  try {
    const r = new BitReader(plain);
    const claims = TOKEN_CLAIMS.read(r);
    r.end();
    return { header, claims };
  } catch (err) {
    if (err instanceof ProtocolError) throw new TokenError('malformed', `claims: ${err.message}`, { cause: err });
    throw err;
  }
}
