// SPDX-License-Identifier: Apache-2.0
// Lowercase hexadecimal for byte strings: how the golden files and the JSON form write bytes.
import { ProtocolError } from './errors.ts';

const DIGITS = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += DIGITS[b >>> 4]! + DIGITS[b & 15]!;
  return out;
}

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new ProtocolError('bad-value', `not lowercase hexadecimal with whole bytes: ${text.slice(0, 40)}`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
