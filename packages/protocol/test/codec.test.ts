// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  angle,
  BitReader,
  BitWriter,
  bytes,
  type Codec,
  fixed,
  fixedBytes,
  int,
  list,
  oneOf,
  optional,
  ProtocolError,
  str,
  struct,
  toHex,
  fromHex,
  u16,
  u64,
  uint,
  uuid,
} from '../src/index.ts';

function enc<T>(c: Codec<T>, v: T): string {
  const w = new BitWriter();
  c.write(w, v);
  return toHex(w.finish());
}

function dec<T>(c: Codec<T>, hex: string): T {
  const r = new BitReader(fromHex(hex));
  const v = c.read(r);
  r.end();
  return v;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ProtocolError ? err.code : `not a ProtocolError: ${String(err)}`;
  }
  return 'no error';
}

describe('integer codecs', () => {
  it('refuse values outside their bits', () => {
    expect(enc(uint(4), 15)).toBe('0f');
    expect(code(() => enc(uint(4), 16))).toBe('out-of-range');
    expect(code(() => enc(uint(4), -1))).toBe('out-of-range');
    expect(code(() => enc(u16, 1.5))).toBe('out-of-range');
  });

  it('write signed integers in two’s complement', () => {
    expect(enc(int(4), -1)).toBe('0f');
    expect(enc(int(16), -2)).toBe('feff');
    expect(dec(int(16), 'feff')).toBe(-2);
    expect(dec(int(16), '0080')).toBe(-32768);
    expect(code(() => enc(int(4), 8))).toBe('out-of-range');
  });

  it('write a 64-bit value as two halves and refuse one past 2^53 − 1', () => {
    expect(enc(u64, 2 ** 40 + 5)).toBe('0500000000010000');
    expect(dec(u64, '0500000000010000')).toBe(2 ** 40 + 5);
    expect(dec(u64, 'ffffffffffff1f00')).toBe(Number.MAX_SAFE_INTEGER);
    expect(code(() => dec(u64, '0000000000002000'))).toBe('out-of-range');
  });
});

describe('fixed-point numbers', () => {
  const metres = fixed(12, 7, false);

  it('round to the nearest step, halves up', () => {
    expect(dec(metres, enc(metres, 0.0039))).toBe(0);
    expect(dec(metres, enc(metres, 0.004))).toBe(1 / 128);
    expect(dec(metres, enc(metres, 1 / 256))).toBe(1 / 128);
  });

  it('clamp to what the bits hold instead of failing', () => {
    expect(dec(metres, enc(metres, 40))).toBe(4095 / 128);
    expect(dec(metres, enc(metres, -1))).toBe(0);
    const signed = fixed(8, 6, true);
    expect(dec(signed, enc(signed, -5))).toBe(-2);
    expect(dec(signed, enc(signed, 5))).toBe(127 / 64);
    expect(code(() => enc(metres, Number.NaN))).toBe('bad-value');
  });

  it('stay within half a step of any value in range', () => {
    const height = fixed(18, 7, true);
    for (let i = 0; i < 1000; i++) {
      const v = (Math.random() - 0.5) * 2000;
      expect(Math.abs(dec(height, enc(height, v)) - v)).toBeLessThanOrEqual(1 / 256 + 1e-12);
    }
  });

  it('give back exactly what they decoded (a relayed value never drifts)', () => {
    const coord = fixed(28, 7, true);
    for (let i = 0; i < 1000; i++) {
      const once = dec(coord, enc(coord, (Math.random() - 0.5) * 2e6));
      expect(dec(coord, enc(coord, once))).toBe(once);
    }
  });
});

describe('angles', () => {
  const yaw = angle(10);

  it('wrap into [0, 2π)', () => {
    expect(dec(yaw, enc(yaw, -Math.PI / 2))).toBe((3 * Math.PI) / 2);
    expect(dec(yaw, enc(yaw, 2 * Math.PI))).toBe(0);
    expect(dec(yaw, enc(yaw, 5 * Math.PI))).toBe(Math.PI);
    expect(code(() => enc(yaw, Number.POSITIVE_INFINITY))).toBe('bad-value');
  });

  it('give back exactly what they decoded', () => {
    for (let i = 0; i < 1000; i++) {
      const once = dec(yaw, enc(yaw, (Math.random() - 0.5) * 20));
      expect(dec(yaw, enc(yaw, once))).toBe(once);
    }
  });
});

