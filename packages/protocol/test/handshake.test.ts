// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkVersion, decodeMessage, encodeMessage, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, versionPolicy } from '../src/index.ts';

const hello = (protocol: number, fingerprint = SCHEMA_FINGERPRINT): { protocol: number; fingerprint: number } => ({ protocol, fingerprint });

describe('the version handshake', () => {
  it('accepts a client of the same version and schema', () => {
    expect(checkVersion(hello(PROTOCOL_VERSION), versionPolicy())).toBeUndefined();
  });

  it('tells an older client to update, and a newer one that the world is older', () => {
    const policy = { min: 3, max: 4, fingerprints: new Map<number, number>() };
    expect(checkVersion(hello(2), policy)).toEqual({ reason: 'client-outdated', protocolMin: 3, protocolMax: 4, detail: '' });
    expect(checkVersion(hello(5), policy)).toMatchObject({ reason: 'server-outdated', protocolMin: 3, protocolMax: 4 });
    expect(checkVersion(hello(4), policy)).toBeUndefined();
  });

  it('refuses everyone when the core’s minimum is above this server', () => {
    const policy = versionPolicy(PROTOCOL_VERSION + 1);
    expect(checkVersion(hello(PROTOCOL_VERSION), policy)).toMatchObject({ reason: 'server-outdated', protocolMin: PROTOCOL_VERSION + 1 });
    expect(checkVersion(hello(PROTOCOL_VERSION + 1), policy)?.reason).toBe('server-outdated');
  });

  it('refuses a client built from another schema under the same version', () => {
    const refusal = checkVersion(hello(PROTOCOL_VERSION, SCHEMA_FINGERPRINT ^ 1), versionPolicy());
    expect(refusal?.reason).toBe('schema-mismatch');
    expect(refusal?.detail).toContain(SCHEMA_FINGERPRINT.toString(16).padStart(8, '0'));
  });

  it('gives a refusal that travels as a refuse message', () => {
    const refusal = checkVersion(hello(PROTOCOL_VERSION + 1), versionPolicy());
    if (!refusal) throw new Error('expected a refusal');
    expect(decodeMessage(encodeMessage({ type: 'refuse', ...refusal }), 'server')).toEqual({ type: 'refuse', ...refusal });
  });
});
