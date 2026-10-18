// SPDX-License-Identifier: MPL-2.0
// Overlay uploads (S6.02): a PNG made into an item worn at a screen point, written again so clients
// get one still frame and nothing else, fingerprinted by its perceptual hash; and the same through
// the item program in the sandbox, as the core runs it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { checkItemManifest } from '@flatchat/content';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ItemError } from '../src/item/convert.ts';
import { convertOverlayItem } from '../src/overlay.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const declaration = { name: 'Badge', slot: 'overlay', hud: 'top-right', size: 0.12, motion: 'pulse', audience: 'everyone', authors: ['FlatChat'] };

/** A PNG of a diagonal gradient, `width` by `height`. */
function gradient(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 255) / width;
      png.data[i + 1] = (y * 255) / height;
      png.data[i + 2] = 128;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** The PNG with a text chunk put in after its header (what an editor leaves behind). */
function withText(png: Uint8Array, text: string): Uint8Array {
  const data = new TextEncoder().encode(`Comment\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const at = 8 + 25; // the signature, then IHDR (4 + 4 + 13 + 4)
  return new Uint8Array([...png.subarray(0, at), ...chunk, ...png.subarray(at)]);
}

const refused = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ItemError) return err.problems;
    throw err;
  }
  return [];
};

describe('an overlay upload', () => {
  it('becomes an item with its look, its image written again and fingerprinted', async () => {
    const upload = withText(gradient(96, 48), 'made by hand');
    const r = await convertOverlayItem(upload, { declaration });
    const m = checkItemManifest(r.manifest);
    expect(m.slot).toBe('overlay');
    expect(m.overlay).toMatchObject({ hud: 'top-right', size: 0.12, opacity: 1, motion: 'pulse', audience: 'everyone', width: 96, height: 48 });
    const image = r.files.get(m.overlay!.file)!;
    expect(image.length).toBe(m.overlay!.bytes);
    // Nothing but the pixels: the text chunk is gone, the pixels are the same.
    expect(new TextDecoder('latin1').decode(image).includes('tEXt')).toBe(false);
    expect(Buffer.compare(PNG.sync.read(Buffer.from(image)).data, PNG.sync.read(Buffer.from(upload)).data)).toBe(0);
    expect(r.fingerprint.textures).toHaveLength(1);
  });

  it('refuses an image too big, one that is not a PNG, and a wrong declaration', async () => {
    expect(await refused(convertOverlayItem(gradient(600, 10), { declaration }))).toEqual([expect.stringMatching(/600×10: 512 px a side at most/)]);
    expect(await refused(convertOverlayItem(new Uint8Array(100), { declaration }))).toEqual([expect.stringMatching(/is a PNG/)]);
    expect(await refused(convertOverlayItem(gradient(32, 32)))).toEqual([expect.stringMatching(/keeps no declaration/)]);
    expect(await refused(convertOverlayItem(gradient(32, 32), { declaration: { ...declaration, slot: 'hat', hud: undefined, size: undefined, motion: undefined, audience: undefined } }))).toEqual(['the upload is an image, so its slot is "overlay", not "hat"']);
  });

  it('converts in the sandbox, as the core runs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcoverlay-'));
    try {
      writeFileSync(join(dir, 'in.png'), gradient(64, 64));
      writeFileSync(join(dir, 'declare.json'), JSON.stringify(declaration));
      mkdirSync(join(dir, 'out'));
      const r = spawnSync(
        process.execPath,
        ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${join(dir, 'out')}`, '--import', join(HERE, '..', 'src', 'sandbox.ts'), join(HERE, '..', 'src', 'item-cli.ts'), join(dir, 'in.png'), join(dir, 'out'), join(ROOT, 'kits', 'bodies'), '--declare', join(dir, 'declare.json')],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(r.status, r.stderr).toBe(0);
      const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')) as { ok: boolean; manifest: { overlay: { file: string } } };
      expect(result.ok).toBe(true);
      expect(readFileSync(join(dir, 'out', result.manifest.overlay.file)).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
