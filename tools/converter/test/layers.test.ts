// SPDX-License-Identifier: MPL-2.0
// S5.03's image comparison: each kit's skin and underwear layers (kits/bodies/<name>/<name>-skin.png,
// -underwear.png), composited by packages/content, give exactly the texture its VRM carries, so a
// player's outfit change rebuilds the very skin the kit was made with.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, compositeSkin, type RgbaImage } from '@flatchat/content';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { readAvatarLevel } from '../src/avatar/convert.ts';

const KITS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'bodies');
const png = (bytes: Uint8Array): RgbaImage => {
  const p = PNG.sync.read(Buffer.from(bytes));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
};

describe('the kits\' skin layers', () => {
  for (const body of BODY_KITS) {
    it(`${body}: skin and underwear make the texture its VRM carries`, async () => {
      const skin = png(readFileSync(join(KITS, body, `${body}-skin.png`)));
      const underwear = png(readFileSync(join(KITS, body, `${body}-underwear.png`)));
      const { color } = compositeSkin([{ kind: 'skin', color: skin }, { kind: 'underwear', color: underwear }]);
      const { doc } = await readAvatarLevel(new Uint8Array(readFileSync(join(KITS, body, `${body}.vrm`))));
      const material = doc.getRoot().listMaterials().find((m) => m.getName().endsWith('.body'))!;
      const texture = png(material.getBaseColorTexture()!.getImage()!);
      expect([texture.width, texture.height]).toEqual([color.width, color.height]);
      let differ = 0;
      for (let i = 0; i < color.data.length; i += 4) if (color.data[i] !== texture.data[i] || color.data[i + 1] !== texture.data[i + 1] || color.data[i + 2] !== texture.data[i + 2]) differ += 1;
      expect(differ).toBe(0);
    }, 30_000);
  }
});
