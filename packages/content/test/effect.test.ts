// SPDX-License-Identifier: Apache-2.0
// Effects as the platform reads them without running them (S6.01): Effekseer's .efkefc container
// and the older .efk body, the body's version against the pinned runtime's, the resources it names
// in the order the runtime reads them; the FCFX bundle the platform keeps an effect in; and the
// limits a measured effect is held to where it plays.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundleFile, bundlePathOf, EFFECT_LIMITS, EFFECT_RUNTIME, type EffectFit, effectFiles, effectFitProblems, EffectFormatError, effectPath, readBundle, readEffectFile, writeBundle } from '../src/effect.ts';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'effects', 'samples');
const read = (p: string): Uint8Array => new Uint8Array(readFileSync(join(SAMPLES, p)));

/** A runtime body by hand: "SKFE", a version, then each list's paths. */
function body(version: number, lists: string[][]): Uint8Array {
  const parts: number[] = [];
  const i32 = (v: number): void => {
    parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  parts.push(0x53, 0x4b, 0x46, 0x45);
  i32(version);
  for (const list of lists) {
    i32(list.length);
    for (const p of list) {
      i32(p.length + 1);
      for (const c of p + '\0') parts.push(c.charCodeAt(0), 0);
    }
  }
  return new Uint8Array(parts);
}

describe('an effect file', () => {
  it('reads the samples: their versions and every resource they name', () => {
    const aura = readEffectFile(read('00_Version16/Aura01.efkefc'));
    expect(aura).toMatchObject({ container: 0, version: 1610 });
    expect(aura.resources.colorImages).toEqual(['Textures/Aura02_T.png', 'Textures/Aura04_T.png', 'Textures/Normal01.png', 'Textures/Particle01.png']);
    expect(aura.resources.materials).toEqual([]);
    const laser = readEffectFile(read('00_Basic/Laser01.efkefc'));
    expect(laser.version).toBe(1500);
    expect(effectFiles(laser).map((f) => f.path)).toEqual(['Texture/LaserMain01.png', 'Texture/Particle01.png', 'Texture/Particle02.png']);
    expect(readEffectFile(read('00_Basic/Simple_Track1.efkefc')).resources.colorImages).toEqual([]);
  });

  it('reads an old .efk body, and its later lists by version, as the runtime does', () => {
    // Version 15 (1.4) names materials; curves come with 1.6 (1607); normal and distortion
    // textures with version 9.
    const old = readEffectFile(body(15, [['a.png'], ['n.png'], ['d.png'], ['s.wav'], ['m.efkmodel'], ['x.efkmat']]));
    expect(old.resources).toMatchObject({ colorImages: ['a.png'], normalImages: ['n.png'], distortionImages: ['d.png'], sounds: ['s.wav'], models: ['m.efkmodel'], materials: ['x.efkmat'], curves: [] });
    const v18 = readEffectFile(body(1810, [['T\\a.png'], [], [], [], [], [], ['c.efkcurve']]));
    expect(v18.resources.colorImages).toEqual(['T/a.png']);
    expect(v18.resources.curves).toEqual(['c.efkcurve']);
  });

  it('reads a newer body only as far as its version, for the converter to refuse', () => {
    const newer = readEffectFile(body(EFFECT_RUNTIME.bodyVersion + 10, [['a.png']]));
    expect(newer.version).toBe(1820);
    expect(newer.resources.colorImages).toEqual([]);
  });

  it('refuses what is not an effect, or does not read', () => {
    expect(() => readEffectFile(new TextEncoder().encode('glTF....'))).toThrow(EffectFormatError);
    const aura = read('00_Version16/Aura01.efkefc');
    // The container cut inside its runtime chunk.
    expect(() => readEffectFile(aura.subarray(0, 60))).toThrow(/ends early|no runtime body/);
    // A count the runtime would refuse (over 1,024).
    const big = body(1810, []);
    const lying = new Uint8Array([...big, 0x00, 0x10, 0x00, 0x00]);
    expect(() => readEffectFile(lying)).toThrow(/count 4096 is out of range/);
  });

  it('normalises paths: slashes, "./", ".." where it can', () => {
    expect(effectPath('Texture\\.\\Glow.png\0')).toBe('Texture/Glow.png');
    expect(effectPath('a/b/../c.png')).toBe('a/c.png');
    expect(effectPath('../../Shared/x.png')).toBe('../../Shared/x.png');
  });
});

describe('the bundle', () => {
  const files = new Map<string, Uint8Array>([
    ['Laser01.efkefc', read('00_Basic/Laser01.efkefc')],
    ['Texture/LaserMain01.png', read('00_Basic/Texture/LaserMain01.png')],
    ['Texture/Particle01.png', read('00_Basic/Texture/Particle01.png')],
  ]);

  it('round-trips, the effect first and the rest in order', () => {
    const bytes = writeBundle({ main: 'Laser01.efkefc', files });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('FCFX');
    const back = readBundle(bytes);
    expect(back.main).toBe('Laser01.efkefc');
    expect([...back.files.keys()]).toEqual(['Laser01.efkefc', 'Texture/LaserMain01.png', 'Texture/Particle01.png']);
    for (const [k, v] of files) expect(back.files.get(k)).toEqual(v);
    // The same files, the same bytes.
    expect(writeBundle({ main: 'Laser01.efkefc', files: new Map([...files].reverse()) })).toEqual(bytes);
  });

  it('refuses a bundle that does not add up', () => {
    const bytes = writeBundle({ main: 'Laser01.efkefc', files });
    expect(() => readBundle(bytes.subarray(0, bytes.length - 1))).toThrow(EffectFormatError);
    expect(() => readBundle(new Uint8Array([...bytes, 0]))).toThrow(/do not add up/);
    const bad = bytes.slice();
    bad[4] = 2;
    expect(() => readBundle(bad)).toThrow(/format 2/);
  });

  it('finds what the runtime asks for: the path, its case, or the only file with its name', () => {
    const b = readBundle(writeBundle({ main: 'Laser01.efkefc', files }));
    expect(bundleFile(b, 'Texture\\LaserMain01.png')).toEqual(files.get('Texture/LaserMain01.png'));
    expect(bundlePathOf(b.files.keys(), 'texture/particle01.PNG')).toBe('Texture/Particle01.png');
    expect(bundlePathOf(b.files.keys(), '../../Effects/Textures/Particle01.png')).toBe('Texture/Particle01.png');
    expect(bundleFile(b, 'Texture/Missing.png')).toBeUndefined();
  });
});

describe('what an effect may weigh', () => {
  const fit = (peak: EffectFit['peak']): EffectFit => ({ file: 'f'.repeat(64), bytes: 1, version: 1810, peak, frames: 60, textures: 1, texturePixels: 1, models: 0, distortion: false, sounds: 0, scale: 1, updateUs: 10 });

  it('holds an avatar to its own budget and a world to its larger one', () => {
    const a = EFFECT_LIMITS.avatar;
    expect(effectFitProblems(fit({ instances: a.instances, quads: a.quads, triangles: a.triangles }), 'avatar')).toEqual([]);
    expect(effectFitProblems(fit({ instances: a.instances + 1, quads: 0, triangles: 0 }), 'avatar')).toEqual([expect.stringMatching(/301 particles/)]);
    expect(effectFitProblems(fit({ instances: a.instances + 1, quads: 0, triangles: 0 }), 'world')).toEqual([]);
    expect(effectFitProblems(fit({ instances: 0, quads: a.quads + 1, triangles: a.triangles + 1 }), 'avatar')).toHaveLength(2);
  });
});
