// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  newWorldKey,
  openToken,
  readTokenHeader,
  sealToken,
  TOKEN_HEADER_BYTES,
  TOKEN_VERSION,
  type TokenClaims,
  TokenError,
} from '../src/index.ts';

const WORLD = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const OTHER = '11111111-2222-4333-8444-555555555555';
const NOW = 1_800_000_000;
const claims: TokenClaims = {
  account: '6b0e2c1a-7f3d-4e8a-9c21-5d4f3a2b1c0e',
  name: 'Kyonax',
  trust: 4,
  tester: true,
  emailVerified: true,
  under18: false,
  ageDays: 30,
  owner: false,
  contact: 'everyone',
  friends: [],
  blocks: [],
};

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof TokenError ? err.code : `not a TokenError: ${String(err)}`;
  }
  return 'no error';
}

describe('connect tokens', () => {
  it('open with the world’s key and give back the claims', async () => {
    const key = newWorldKey();
    const sealed = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    const opened = await openToken(sealed, { key, world: WORLD, now: NOW });
    expect(opened.claims).toEqual(claims);
    expect(opened.header).toMatchObject({ version: TOKEN_VERSION, world: WORLD, expiresAt: NOW + 60 });
    expect(readTokenHeader(sealed).nonce).toEqual(opened.header.nonce);
  });

  it('get a fresh nonce every time, so a world can refuse one it has seen', async () => {
    const key = newWorldKey();
    const a = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    const b = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    expect(readTokenHeader(a).nonce).not.toEqual(readTokenHeader(b).nonce);
  });

  it('are refused when expired, for another world or under another key', async () => {
    const key = newWorldKey();
    const sealed = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    expect(await errorCode(openToken(sealed, { key, world: WORLD, now: NOW + 60 }))).toBe('expired');
    expect(await errorCode(openToken(sealed, { key, world: OTHER, now: NOW }))).toBe('wrong-world');
    expect(await errorCode(openToken(sealed, { key: newWorldKey(), world: WORLD, now: NOW }))).toBe('invalid');
  });

  it('are refused after any byte changes', async () => {
    const key = newWorldKey();
    const sealed = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    for (let i = 1; i < sealed.length; i++) {
      if (i >= 1 && i < 17) continue; // the world ID: refused as wrong-world, checked above
      const changed = sealed.slice();
      changed[i] = (changed[i] ?? 0) ^ 0x10;
      const result = await errorCode(openToken(changed, { key, world: WORLD, now: NOW }));
      // A changed expiry may land in the past (expired) or past 2^53 − 1 (malformed) before the tag is checked.
      expect([i, result]).toEqual([i, i >= 17 && i < 25 ? expect.stringMatching(/^(invalid|expired|malformed)$/) : 'invalid']);
    }
  });

  it('are refused when cut short or written in another format', async () => {
    const key = newWorldKey();
    const sealed = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    expect(await errorCode(openToken(sealed.slice(0, TOKEN_HEADER_BYTES + 15), { key, world: WORLD, now: NOW }))).toBe('malformed');
    const other = sealed.slice();
    other[0] = TOKEN_VERSION + 1;
    expect(await errorCode(openToken(other, { key, world: WORLD, now: NOW }))).toBe('unsupported-version');
  });

  it('are refused when they authenticate but their claims do not parse', async () => {
    const key = newWorldKey();
    const sealed = await sealToken(claims, { key, world: WORLD, expiresAt: NOW + 60 });
    const header = sealed.slice(0, TOKEN_HEADER_BYTES);
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const junk = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: header.slice(25), additionalData: header }, k, new Uint8Array([1, 2, 3])));
    const forged = new Uint8Array([...header, ...junk]);
    expect(await errorCode(openToken(forged, { key, world: WORLD, now: NOW }))).toBe('malformed');
  });

  it('need a 32-byte key', async () => {
    await expect(sealToken(claims, { key: new Uint8Array(16), world: WORLD, expiresAt: NOW })).rejects.toThrow(RangeError);
  });
});
