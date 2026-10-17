// SPDX-License-Identifier: Apache-2.0
// The codecs: each turns one kind of value into bits and back, converts it to and from JSON (the
// golden files, logs, bots), and describes itself in a language-neutral spec that goes into
// golden/schema.json. The exact encoding of every kind is written in docs/protocol.md.
//
// Integer codecs refuse values out of range. Fixed-point numbers round to the nearest step, as
// floor(x + 0.5), and clamp to what their bits can hold, so a position at the edge of its range
// never stops a server tick. Angles wrap. Non-finite numbers are always refused.
import type { BitReader, BitWriter } from './bits.ts';
import { ProtocolError } from './errors.ts';
import { fromHex, toHex } from './hex.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Spec =
  | { kind: 'uint'; bits: number }
  | { kind: 'int'; bits: number }
  | { kind: 'u64' }
  | { kind: 'bool' }
  | { kind: 'fixed'; bits: number; fraction: number; signed: boolean }
  | { kind: 'angle'; bits: number }
  | { kind: 'enum'; bits: number; values: string[] }
  | { kind: 'string'; maxBytes: number }
  | { kind: 'bytes'; maxBytes: number }
  | { kind: 'fixedBytes'; length: number }
  | { kind: 'uuid' }
  | { kind: 'optional'; of: Spec }
  | { kind: 'list'; max: number; of: Spec }
  | { kind: 'struct'; fields: Array<{ name: string; type: Spec }> };

export interface Codec<T> {
  readonly spec: Spec;
  write(w: BitWriter, value: T): void;
  read(r: BitReader): T;
  toJson(value: T): Json;
  fromJson(json: Json): T;
}

export type Infer<C> = C extends Codec<infer T> ? T : never;

const outOfRange = (message: string): ProtocolError => new ProtocolError('out-of-range', message);
const badValue = (message: string): ProtocolError => new ProtocolError('bad-value', message);

function finite(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badValue(`${what}: expected a finite number, got ${String(v)}`);
  return v;
}

function integerIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw outOfRange(`${what}: expected an integer from ${min} to ${max}, got ${String(v)}`);
  }
  return v;
}

function checkBits(bits: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(bits) || bits < min || bits > max) throw new RangeError(`${what}: bits must be ${min} to ${max}, got ${bits}`);
}

/** An unsigned integer of 1 to 32 bits. */
export function uint(bits: number): Codec<number> {
  checkBits(bits, 1, 32, 'uint');
  const max = 2 ** bits - 1;
  return {
    spec: { kind: 'uint', bits },
    write: (w, v) => w.writeBits(integerIn(v, 0, max, `uint${bits}`), bits),
    read: (r) => r.readBits(bits),
    toJson: (v) => v,
    fromJson: (j) => integerIn(j, 0, max, `uint${bits}`),
  };
}

/** A signed integer of 2 to 32 bits, two's complement. */
export function int(bits: number): Codec<number> {
  checkBits(bits, 2, 32, 'int');
  const span = 2 ** bits;
  const min = -(span / 2);
  const max = span / 2 - 1;
  return {
    spec: { kind: 'int', bits },
    write: (w, v) => {
      const n = integerIn(v, min, max, `int${bits}`);
      w.writeBits(n < 0 ? n + span : n, bits);
    },
    read: (r) => {
      const k = r.readBits(bits);
      return k > max ? k - span : k;
    },
    toJson: (v) => v,
    fromJson: (j) => integerIn(j, min, max, `int${bits}`),
  };
}

export const u8 = uint(8);
export const u16 = uint(16);
export const u32 = uint(32);

/** A 64-bit unsigned integer: low 32 bits, then high 32 bits. This implementation holds it as a
 *  JavaScript number, so it accepts and returns only values up to 2^53 − 1. */
