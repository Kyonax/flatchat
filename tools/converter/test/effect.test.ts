// SPDX-License-Identifier: MPL-2.0
// Effect uploads (S6.01): an effect alone, in a zip (its files beside it, at any depth), in an
// Effekseer package, or as the platform's own bundle; refused with every problem at once when it
// is too new, uses material files, lacks a file, has a texture that is not a PNG, or is too busy
// for an avatar; made into an item worn at a point, its bundle the one file a client fetches, with
// the dry run's numbers in its manifest; and run as the core runs it, in the sandbox.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItemManifest, EFFECT_LIMITS, readBundle, uploadFormat, writeBundle } from '@flatchat/content';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertEffect, EffectError, effectUpload } from '../src/effect/convert.ts';
import { convertEffectItem } from '../src/effect/item.ts';
import { sampleBundle } from '../src/effect/samples.ts';
import { ItemError } from '../src/item/convert.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const declaration = { name: 'Laser', slot: 'effect', attach: 'hand_r', authors: ['the Effekseer project'] };

/** A sample as a zip: the effect at `dir/`, its files beside it. */
function zipOf(rel: string, dir = 'fx'): Uint8Array {
  const b = sampleBundle(rel);
  return zipSync(Object.fromEntries([...b.files].map(([p, bytes]) => [`${dir}/${p}`, bytes])), { mtime: new Date('2026-10-18T00:00:00Z') });
}

const refused = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof EffectError || err instanceof ItemError) return err.problems;
    throw err;
  }
  throw new Error('it was not refused');
};

