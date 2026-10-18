// SPDX-License-Identifier: MPL-2.0
// The starter overlays (S6.02): two small badges any account takes with no upload, drawn here in
// code, so they are the FlatChat contributors' own (kits/provenance/starter-overlays.json): a star
// and a heart, 128 px a side, edges smoothed by drawing at four times the size. The same bytes
// every time.
//
//   node tools/converter/scripts/make-overlays.ts      (rewrites kits/overlays/*.png)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'overlays');
const SIDE = 128;
const SS = 4;

type Rgb = [number, number, number];

/** A badge: `inside(x, y)` in -1..1 says whether a point is in the shape; a soft glow round it. */
function badge(inside: (x: number, y: number) => boolean, fill: Rgb, rim: Rgb): Uint8Array {
  const png = new PNG({ width: SIDE, height: SIDE });
  const n = SIDE * SS;
  const cover = new Float32Array(SIDE * SIDE);
  const edge = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n) * 2 - 1;
      const v = ((y + 0.5) / n) * 2 - 1;
      const i = Math.floor(y / SS) * SIDE + Math.floor(x / SS);
      if (inside(u * 1.12, v * 1.12)) cover[i]! += 1 / (SS * SS);
      // The rim: in the shape a little larger, not in it a little smaller.
      if (inside(u * 1.04, v * 1.04) && !inside(u * 1.2, v * 1.2)) edge[i]! += 1 / (SS * SS);
    }
  }
  for (let i = 0; i < SIDE * SIDE; i++) {
    const c = cover[i]!;
    const e = Math.min(1, edge[i]!);
    const a = Math.min(1, c + e * 0.55);
    const mix = (k: number): number => Math.round(a > 0 ? (fill[k]! * c + rim[k]! * e * 0.55) / (c + e * 0.55) : 0);
    png.data[i * 4] = mix(0);
    png.data[i * 4 + 1] = mix(1);
    png.data[i * 4 + 2] = mix(2);
    png.data[i * 4 + 3] = Math.round(a * 255);
  }
  return new Uint8Array(PNG.sync.write(png, { deflateLevel: 9 }));
}

/** A five-pointed star, point up: its ten corners, the points and the notches between them. */
const STAR = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? 0.95 : 0.4;
  const a = (i * Math.PI) / 5;
  return [r * Math.sin(a), -r * Math.cos(a)] as const;
});

/** Inside a polygon: a ray to the right crosses its edges an odd number of times. */
function star(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i]!;
    const [xj, yj] = STAR[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A heart, the classic curve, point down. */
function heart(x: number, y: number): boolean {
  const X = x * 1.25;
  const Y = -y * 1.25 + 0.25;
  return (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 <= 0;
}

writeFileSync(join(OUT, 'star-badge.png'), badge(star, [249, 205, 38], [255, 244, 196]));
writeFileSync(join(OUT, 'heart-badge.png'), badge(heart, [232, 76, 112], [255, 205, 216]));
process.stdout.write('wrote kits/overlays/star-badge.png and heart-badge.png\n');
