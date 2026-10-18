// SPDX-License-Identifier: Apache-2.0
// Merged skin layers (S5.03, dp-002): a standard body's skin, its underwear, and any tattoos or
// makeup, composited into one texture set whenever a player's outfit changes, the same on every
// machine: plain integer arithmetic on RGBA bytes, no canvas and no GPU, so every viewer draws the
// same skin and the tests compare images exactly. Aware of PBR materials (Second Life's Bakes on Mesh
// cannot bake them, rr-001): a layer may bring an occlusion-roughness-metallic image too, and the
// composite carries both. Normal maps are not merged yet.

export const LAYER_KINDS = ['skin', 'tattoo', 'makeup', 'underwear'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** An image in the kits' UV space: width × height RGBA bytes, alpha straight (not premultiplied). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface SkinLayer {
  kind: LayerKind;
  /** Its colour, and where it covers (alpha). */
  color: RgbaImage;
  /** Its occlusion, roughness and metalness (glTF's ORM in RGB), where its colour's alpha covers. */
  orm?: RgbaImage;
  /** 0 to 1; 1 when left out. */
  opacity?: number;
  /** `normal` covers what is below; `multiply` darkens it (ink, shadows). */
  blend?: 'normal' | 'multiply';
}

export interface SkinComposite {
  color: RgbaImage;
  /** Present when any layer brought one: the skin's own ORM (or glTF's defaults) with the layers' over it. */
  orm?: RgbaImage;
}

export class LayerError extends Error {}

/** glTF's defaults where the skin brings no ORM: no occlusion, fully rough, not metal. */
const DEFAULT_ORM: readonly [number, number, number] = [255, 255, 0];

const order = (k: LayerKind): number => LAYER_KINDS.indexOf(k);

/** The skin and every layer over it, bottom to top: skin, tattoos, makeup, then underwear, which
 *  covers what is beneath it. A standard body is never composited without underwear (OQ-11):
 *  `requireUnderwear` (true unless said otherwise) refuses a stack without one. */
export function compositeSkin(layers: readonly SkinLayer[], o: { requireUnderwear?: boolean } = {}): SkinComposite {
  const skin = layers.filter((l) => l.kind === 'skin');
  if (skin.length !== 1) throw new LayerError('a skin composite starts from exactly one skin layer');
  if ((o.requireUnderwear ?? true) && !layers.some((l) => l.kind === 'underwear')) throw new LayerError('a standard body is never shown without underwear');
  const { width, height } = skin[0]!.color;
  for (const l of layers) {
    for (const img of [l.color, l.orm]) {
      if (img && (img.width !== width || img.height !== height || img.data.length !== width * height * 4)) throw new LayerError(`a ${l.kind} layer is ${img.width}×${img.height}, the skin ${width}×${height}`);
    }
  }
  const stack = layers.map((l, i) => ({ l, i })).sort((a, b) => order(a.l.kind) - order(b.l.kind) || a.i - b.i).map(({ l }) => l);
  const n = width * height;
  const color = new Uint8Array(n * 4);
  color.set(skin[0]!.color.data);
  for (let p = 0; p < n; p++) color[p * 4 + 3] = 255;
  const withOrm = layers.some((l) => l.orm);
  const orm = withOrm ? new Uint8Array(n * 4) : undefined;
  if (orm) {
    const base = skin[0]!.orm?.data;
    for (let p = 0; p < n; p++) {
      for (let c = 0; c < 3; c++) orm[p * 4 + c] = base ? base[p * 4 + c]! : DEFAULT_ORM[c]!;
      orm[p * 4 + 3] = 255;
    }
  }
  for (const l of stack) {
    if (l.kind === 'skin') continue;
    // Opacity in 0..255, and each pixel's coverage as 0..65025 (alpha × opacity), all integers.
    const opacity = Math.round(Math.max(0, Math.min(1, l.opacity ?? 1)) * 255);
    const src = l.color.data;
    const multiply = l.blend === 'multiply';
    for (let p = 0; p < n; p++) {
      const a = src[p * 4 + 3]! * opacity;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        const d = color[p * 4 + c]!;
        const s = multiply ? Math.round((d * src[p * 4 + c]!) / 255) : src[p * 4 + c]!;
        color[p * 4 + c] = Math.round((s * a + d * (65025 - a)) / 65025);
      }
      if (orm && l.orm) {
        for (let c = 0; c < 3; c++) orm[p * 4 + c] = Math.round((l.orm.data[p * 4 + c]! * a + orm[p * 4 + c]! * (65025 - a)) / 65025);
      }
    }
  }
  return { color: { width, height, data: color }, ...(orm ? { orm: { width, height, data: orm } } : {}) };
}
