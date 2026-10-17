// SPDX-License-Identifier: Apache-2.0
// The schema as language-neutral data (written to golden/schema.json for other implementations),
// and its fingerprint: FNV-1a (32 bits) over that data's JSON text. A client's hello carries the
// fingerprint, so a server and a client built from different schemas under the same version
// number refuse each other instead of misreading each other's bytes.
import { CELL_BLOCK, CELL_SIZE, MAX_MESSAGE_BYTES, MESSAGES, TOKEN_CLAIMS, TOKEN_HEADER, TOKEN_VERSION } from './schema.ts';

export function describeSchema() {
  return {
    constants: { maxMessageBytes: MAX_MESSAGE_BYTES, cellSize: CELL_SIZE },
    messages: Object.entries(MESSAGES).map(([name, def]) => ({
      name,
      id: def.id,
      from: def.from,
      channel: def.channel,
      body: def.body.spec,
    })),
    cellBlock: CELL_BLOCK.spec,
    token: { version: TOKEN_VERSION, cipher: 'AES-256-GCM', header: TOKEN_HEADER.spec, claims: TOKEN_CLAIMS.spec },
  };
}

export type SchemaDescription = ReturnType<typeof describeSchema>;

/** FNV-1a, 32 bits, over the UTF-8 bytes of a string. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const SCHEMA_FINGERPRINT = fnv1a32(JSON.stringify(describeSchema()));

/** The fingerprint as 8 lowercase hexadecimal digits, as logs and schema.json write it. */
export const fingerprintHex = (fingerprint: number = SCHEMA_FINGERPRINT): string => fingerprint.toString(16).padStart(8, '0');
