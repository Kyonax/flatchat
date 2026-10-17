// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { GOLDEN } from '../src/golden.ts';
import {
  CELL_SIZE,
  decodeCellBlock,
  decodeMessage,
  encodeCellBlock,
  encodeMessage,
  fromHex,
  MAX_MESSAGE_BYTES,
  type Message,
  messageDef,
  messageFromJson,
  MESSAGES,
  ProtocolError,
} from '../src/index.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ProtocolError ? err.code : `not a ProtocolError: ${String(err)}`;
  }
  return 'no error';
}

const samples: Message[] = GOLDEN.messages.cases.map((c) => messageFromJson(c.value));

describe('messages', () => {
  it('have a golden case for every type', () => {
    const covered = new Set(samples.map((m) => m.type));
    expect(Object.keys(MESSAGES).filter((name) => !covered.has(name as Message['type']))).toEqual([]);
  });

  it('are refused from the side that may not send them', () => {
    for (const m of samples) {
      const bytes = encodeMessage(m);
      const { from } = messageDef(m.type);
      if (from !== 'server') expect(decodeMessage(bytes, 'client').type).toBe(m.type);
      if (from !== 'client') expect(decodeMessage(bytes, 'server').type).toBe(m.type);
      if (from === 'client') expect(code(() => decodeMessage(bytes, 'server'))).toBe('wrong-direction');
      if (from === 'server') expect(code(() => decodeMessage(bytes, 'client'))).toBe('wrong-direction');
    }
  });

  it('are refused over the size limit, before any parsing', () => {
    expect(code(() => decodeMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1).fill(0x21)))).toBe('too-long');
    const block = new Uint8Array(4096);
    const big: Message = { type: 'snapshot', tick: 1, blocks: Array.from({ length: 17 }, () => block) };
    expect(code(() => encodeMessage(big))).toBe('too-long');
  });

  it('throw only ProtocolError for any bytes a stranger can send', () => {
    let seed = 1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const ids = Object.values(MESSAGES).map((d) => d.id);
    const encoded = samples.map((m) => encodeMessage(m));
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      let bytes: Uint8Array;
      if (i % 2 === 0) {
        bytes = new Uint8Array(1 + (next() % 64)).map(() => next() & 0xff);
        bytes[0] = ids[next() % ids.length]!;
      } else {
        const base = encoded[next() % encoded.length]!;
        bytes = base.slice(0, 1 + (next() % base.length));
        const at = next() % bytes.length;
        bytes[at] = (bytes[at] ?? 0) ^ (1 << (next() % 8));
      }
      try {
        decodeMessage(bytes, next() % 2 === 0 ? 'client' : 'server');
        accepted += 1;
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw new Error(`${String(err)} for ${Array.from(bytes).join(',')}`, { cause: err });
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('decoding from a Node.js Buffer', () => {
  it('returns byte strings as plain copies, never views into the packet', () => {
    const opus = new Uint8Array([1, 2, 3, 4]);
    const packet = Buffer.from(encodeMessage({ type: 'voice', seq: 1, start: true, mouth: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 }, opus }));
    const decoded = decodeMessage(packet, 'client');
    if (decoded.type !== 'voice') throw new Error('not a voice message');
    expect(decoded.opus.constructor).toBe(Uint8Array);
    packet.fill(0);
    expect(decoded.opus).toEqual(opus);
  });
});

describe('cell blocks', () => {
  it('place avatars by offsets from the cell corner', () => {
    const block = { cx: -1, cz: 2, full: [{ id: 5, x: 31.5, y: 1, z: 0.25, yaw: 0, look: 0, stance: 'standing' as const }], coarse: [] };
    const back = decodeCellBlock(encodeCellBlock(block));
    const avatar = back.full[0]!;
    expect([back.cx * CELL_SIZE + avatar.x, back.cz * CELL_SIZE + avatar.z]).toEqual([-0.5, 64.25]);
  });

  it('copy into a snapshot byte for byte', () => {
    const cell = encodeCellBlock({ cx: 0, cz: 0, full: [], coarse: [] });
    const snapshot = decodeMessage(encodeMessage({ type: 'snapshot', tick: 9, blocks: [cell, cell] }), 'server');
    if (snapshot.type !== 'snapshot') throw new Error('not a snapshot');
    expect(snapshot.blocks.map((b) => decodeCellBlock(b).cx)).toEqual([0, 0]);
    expect(code(() => decodeCellBlock(fromHex('0000000000')))).toBe('truncated');
  });
});
