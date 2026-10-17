// SPDX-License-Identifier: MPL-2.0
// Textures for the converter's outputs (worlds S2.03, avatars S4.02): PNG and JPEG decoded, fitted
// to a side limit and then together to a GPU memory budget (halving the largest first), and
// encoded to KTX2 (Basis Universal compiled to WebAssembly: ETC1S for colour, UASTC for normal
// maps). Other image types are kept as they are, with a warning.
import { type Document, type Texture } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import jpeg from 'jpeg-js';
import { encodeToKTX2 } from 'ktx2-encoder';
import { PNG } from 'pngjs';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodeImage(bytes: Uint8Array, mime: string): Rgba | undefined {
  try {
    if (mime === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (mime === 'image/jpeg') {
      const j = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
      return { width: j.width, height: j.height, data: new Uint8Array(j.data) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Halves an image by averaging 2×2 blocks (an odd last row or column is dropped). */
export function halve(img: Rgba): Rgba {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const at = (yy: number, xx: number): number => img.data[(Math.min(img.height - 1, yy) * img.width + Math.min(img.width - 1, xx)) * 4 + c]!;
        out[(y * w + x) * 4 + c] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1) + 2) >> 2;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** The GPU memory a texture takes once compressed with mipmaps (BC7 or ASTC: 1 byte a pixel). */
export const gpuBytes = (w: number, h: number): number => Math.ceil(w * h * 1.34);

export interface TextureLimits {
  /** The longest side any texture keeps. */
  side: number;
  /** The GPU memory every texture together may take. */
  budget: number;
}

/** Fits every decodable texture of the documents to the limits and encodes it (KTX2, or PNG when
 *  `ktx2` is off); answers the GPU memory they take. */
export async function fitTextures(docs: Document[], limits: TextureLimits, ktx2: boolean, warn: (w: string) => void): Promise<number> {
  // Every decodable texture of every document, fitted first to the side limit, then together to the budget.
  const all: Array<{ doc: Document; texture: Texture; img: Rgba; normal: boolean }> = [];
  let kept = 0;
  for (const doc of docs) {
    const normals = new Set(doc.getRoot().listMaterials().map((m) => m.getNormalTexture()).filter((t): t is Texture => !!t));
    for (const texture of doc.getRoot().listTextures()) {
      const image = texture.getImage();
      const mime = texture.getMimeType();
      if (!image) continue;
      let img = decodeImage(image, mime);
      if (!img) {
        warn(`a texture of type ${mime || 'unknown'} is kept as it is (only PNG and JPEG are converted)`);
        const size = texture.getSize();
        if (size) kept += gpuBytes(size[0], size[1]);
        continue;
      }
      while (Math.max(img.width, img.height) > limits.side) img = halve(img);
      all.push({ doc, texture, img, normal: normals.has(texture) });
    }
  }
  let total = all.reduce((n, t) => n + gpuBytes(t.img.width, t.img.height), 0);
  while (total > limits.budget) {
    const biggest = all.reduce((a, b) => (b.img.width * b.img.height > a.img.width * a.img.height ? b : a));
    if (biggest.img.width <= 64) break;
    total -= gpuBytes(biggest.img.width, biggest.img.height);
    biggest.img = halve(biggest.img);
    total += gpuBytes(biggest.img.width, biggest.img.height);
  }
  for (const t of all) {
    if (ktx2) {
      const { img } = t;
      const out = await encodeToKTX2(new Uint8Array(1), {
        isUASTC: t.normal,
        isNormalMap: t.normal,
        isPerceptual: !t.normal,
        generateMipmap: true,
        qualityLevel: 128,
        compressionLevel: 2,
        imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
      });
      t.texture.setImage(out).setMimeType('image/ktx2');
      t.doc.createExtension(KHRTextureBasisu).setRequired(true);
    } else {
      const png = new PNG({ width: t.img.width, height: t.img.height });
      png.data = Buffer.from(t.img.data);
      t.texture.setImage(new Uint8Array(PNG.sync.write(png))).setMimeType('image/png');
    }
  }
  return total + kept;
}