export const u64: Codec<number> = {
  spec: { kind: 'u64' },
  write: (w, v) => {
    const n = integerIn(v, 0, Number.MAX_SAFE_INTEGER, 'u64');
    w.writeBits(n % 2 ** 32, 32);
    w.writeBits(Math.floor(n / 2 ** 32), 32);
  },
  read: (r) => {
    const low = r.readBits(32);
    const high = r.readBits(32);
    if (high >= 2 ** 21) throw outOfRange('u64: a value above 2^53 − 1');
    return high * 2 ** 32 + low;
  },
  toJson: (v) => v,
  fromJson: (j) => integerIn(j, 0, Number.MAX_SAFE_INTEGER, 'u64'),
};

export const bool: Codec<boolean> = {
  spec: { kind: 'bool' },
  write: (w, v) => {
    if (typeof v !== 'boolean') throw badValue(`bool: got ${String(v)}`);
    w.writeBits(v ? 1 : 0, 1);
  },
  read: (r) => r.readBits(1) === 1,
  toJson: (v) => v,
  fromJson: (j) => {
    if (typeof j !== 'boolean') throw badValue(`bool: got ${String(j)}`);
    return j;
  },
};

/** A fixed-point number: round(v × 2^fraction) in `bits` bits, two's complement when signed.
 *  Decoding divides by 2^fraction, which is exact. */
export function fixed(bits: number, fraction: number, signed: boolean): Codec<number> {
  checkBits(bits, 2, 32, 'fixed');
  if (!Number.isInteger(fraction) || fraction < 0 || fraction > 16) throw new RangeError(`fixed: fraction must be 0 to 16, got ${fraction}`);
  const scale = 2 ** fraction;
  const span = 2 ** bits;
  const lo = signed ? -(span / 2) : 0;
  const hi = signed ? span / 2 - 1 : span - 1;
  return {
    spec: { kind: 'fixed', bits, fraction, signed },
    write: (w, v) => {
      const k = Math.min(hi, Math.max(lo, Math.floor(finite(v, 'fixed') * scale + 0.5)));
      w.writeBits(k < 0 ? k + span : k, bits);
    },
    read: (r) => {
      const k = r.readBits(bits);
      return (signed && k > hi ? k - span : k) / scale;
    },
    toJson: (v) => v,
    fromJson: (j) => finite(j, 'fixed'),
  };
}

/** An angle in radians, wrapped to [0, 2π) in steps of π / 2^(bits − 1). */
export function angle(bits: number): Codec<number> {
  checkBits(bits, 2, 16, 'angle');
  const span = 2 ** bits;
  const step = Math.PI / 2 ** (bits - 1);
  return {
    spec: { kind: 'angle', bits },
    write: (w, v) => {
      const k = Math.floor(finite(v, 'angle') / step + 0.5) % span;
      w.writeBits(k < 0 ? k + span : k, bits);
    },
    read: (r) => r.readBits(bits) * step,
    toJson: (v) => v,
    fromJson: (j) => finite(j, 'angle'),
  };
}

/** One of a fixed list of names, written as its index. */
export function oneOf<const V extends readonly [string, ...string[]]>(values: V): Codec<V[number]> {
  const bits = Math.max(1, Math.ceil(Math.log2(values.length)));
  const index = new Map<string, number>(values.map((v, i) => [v, i]));
  const check = (v: unknown): V[number] => {
    if (typeof v !== 'string' || !index.has(v)) throw badValue(`enum: ${String(v)} is not one of ${values.join(', ')}`);
    return v as V[number];
  };
  return {
    spec: { kind: 'enum', bits, values: [...values] },
    write: (w, v) => w.writeBits(index.get(check(v))!, bits),
    read: (r) => {
      const i = r.readBits(bits);
      const v = values[i];
      if (v === undefined) throw outOfRange(`enum: index ${i} of ${values.length}`);
      return v;
    },
    toJson: (v) => v,
    fromJson: check,
  };
}

const encoder = new TextEncoder();
// fatal: invalid UTF-8 throws; ignoreBOM: a leading U+FEFF is text, not a marker to drop.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function rawBytes(r: BitReader, maxBytes: number, what: string): Uint8Array {
  const n = r.readVarUint();
  if (n > maxBytes) throw new ProtocolError('too-long', `${what}: ${n} bytes, the limit is ${maxBytes}`);
  r.align();
  return r.readBytes(n);
}

