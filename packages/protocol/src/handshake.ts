// SPDX-License-Identifier: Apache-2.0
// The version handshake (R-17): a world server answers a client's hello with welcome or refuse.
// It accepts the protocol versions in its policy: its own version, raised to the core's minimum
// when the core sets one, with the schema fingerprint it expects for each. Anything else gets a
// refusal the client can explain: update the client, or the world runs an older server.
import { fingerprintHex, SCHEMA_FINGERPRINT } from './fingerprint.ts';
import type { MessageBody } from './messages.ts';
import { PROTOCOL_VERSION } from './schema.ts';

export interface VersionPolicy {
  /** The lowest version accepted. */
  min: number;
  /** The highest version accepted. */
  max: number;
  /** The schema fingerprint expected for each accepted version. */
  fingerprints: ReadonlyMap<number, number>;
}

export type Refusal = MessageBody<'refuse'>;

/** This build's policy. `coreMinimum` is the lowest version the core still allows; a server below
 *  it accepts nobody, and says so. */
export function versionPolicy(coreMinimum = 0): VersionPolicy {
  return {
    min: Math.max(PROTOCOL_VERSION, coreMinimum),
    max: PROTOCOL_VERSION,
    fingerprints: new Map([[PROTOCOL_VERSION, SCHEMA_FINGERPRINT]]),
  };
}

/** The first check of a hello: undefined when its version is accepted, or the refusal to send. */
export function checkVersion(hello: { protocol: number; fingerprint: number }, policy: VersionPolicy): Refusal | undefined {
  const refuse = (reason: Refusal['reason'], detail = ''): Refusal => ({ reason, protocolMin: policy.min, protocolMax: policy.max, detail });
  if (policy.min > policy.max) return refuse('server-outdated', 'this world server is older than the core allows');
  if (hello.protocol < policy.min) return refuse('client-outdated');
  if (hello.protocol > policy.max) return refuse('server-outdated');
  const expected = policy.fingerprints.get(hello.protocol);
  if (expected !== undefined && expected !== hello.fingerprint) {
    return refuse('schema-mismatch', `version ${hello.protocol}: schema ${fingerprintHex(hello.fingerprint)}, expected ${fingerprintHex(expected)}`);
  }
  return undefined;
}