describe('an effect upload', () => {
  it('is known by its first bytes: an Effekseer file, a zip with an effect in it, a bundle', () => {
    const laser = sampleBundle('00_Basic/Laser01.efkefc');
    expect(uploadFormat(laser.files.get('Laser01.efkefc')!)).toBe('effect');
    expect(uploadFormat(zipOf('00_Basic/Laser01.efkefc'))).toBe('effect');
    expect(uploadFormat(writeBundle(laser))).toBe('effect');
    // A zip with no effect in it is not one.
    expect(uploadFormat(zipSync({ 'readme.txt': new TextEncoder().encode('hi') }))).toBe('unknown');
  });

  it('takes the effect’s files from a zip, relative to the effect, at any depth', () => {
    const got = effectUpload(zipOf('00_Version16/Aura01.efkefc', 'deep/er'));
    expect(got.main).toBe('Aura01.efkefc');
    expect([...got.files.keys()].sort()).toEqual(['Aura01.efkefc', 'Textures/Aura02_T.png', 'Textures/Aura04_T.png', 'Textures/Normal01.png', 'Textures/Particle01.png']);
    expect(() => effectUpload(zipSync({ 'a.efkefc': new Uint8Array(4), 'b.efk': new Uint8Array(4) }))).toThrow(/2 effects/);
  });

  it('bundles exactly what the effect names and measures it in the runtime', async () => {
    const r = await convertEffect(zipOf('00_Basic/Laser01.efkefc'), { where: 'avatar', scale: 1 });
    const b = readBundle(r.bundle);
    expect([...b.files.keys()]).toEqual(['Laser01.efkefc', 'Texture/LaserMain01.png', 'Texture/Particle01.png', 'Texture/Particle02.png']);
    expect(r.fit).toMatchObject({ file: sha(r.bundle), version: 1500, peak: { instances: 122, quads: 121, triangles: 0 }, frames: 83, textures: 3, models: 0, distortion: false, sounds: 0, scale: 1 });
    expect(r.fit.updateUs).toBeLessThan(EFFECT_LIMITS.updateMs * 1000);
    expect(r.warnings).toEqual([]);
    // The same upload makes the same bundle.
    expect((await convertEffect(zipOf('00_Basic/Laser01.efkefc', 'other'), { where: 'avatar', scale: 1 })).fit.file).toBe(r.fit.file);
  }, 60_000);

  it('refuses an effect alone that names files it does not bring', async () => {
    const laser = sampleBundle('00_Basic/Laser01.efkefc').files.get('Laser01.efkefc')!;
    expect(await refused(convertEffect(laser, { where: 'avatar', scale: 1 }))).toEqual([
      'the effect needs Texture/LaserMain01.png, which the upload does not have',
      'the effect needs Texture/Particle01.png, which the upload does not have',
      'the effect needs Texture/Particle02.png, which the upload does not have',
    ]);
  });

  it('refuses a trail too busy for an avatar, and takes it for a world', async () => {
    const trail = sampleBundle('00_Basic/Simple_Track1.efkefc').files.get('Simple_Track1.efkefc')!;
    expect(await refused(convertEffect(trail, { where: 'avatar', scale: 1 }))).toEqual([expect.stringMatching(/406 particles at once; an avatar's effects may have 300/)]);
    expect((await convertEffect(trail, { where: 'world', scale: 1 })).fit.peak.instances).toBe(406);
  }, 60_000);

  it('refuses an effect newer than the runtime, with the editor it came from', async () => {
    const aura = sampleBundle('00_Version16/Aura01.efkefc');
    const main = aura.files.get('Aura01.efkefc')!.slice();
    // The body's version, after "SKFE" in the BIN_ chunk.
    const at = new TextDecoder('latin1').decode(main).indexOf('SKFE') + 4;
    new DataView(main.buffer).setInt32(at, 1900, true);
    aura.files.set('Aura01.efkefc', main);
    expect(await refused(convertEffect(aura, { where: 'avatar', scale: 1 }))).toEqual([expect.stringMatching(/saved by Effekseer 1\.9, newer than the platform's runtime \(Effekseer 1\.80\.7\)/)]);
  });

  it('refuses material files and textures that are not PNGs, every problem at once', async () => {
    // An old body by hand: "SKFE", version 15, a texture, no normal or distortion textures, no
    // sound, no model, one material.
    const parts: number[] = [0x53, 0x4b, 0x46, 0x45];
    const i32 = (v: number): void => void parts.push(v & 0xff, (v >> 8) & 0xff, 0, 0);
    const path = (s: string): void => {
      i32(s.length + 1);
      for (const c of s + '\0') parts.push(c.charCodeAt(0), 0);
    };
    i32(15);
    i32(1);
    path('glow.jpg');
    for (let k = 0; k < 4; k++) i32(0);
    i32(1);
    path('Glow.efkmat');
    const files = new Map([['x.efk', new Uint8Array(parts)], ['glow.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]]);
    const problems = await refused(convertEffect({ main: 'x.efk', files }, { where: 'avatar', scale: 1 }));
    expect(problems).toEqual([expect.stringMatching(/material files \(Glow\.efkmat\): those are creator shaders/), "glow.jpg: the platform's runtime takes PNG textures; save it as a PNG"]);
  });
});

describe('an effect as an item', () => {
  it('is worn at a point, its bundle its one file, its manifest the dry run’s', async () => {
    const r = await convertEffectItem(zipOf('00_Basic/Laser01.efkefc'), { declaration });
    const m = checkItemManifest(JSON.parse(new TextDecoder().decode(r.manifestBytes)));
    expect(m).toMatchObject({ kind: 'item', slot: 'effect', attach: 'hand_r', name: 'Laser', hides: [], fits: {} });
    expect(m.effect?.peak.instances).toBe(122);
    expect([...r.files.keys()]).toEqual([m.effect!.file]);
    expect(r.id).toBe(sha(r.manifestBytes));
  }, 60_000);

  it('takes the declaration a bundle carries, as a GLB carries its own', async () => {
    const b = { ...sampleBundle('00_Version16/Aura01.efkefc'), declaration: { name: 'Aura', slot: 'effect', attach: 'hips', scale: 0.5, authors: [] } };
    const r = await convertEffectItem(writeBundle(b));
    expect(r.manifest).toMatchObject({ name: 'Aura', attach: 'hips', effect: { scale: 0.5 } });
    // The bundle kept as the item's file carries no declaration: only what plays.
    expect(readBundle(r.files.values().next().value!).declaration).toBeUndefined();
  }, 60_000);

  it('needs a declaration, and one for the effect slot', async () => {
    expect(await refused(convertEffectItem(zipOf('00_Basic/Laser01.efkefc')))).toEqual([expect.stringMatching(/keeps no declaration of its own/)]);
    expect(await refused(convertEffectItem(zipOf('00_Basic/Laser01.efkefc'), { declaration: { ...declaration, slot: 'hat', attach: undefined } }))).toEqual(['the upload is an effect, so its slot is "effect", not "hat"']);
  });

  it('converts in the sandbox, as the core runs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fceffect-'));
    try {
      writeFileSync(join(dir, 'in.zip'), zipOf('00_Basic/Laser01.efkefc'));
      writeFileSync(join(dir, 'declare.json'), JSON.stringify(declaration));
      mkdirSync(join(dir, 'out'));
      const r = spawnSync(
        process.execPath,
        ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${join(dir, 'out')}`, '--import', join(HERE, '..', 'src', 'sandbox.ts'), join(HERE, '..', 'src', 'item-cli.ts'), join(dir, 'in.zip'), join(dir, 'out'), join(ROOT, 'kits', 'bodies'), '--declare', join(dir, 'declare.json')],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(r.status, r.stderr).toBe(0);
      const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')) as { ok: boolean; manifest: { effect: { file: string } } };
      expect(result.ok).toBe(true);
      expect(existsSync(join(dir, 'out', result.manifest.effect.file))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