function writeRaw(w: BitWriter, bytes: Uint8Array, maxBytes: number, what: string): void {
  if (bytes.length > maxBytes) throw new ProtocolError('too-long', `${what}: ${bytes.length} bytes, the limit is ${maxBytes}`);
  w.writeVarUint(bytes.length);
  w.align();
  w.writeBytes(bytes);
}

/** UTF-8 text of at most maxBytes bytes: its byte length, then the bytes from a byte boundary. */
export function str(maxBytes: number): Codec<string> {
  const check = (v: unknown): string => {
    if (typeof v !== 'string') throw badValue(`string: got ${String(v)}`);
    if (!v.isWellFormed()) throw new ProtocolError('bad-utf8', 'string: a lone surrogate cannot be written as UTF-8');
    return v;
  };
  return {
    spec: { kind: 'string', maxBytes },
    write: (w, v) => writeRaw(w, encoder.encode(check(v)), maxBytes, 'string'),
    read: (r) => {
      const bytes = rawBytes(r, maxBytes, 'string');
      try {
        return decoder.decode(bytes);
      } catch {
        throw new ProtocolError('bad-utf8', 'string: not valid UTF-8');
      }
    },
    toJson: (v) => v,
    fromJson: check,
  };
}

function checkBytes(v: unknown, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw badValue(`${what}: expected a Uint8Array`);
  return v;
}

function hexJson(j: Json, what: string): Uint8Array {
  if (typeof j !== 'string') throw badValue(`${what}: expected a hexadecimal string`);
  return fromHex(j);
}

/** Bytes of at most maxBytes: the length, then the bytes from a byte boundary. */
export function bytes(maxBytes: number): Codec<Uint8Array> {
  return {
    spec: { kind: 'bytes', maxBytes },
    write: (w, v) => writeRaw(w, checkBytes(v, 'bytes'), maxBytes, 'bytes'),
    // new Uint8Array(view) always copies; a Node Buffer's slice() would return a view.
    read: (r) => new Uint8Array(rawBytes(r, maxBytes, 'bytes')),
    toJson: (v) => toHex(v),
    fromJson: (j) => {
      const b = hexJson(j, 'bytes');
      if (b.length > maxBytes) throw new ProtocolError('too-long', `bytes: ${b.length} bytes, the limit is ${maxBytes}`);
      return b;
    },
  };
}

