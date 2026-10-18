// SPDX-License-Identifier: Apache-2.0
// Merged skin layers (S5.03): the stack's order, normal and multiply blends with opacity, the PBR
// image carried beside the colour, a body never without underwear, and the same bytes every time.
import { describe, expect, it } from 'vitest';
import { compositeSkin, LayerError, type RgbaImage } from '../src/index.ts';

const fill = (r: number, g: number, b: number, a = 255, w = 2, h = 2): RgbaImage => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => [r, g, b, a][i % 4]!) });
const px = (img: RgbaImage, p: number): number[] => Array.from(img.data.slice(p * 4, p * 4 + 4));
const underwear = (() => {
  const u = fill(20, 20, 23, 0);
  u.data.set([20, 20, 23, 255], 0);
  return u;
})();

describe('skin layers', () => {
  it('put underwear over the skin only where it covers', () => {
    const c = compositeSkin([{ kind: 'skin', color: fill(204, 204, 204) }, { kind: 'underwear', color: underwear }]);
    expect(px(c.color, 0)).toEqual([20, 20, 23, 255]);
    expect(px(c.color, 1)).toEqual([204, 204, 204, 255]);
  });

  it('stack skin, tattoos, makeup and underwear in that order, whatever order they come in', () => {
    const tattoo = fill(0, 0, 255);
    const a = compositeSkin([{ kind: 'underwear', color: underwear }, { kind: 'tattoo', color: tattoo }, { kind: 'skin', color: fill(204, 204, 204) }]);
    expect(px(a.color, 0)).toEqual([20, 20, 23, 255]);
    expect(px(a.color, 3)).toEqual([0, 0, 255, 255]);
  });

  it('blend at an opacity, and multiply ink into the skin', () => {
    const half = compositeSkin([{ kind: 'skin', color: fill(200, 100, 0) }, { kind: 'tattoo', color: fill(0, 0, 200), opacity: 0.5 }], { requireUnderwear: false });
    expect(px(half.color, 0)).toEqual([100, 50, 100, 255]);
    const ink = compositeSkin([{ kind: 'skin', color: fill(200, 100, 50) }, { kind: 'tattoo', color: fill(128, 255, 0), blend: 'multiply' }], { requireUnderwear: false });
    expect(px(ink.color, 0)).toEqual([100, 100, 0, 255]);
  });

  it('carry the layers\' roughness and metalness beside the colour', () => {
    const c = compositeSkin([{ kind: 'skin', color: fill(204, 204, 204) }, { kind: 'underwear', color: underwear, orm: fill(255, 60, 0) }]);
    expect(px(c.orm!, 0)).toEqual([255, 60, 0, 255]);
    expect(px(c.orm!, 1)).toEqual([255, 255, 0, 255]);
    expect(compositeSkin([{ kind: 'skin', color: fill(1, 2, 3) }, { kind: 'underwear', color: underwear }]).orm).toBeUndefined();
  });

  it('never show a standard body without underwear, and refuse mismatched sizes', () => {
    expect(() => compositeSkin([{ kind: 'skin', color: fill(204, 204, 204) }])).toThrow(LayerError);
    expect(() => compositeSkin([{ kind: 'skin', color: fill(204, 204, 204) }, { kind: 'underwear', color: fill(0, 0, 0, 255, 4, 4) }])).toThrow(/is 4×4, the skin 2×2/);
  });

  it('give the same bytes every time', () => {
    const stack = [{ kind: 'skin' as const, color: fill(181, 140, 120) }, { kind: 'tattoo' as const, color: fill(10, 40, 90, 140), opacity: 0.7 }, { kind: 'underwear' as const, color: underwear }];
    expect(compositeSkin(stack).color.data).toEqual(compositeSkin(stack).color.data);
  });
});
