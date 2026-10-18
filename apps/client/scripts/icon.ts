// SPDX-License-Identifier: MPL-2.0
// The program's icon (S6.07): the mark's squares (src/shared/logo.ts) on black, as RGBA pixels and as
// a PNG made with Node's own zlib, so the icon is code, not a file to keep in step by hand.
import { crc32, deflateSync } from 'node:zlib';
import { LOGO_ACCENT, LOGO_BRIGHT, LOGO_GRID, LOGO_RECTS } from '../src/shared/logo.ts';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** The icon at `size` pixels a side: RGBA, row after row. */
export function iconPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const scale = size / LOGO_GRID;
  for (const r of LOGO_RECTS) {
    const colour = rgb(r.ink === 'accent' ? LOGO_ACCENT : LOGO_BRIGHT);
    for (let y = Math.round(r.y * scale); y < Math.round((r.y + r.h) * scale); y++) {
      for (let x = Math.round(r.x * scale); x < Math.round((r.x + r.w) * scale); x++) px.set([...colour, 255], (y * size + x) * 4);
    }
  }
  return px;
}

/** The icon as a PNG file. */
export function iconPng(size: number): Buffer {
  const px = iconPixels(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
