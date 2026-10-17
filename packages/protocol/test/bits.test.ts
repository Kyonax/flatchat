// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter, ProtocolError, toHex, fromHex } from '../src/index.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ProtocolError ? err.code : `not a ProtocolError: ${String(err)}`;
  }
  return 'no error';
}

describe('BitWriter and BitReader', () => {
  it('packs bits least significant first', () => {
    const w = new BitWriter();
    w.writeBits(1, 1);
    w.writeBits(0b10, 2);
    w.writeBits(0b11111, 5);
    expect(toHex(w.finish())).toBe('fd');
  });

  it('writes byte-aligned 16- and 32-bit values little-endian', () => {
    const w = new BitWriter();
    w.writeBits(0x0102, 16);
    w.writeBits(0x0a0b0c0d, 32);
    expect(toHex(w.finish())).toBe('02010d0c0b0a');
  });

  it('reads back values of every width at every bit offset', () => {
    const values: Array<[number, number]> = [];
    let seed = 7;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const bits = 1 + (next() % 32);
      values.push([next() % 2 ** bits, bits]);
    }
    const w = new BitWriter(1);
    for (const [v, bits] of values) w.writeBits(v, bits);
    const r = new BitReader(w.finish());
    for (const [v, bits] of values) expect(r.readBits(bits)).toBe(v);
    r.end();
  });

  it('writes lengths as 7-bit groups and refuses padded or long forms', () => {
    const enc = (n: number): string => {
      const w = new BitWriter();
      w.writeVarUint(n);
      return toHex(w.finish());
    };
    expect([0, 127, 128, 300, 2 ** 32 - 1].map(enc)).toEqual(['00', '7f', '8001', 'ac02', 'ffffffff0f']);
    expect(new BitReader(fromHex('ac02')).readVarUint()).toBe(300);
    expect(code(() => new BitReader(fromHex('8000')).readVarUint())).toBe('bad-varint');
    expect(code(() => new BitReader(fromHex('808080808001')).readVarUint())).toBe('bad-varint');
    expect(code(() => new BitReader(fromHex('ffffffff1f')).readVarUint())).toBe('bad-varint');
  });

  it('aligns byte strings and pads with zero bits', () => {
    const w = new BitWriter();
    w.writeBits(1, 3);
    w.align();
    w.writeBytes(fromHex('abcd'));
    w.writeBits(1, 1);
    expect(toHex(w.finish())).toBe('01abcd01');
    expect(() => w.writeBytes(fromHex('00'))).toThrow(/byte boundary/);
  });

  it('refuses a short message, extra bytes and non-zero padding', () => {
    expect(code(() => new BitReader(fromHex('01')).readBits(9))).toBe('truncated');
    expect(code(() => new BitReader(fromHex('0102')).readBytes(3))).toBe('truncated');
    const trailing = new BitReader(fromHex('0100'));
    trailing.readBits(8);
    expect(code(() => trailing.end())).toBe('trailing');
    const padded = new BitReader(fromHex('03'));
    padded.readBits(1);
    expect(code(() => padded.end())).toBe('padding');
  });
});