/** Exactly `length` bytes from a byte boundary, with no length in front. */
export function fixedBytes(length: number): Codec<Uint8Array> {
  const check = (b: Uint8Array): Uint8Array => {
    if (b.length !== length) throw badValue(`fixedBytes: expected ${length} bytes, got ${b.length}`);
    return b;
  };
  return {
    spec: { kind: 'fixedBytes', length },
    write: (w, v) => {
      w.align();
      w.writeBytes(check(checkBytes(v, 'fixedBytes')));
    },
    read: (r) => {
      r.align();
      return new Uint8Array(r.readBytes(length));
    },
    toJson: (v) => toHex(v),
    fromJson: (j) => check(hexJson(j, 'fixedBytes')),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A UUID, written as its 16 bytes from a byte boundary; in code and JSON, the lowercase
 *  8-4-4-4-12 form (lowercase only, so a decoded value always equals the encoded one). */
export const uuid: Codec<string> = {
  spec: { kind: 'uuid' },
  write: (w, v) => {
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw badValue(`uuid: expected lowercase 8-4-4-4-12 hexadecimal, got ${String(v)}`);
    w.align();
    w.writeBytes(fromHex(v.replaceAll('-', '')));
  },
  read: (r) => {
    r.align();
    const h = toHex(r.readBytes(16));
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  toJson: (v) => v,
  fromJson: (j) => {
    if (typeof j !== 'string' || !UUID_RE.test(j)) throw badValue(`uuid: expected lowercase 8-4-4-4-12 hexadecimal, got ${String(j)}`);
    return j;
  },
};

/** A value that may be absent: one bit, then the value when the bit is 1. In a struct an absent
 *  field is left out of the object; in JSON it is left out too. */
export function optional<T>(of: Codec<T>): Codec<T | undefined> {
  return {
    spec: { kind: 'optional', of: of.spec },
    write: (w, v) => {
      w.writeBits(v === undefined ? 0 : 1, 1);
      if (v !== undefined) of.write(w, v);
    },
    read: (r) => (r.readBits(1) === 1 ? of.read(r) : undefined),
    toJson: (v) => (v === undefined ? null : of.toJson(v)),
    fromJson: (j) => (j === null ? undefined : of.fromJson(j)),
  };
}

/** Up to `max` values: the count, then each value. */
export function list<T>(of: Codec<T>, max: number): Codec<T[]> {
  const check = (v: unknown): unknown[] => {
    if (!Array.isArray(v)) throw badValue('list: expected an array');
    if (v.length > max) throw new ProtocolError('too-long', `list: ${v.length} items, the limit is ${max}`);
    return v;
  };
  return {
    spec: { kind: 'list', max, of: of.spec },
    write: (w, v) => {
      w.writeVarUint(check(v).length);
      for (const item of v) of.write(w, item);
    },
    read: (r) => {
      const n = r.readVarUint();
      if (n > max) throw new ProtocolError('too-long', `list: ${n} items, the limit is ${max}`);
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(of.read(r));
      return out;
    },
    toJson: (v) => v.map((item) => of.toJson(item)),
    fromJson: (j) => check(j).map((item) => of.fromJson(item as Json)),
  };
}

export type Fields = Record<string, Codec<unknown>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<F extends Fields> = { [K in keyof F]: undefined extends Infer<F[K]> ? K : never }[keyof F];
export type StructValue<F extends Fields> = Simplify<
  { [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Exclude<Infer<F[K]>, undefined> }
>;

const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/** Named fields, written in the order they are declared. */
export function struct<F extends Fields>(fields: F): Codec<StructValue<F>> {
  const entries = Object.entries(fields);
  for (const [name] of entries) {
    if (!FIELD_NAME.test(name)) throw new RangeError(`struct: field names are lowerCamelCase words, got ${name}`);
  }
  const record = (v: unknown, what: string): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw badValue(`${what}: expected an object`);
    return v as Record<string, unknown>;
  };
  const required = new Set(entries.filter(([, c]) => c.spec.kind !== 'optional').map(([name]) => name));
  const present = (obj: Record<string, unknown>, name: string): unknown => {
    const value = obj[name];
    if (value === undefined && required.has(name)) throw badValue(`struct: missing field ${name}`);
    return value;
  };
  return {
    spec: { kind: 'struct', fields: entries.map(([name, c]) => ({ name, type: c.spec })) },
    write: (w, v) => {
      const obj = record(v, 'struct');
      for (const [name, c] of entries) c.write(w, present(obj, name));
    },
    read: (r) => {
      const out: Record<string, unknown> = {};
      for (const [name, c] of entries) {
        const value = c.read(r);
        if (value !== undefined) out[name] = value;
      }
      return out as StructValue<F>;
    },
    toJson: (v) => {
      const obj = record(v, 'struct');
      const out: { [key: string]: Json } = {};
      for (const [name, c] of entries) {
        if (obj[name] !== undefined) out[name] = c.toJson(obj[name]);
      }
      return out;
    },
    fromJson: (j) => {
      const obj = record(j, 'struct');
      const unknown = Object.keys(obj).filter((k) => !(k in fields));
      if (unknown.length > 0) throw badValue(`struct: unknown field(s) ${unknown.join(', ')}`);
      const out: Record<string, unknown> = {};
      for (const [name, c] of entries) {
        const j = present(obj, name);
        const value = c.fromJson(j === undefined ? null : (j as Json));
        if (value !== undefined) out[name] = value;
      }
      return out as StructValue<F>;
    },
  };
}