describe('names, text and bytes', () => {
  it('write a name as its index and refuse unknown ones', () => {
    const stance = oneOf(['a', 'b', 'c']);
    expect(stance.spec).toEqual({ kind: 'enum', bits: 2, values: ['a', 'b', 'c'] });
    expect(enc(stance, 'c')).toBe('02');
    expect(code(() => enc(stance, 'd' as 'a'))).toBe('bad-value');
    expect(code(() => dec(stance, '03'))).toBe('out-of-range');
  });

  it('count a string’s limit in UTF-8 bytes and keep every character', () => {
    const name = str(4);
    expect(enc(name, 'ñañ'.slice(0, 2))).toBe('03c3b161');
    expect(code(() => enc(name, 'ñañ'))).toBe('too-long');
    expect(dec(str(8), enc(str(8), '\ufeffa🎮'))).toBe('\ufeffa🎮');
    expect(code(() => enc(name, '\ud800'))).toBe('bad-utf8');
    expect(code(() => dec(name, '01ff'))).toBe('bad-utf8');
    expect(code(() => dec(name, '05616161616161'))).toBe('too-long');
  });

  it('copy byte strings out of the packet they came in', () => {
    const packet = fromHex('02abcd');
    const r = new BitReader(packet);
    const value = bytes(4).read(r);
    packet[1] = 0;
    expect(toHex(value)).toBe('abcd');
    expect(code(() => enc(bytes(1), fromHex('abcd')))).toBe('too-long');
    expect(code(() => enc(fixedBytes(2), fromHex('ab')))).toBe('bad-value');
    expect(code(() => bytes(4).fromJson('ABCD'))).toBe('bad-value');
  });

  it('write UUIDs as 16 bytes and accept only the lowercase form', () => {
    const id = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
    expect(enc(uuid, id)).toBe('0f1e2d3c4b5a49788796a5b4c3d2e1f0');
    expect(dec(uuid, '0f1e2d3c4b5a49788796a5b4c3d2e1f0')).toBe(id);
    expect(code(() => enc(uuid, id.toUpperCase()))).toBe('bad-value');
  });
});

describe('optional values, lists and structs', () => {
  const point = struct({ id: u16, label: optional(str(8)), tags: list(uint(4), 3) });

  it('mark an absent value with one bit and leave it out of the object', () => {
    expect(enc(point, { id: 1, tags: [] })).toBe('01000000');
    const back = dec(point, enc(point, { id: 1, label: 'a', tags: [2, 3] }));
    expect(back).toEqual({ id: 1, label: 'a', tags: [2, 3] });
    expect(Object.keys(dec(point, '01000000'))).toEqual(['id', 'tags']);
  });

  it('refuse lists over their limit, missing fields and unknown JSON fields', () => {
    expect(code(() => enc(point, { id: 1, tags: [1, 2, 3, 4] }))).toBe('too-long');
    expect(code(() => dec(point, '01000800'))).toBe('too-long');
    expect(code(() => enc(point, { tags: [] } as unknown as { id: number; tags: number[] }))).toBe('bad-value');
    expect(code(() => point.fromJson({ id: 1, tags: [], colour: 'red' }))).toBe('bad-value');
    expect(code(() => point.fromJson({ id: 1, tags: 'no' }))).toBe('bad-value');
  });

  it('turn into JSON and back, bytes as hexadecimal', () => {
    const blob = struct({ data: bytes(4), at: optional(u64) });
    const value = { data: fromHex('00ff') };
    expect(blob.toJson(value)).toEqual({ data: '00ff' });
    expect(blob.fromJson({ data: '00ff', at: null })).toEqual(value);
  });

  it('allow only lowerCamelCase field names', () => {
    expect(() => struct({ Bad: u16 })).toThrow(RangeError);
    expect(() => struct({ '1': u16 })).toThrow(RangeError);
  });
});
