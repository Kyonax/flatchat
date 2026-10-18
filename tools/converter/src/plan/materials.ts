// SPDX-License-Identifier: MPL-2.0
// What a plan's surfaces look like (Track P's P.01): a trim sheet (one image whose horizontal bands
// are the walls' hull and panel faces, a kick plate with hazard stripes and a metal trim), a deck
// plate that tiles floors, a landing pad's markings and a star field to glow beyond a bay door.
// Drawn here, pixel by pixel, from a seeded generator, so a plan builds to the same bytes every
// time and nothing is fetched or licensed. Walls map the bands by height (geometry.ts): the faces
// are cut into strips, each strip one band, so the sheet repeats along a wall and up it.
import { PNG } from 'pngjs';

export const ATLAS = { width: 512, height: 512 } as const;

/** A band of the trim sheet: its rows in the image, and the metres of wall one repeat covers. */
export interface Band {
  v0: number;
  v1: number;
  /** Metres along a wall for one repeat of the band's width, and up it for its height. */
  across: number;
  up: number;
}

export const BANDS = {
  hull: { v0: 0, v1: 192, across: 4, up: 2 },
  panel: { v0: 192, v1: 384, across: 4, up: 2 },
  kick: { v0: 384, v1: 448, across: 4, up: 0.4 },
  trim: { v0: 448, v1: 512, across: 4, up: 0.3 },
} as const satisfies Record<string, Band>;
export type BandName = keyof typeof BANDS;

/** A deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, Math.round(r)));
      img.data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      img.data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      img.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(img, { colorType: 2 }));
}

/** Fine grain, the same everywhere for a seed. */
function grain(seed: number, width: number, height: number, amount: number): (x: number, y: number) => number {
  const rand = seeded(seed);
  const values = new Float32Array(width * height).map(() => (rand() - 0.5) * amount);
  return (x, y) => values[(y % height) * width + (x % width)]!;
}

/** The trim sheet. */
export function trimSheet(): Uint8Array {
  const g = grain(7, ATLAS.width, ATLAS.height, 14);
  return png(ATLAS.width, ATLAS.height, (x, y) => {
    const n = g(x, y);
    if (y < BANDS.hull.v1) {
      // Hull: dark plates 1 m wide, 1 m tall, bevelled seams, a rivet at each corner.
      const [px, py] = [x % 128, y % 96];
      const seam = px < 3 || py < 3 ? -38 : px > 124 || py > 92 ? 18 : 0;
      const rivet = (Math.hypot(px - 10, py - 10) < 3.5 || Math.hypot(px - 118, py - 10) < 3.5 || Math.hypot(px - 10, py - 86) < 3.5 || Math.hypot(px - 118, py - 86) < 3.5) ? 30 : 0;
      const v = 62 + n + seam + rivet;
      return [v, v + 3, v + 8];
    }
    if (y < BANDS.panel.v1) {
      // Panels: lighter, a long horizontal seam and vents in every other panel.
      const [px, py] = [x % 256, (y - BANDS.panel.v0) % 192];
      const seam = py < 3 || px < 3 ? -40 : py === 96 ? -25 : 0;
      const vent = px > 160 && px < 232 && py > 120 && py < 168 && (py - 120) % 8 < 3 ? -45 : 0;
      const v = 118 + n + seam + vent;
      return [v, v + 2, v + 6];
    }
    if (y < BANDS.kick.v1) {
      // The kick plate: yellow and black hazard stripes between two steel lips.
      const py = y - BANDS.kick.v0;
      if (py < 6 || py > 57) return [90 + n, 92 + n, 96 + n];
      return (x + py) % 64 < 32 ? [214 + n, 170 + n, 30 + n] : [28 + n, 28 + n, 30 + n];
    }
    // The trim: brushed steel with a dark groove.
    const py = y - BANDS.trim.v0;
    const groove = py > 28 && py < 36 ? -50 : 0;
    const v = 140 + n * 0.6 + groove + ((x * 7) % 5) * 2;
    return [v, v + 2, v + 6];
  });
}

/** A deck plate, 2 m square: raised diamonds on steel. */
export function deckPlate(): Uint8Array {
  const g = grain(11, 256, 256, 12);
  return png(256, 256, (x, y) => {
    const n = g(x, y);
    const [cx, cy] = [x % 32, y % 32];
    const flip = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0;
    const [dx, dy] = flip ? [cx - 16, cy - 16] : [cy - 16, 16 - cx];
    const diamond = Math.abs(dx * 0.4 + dy) < 2.2 && Math.abs(dx) < 9 ? 26 : 0;
    const edge = x % 128 < 2 || y % 128 < 2 ? -30 : 0;
    const v = 92 + n + diamond + edge;
    return [v, v + 2, v + 5];
  });
}

/** A landing pad, its whole square: dark, a ring, a cross and hazard edges. */
export function landingPad(): Uint8Array {
  const g = grain(13, 512, 512, 10);
  return png(512, 512, (x, y) => {
    const n = g(x, y);
    const [dx, dy] = [x - 255.5, y - 255.5];
    const r = Math.hypot(dx, dy);
    if (x < 24 || y < 24 || x > 487 || y > 487) return (x + y) % 48 < 24 ? [214 + n, 170 + n, 30 + n] : [26 + n, 26 + n, 28 + n];
    const ring = Math.abs(r - 170) < 9;
    const cross = (Math.abs(dx) < 10 && Math.abs(dy) < 120) || (Math.abs(dy) < 10 && Math.abs(dx) < 120);
    if (ring || cross) return [230 + n, 232 + n, 236 + n];
    return [44 + n, 46 + n, 52 + n];
  });
}

/** Stars beyond a bay door: what glows there. */
export function starField(): Uint8Array {
  const rand = seeded(17);
  const stars = Array.from({ length: 900 }, () => [rand() * 512, rand() * 512, rand() ** 3 * 255, rand()] as const);
  const sky = new Float32Array(512 * 512 * 3);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      // A faint nebula across the middle.
      const neb = Math.max(0, 1 - Math.abs(y - 210 - 48 * Math.sin(x / 81.5) - 22 * Math.sin(x / 23 + 1.3)) / (110 + 40 * Math.sin(x / 57))) ** 2;
      const i = (y * 512 + x) * 3;
      sky[i] = 6 + 40 * neb;
      sky[i + 1] = 4 + 12 * neb;
      sky[i + 2] = 14 + 60 * neb;
    }
  }
  for (const [sx, sy, b, hue] of stars) {
    const i = (Math.floor(sy) * 512 + Math.floor(sx)) * 3;
    const tint = hue < 0.2 ? [1, 0.8, 0.7] : hue > 0.85 ? [0.7, 0.8, 1] : [1, 1, 1];
    for (let k = 0; k < 3; k++) sky[i + k] = Math.min(255, sky[i + k]! + b * tint[k]!);
  }
  return png(512, 512, (x, y) => {
    const i = (y * 512 + x) * 3;
    return [sky[i]!, sky[i + 1]!, sky[i + 2]!];
  });
}
