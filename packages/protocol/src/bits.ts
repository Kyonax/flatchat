// SPDX-License-Identifier: Apache-2.0
// Writing and reading bits. Bits are packed least significant first: the first bit written is
// bit 0 of byte 0, and an n-bit value is written from its lowest bit up, so a byte-aligned 16- or
// 32-bit value comes out little-endian. Byte strings start on a byte boundary (align). A message
// ends with zero bits up to a whole byte; the reader refuses non-zero padding and extra bytes, so
// every value has exactly one encoding.
import { ProtocolError } from './errors.ts';

export class BitWriter {
  private buf: Uint8Array<ArrayBuffer>;
  private bit = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(Math.max(1, capacity));
  }

  /** Bits written so far. */
  get bitLength(): number {
    return this.bit;
  }

  private reserve(bits: number): void {
    const need = Math.ceil((this.bit + bits) / 8);
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
  }

  /** Writes an integer from 0 to 2^bits − 1 in `bits` bits (1 to 32). */
  writeBits(value: number, bits: number): void {
    this.reserve(bits);
    let v = value >>> 0;
    let n = bits;
    while (n > 0) {
      const index = this.bit >>> 3;
      const offset = this.bit & 7;
      const take = Math.min(8 - offset, n);
      this.buf[index] = (this.buf[index] ?? 0) | ((v & ((1 << take) - 1)) << offset);
      v >>>= take;
      n -= take;
      this.bit += take;
    }
  }

  /** A length or count: 7 bits per byte, low groups first, the top bit set while more follow. */
  writeVarUint(value: number): void {
    let v = value;
    do {
      const group = v % 128;
      v = Math.floor(v / 128);
      this.writeBits(v > 0 ? group | 0x80 : group, 8);
    } while (v > 0);
  }

  /** Pads with zero bits to the next byte boundary. */
  align(): void {
    this.bit = Math.ceil(this.bit / 8) * 8;
  }

  /** Copies bytes; the writer must be on a byte boundary. */
  writeBytes(bytes: Uint8Array): void {
    if (this.bit % 8 !== 0) throw new Error('writeBytes needs a byte boundary: call align() first');
    this.reserve(bytes.length * 8);
    this.buf.set(bytes, this.bit / 8);
    this.bit += bytes.length * 8;
  }

  /** The bytes written, padded to a whole byte. */
  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, Math.ceil(this.bit / 8));
  }
}

export class BitReader {
  private readonly buf: Uint8Array;
  private bit = 0;

  constructor(bytes: Uint8Array) {
    this.buf = bytes;
  }

  /** Bits read so far. */
  get bitPosition(): number {
    return this.bit;
  }

  /** Reads an unsigned integer of `bits` bits (1 to 32). */
  readBits(bits: number): number {
    if (this.bit + bits > this.buf.length * 8) {
      throw new ProtocolError('truncated', `needed ${bits} more bits at bit ${this.bit} of ${this.buf.length * 8}`);
    }
    let value = 0;
    let shift = 0;
    let n = bits;
    while (n > 0) {
      const index = this.bit >>> 3;
      const offset = this.bit & 7;
      const take = Math.min(8 - offset, n);
      value += (((this.buf[index] ?? 0) >>> offset) & ((1 << take) - 1)) * 2 ** shift;
      shift += take;
      n -= take;
      this.bit += take;
    }
    return value;
  }

  /** Reads a length or count written by writeVarUint; refuses padded or over-long forms. */
  readVarUint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.readBits(8);
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new ProtocolError('bad-varint', 'a length written with more bytes than it needs');
        if (value > 0xffffffff) throw new ProtocolError('bad-varint', 'a length above 2^32 − 1');
        return value;
      }
      scale *= 128;
    }
    throw new ProtocolError('bad-varint', 'a length longer than 5 bytes');
  }

  /** Skips to the next byte boundary; the skipped bits must be zero. */
  align(): void {
    const pad = (8 - (this.bit % 8)) % 8;
    if (pad > 0 && this.readBits(pad) !== 0) throw new ProtocolError('padding', `non-zero padding before bit ${this.bit}`);
  }

  /** Reads n bytes from a byte boundary (a view into the input, not a copy). */
  readBytes(n: number): Uint8Array {
    if (this.bit % 8 !== 0) throw new Error('readBytes needs a byte boundary: call align() first');
    const start = this.bit / 8;
    if (start + n > this.buf.length) throw new ProtocolError('truncated', `needed ${n} bytes at byte ${start} of ${this.buf.length}`);
    this.bit += n * 8;
    return this.buf.subarray(start, start + n);
  }

  /** Checks that the message ended here: zero padding to the byte boundary and no bytes after it. */
  end(): void {
    this.align();
    if (this.bit / 8 !== this.buf.length) {
      throw new ProtocolError('trailing', `${this.buf.length - this.bit / 8} byte(s) after the end of the message`);
    }
  }
}
