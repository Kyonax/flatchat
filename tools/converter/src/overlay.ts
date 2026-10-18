// SPDX-License-Identifier: MPL-2.0
// An overlay upload made into an item (S6.02, Q-M13, G-20): a PNG worn at a screen point. The image
// is decoded and written again, so what every client shows is one still frame (an animated PNG keeps
// its first) with no other chunks, at most 512 px a side; its look (the screen point, size, opacity,
// motion) and its audience come with the upload, as an effect's do. Its fingerprint is the image's
// perceptual hash, so a copy of one taken down is caught as a texture is (S5.09).
import { createHash } from 'node:crypto';
import { ITEM_FORMAT, type ItemDeclaration, ItemFormatError, type ItemManifest, OVERLAY_LIMITS, type OverlayFit, overlayImageProblems, readItemDeclaration } from '@flatchat/content';
import { PNG } from 'pngjs';
import { imageHash } from './fingerprint.ts';
import { ITEM_CONVERTER_VERSION, ItemError, type ItemResult } from './item/convert.ts';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The image as clients get it: decoded, checked, written again with nothing but its pixels; at
 *  most `side` px a side (an item's, or a world's larger one). */
export function overlayImage(upload: Uint8Array, side: number = OVERLAY_LIMITS.side): { png: Uint8Array; width: number; height: number; rgba: Uint8Array } {
  const problems = overlayImageProblems(upload, side);
  if (problems.length) throw new ItemError(problems);
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(upload));
  } catch (err) {
    throw new ItemError([`the overlay's PNG does not read: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`]);
  }
  if (Math.max(png.width, png.height) > side) throw new ItemError([`an overlay's image is ${png.width}×${png.height}: ${side} px a side at most`]);
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  return { png: new Uint8Array(PNG.sync.write(out)), width: png.width, height: png.height, rgba: new Uint8Array(png.data) };
}

export async function convertOverlayItem(upload: Uint8Array, o: { declaration?: unknown } = {}): Promise<ItemResult> {
  if (o.declaration === undefined) throw new ItemError(['an overlay keeps no declaration of its own: give its name and its screen point when uploading it']);
  let declared: ItemDeclaration;
  try {
    declared = readItemDeclaration(o.declaration);
  } catch (err) {
    throw new ItemError(err instanceof ItemFormatError ? err.problems : [String(err)]);
  }
  if (declared.slot !== 'overlay') throw new ItemError([`the upload is an image, so its slot is "overlay", not "${declared.slot}"`]);
  const image = overlayImage(upload);
  const fit: OverlayFit = {
    file: sha256(image.png),
    bytes: image.png.length,
    width: image.width,
    height: image.height,
    hud: declared.hud!,
    size: declared.size!,
    opacity: declared.opacity!,
    motion: declared.motion!,
    audience: declared.audience!,
  };
  const manifest: ItemManifest = {
    format: ITEM_FORMAT,
    kind: 'item',
    converter: ITEM_CONVERTER_VERSION,
    source: { sha256: sha256(upload), bytes: upload.length },
    name: declared.name,
    authors: declared.authors,
    slot: 'overlay',
    hides: [],
    fits: {},
    clipping: {},
    overlay: fit,
    warnings: [],
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const hash = imageHash({ width: image.width, height: image.height, data: image.rgba });
  return { manifest, manifestBytes, id: sha256(manifestBytes), files: new Map([[fit.file, image.png]]), fingerprint: { shapes: [], textures: hash ? [hash] : [] } };
}
