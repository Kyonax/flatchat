// SPDX-License-Identifier: Apache-2.0
// The pinned runtime and its measurement (S6.01): the four files in third_party/effekseer are the
// ones its README names; the WebGL build plays Effekseer's samples in Node over the stand-in
// context and measures them: a laser that ends, an aura that fits an avatar's budget, a trail with more
// particles than an avatar may have (a world may), a tornado that loops. GPU particles do nothing
// in this runtime; a texture the bundle lacks is named; a runtime outlives the effects it played.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFECT_LIMITS, type EffectBundle, type EffectFit, effectFitProblems } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { type DryRun, type DryRunOptions, imageSizes, measure, standIn } from '../src/measure.ts';
import { testBuild, THIRD } from './build.ts';
import { sampleBundle } from './samples.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const dryRun = async (b: EffectBundle, o: DryRunOptions): Promise<DryRun> => measure(await testBuild(), b, o);
const fitOf = (r: DryRun): EffectFit => ({ file: '0'.repeat(64), bytes: 0, version: 1610, peak: r.peak, frames: r.frames, textures: 0, texturePixels: 0, models: 0, distortion: false, sounds: 0, scale: 1, updateUs: r.updateUs });

describe('the pinned runtime', () => {
  it('is the four files its README names, by SHA-256', () => {
    const readme = readFileSync(join(THIRD, 'README.md'), 'utf8');
    const built = readdirSync(THIRD).filter((f) => /^effekseer-web(gl|gpu)-native\.(js|wasm)$/.test(f)).sort();
    expect(built).toEqual(['effekseer-webgl-native.js', 'effekseer-webgl-native.wasm', 'effekseer-webgpu-native.js', 'effekseer-webgpu-native.wasm']);
    for (const f of built) {
      const sha = createHash('sha256').update(readFileSync(join(THIRD, f))).digest('hex');
      expect(readme, `${relative(HERE, join(THIRD, f))} is not the one the README names`).toContain(`${sha}  ${f}`);
    }
  });
});

describe('the dry run', () => {
  it('measures a laser that ends', async () => {
    const r = await dryRun(sampleBundle('00_Basic/Laser01.efkefc'), { scale: 1 });
    expect(r.frames).toBe(83);
    expect(r.peak).toEqual({ instances: 122, quads: 121, triangles: 0 });
    expect(r.missing).toEqual([]);
    expect(r.asked.sort()).toEqual(['Texture/LaserMain01.png', 'Texture/Particle01.png', 'Texture/Particle02.png']);
  }, 30_000);

  it('fits the aura within an avatar’s budget; its procedural shell counts as model triangles', async () => {
    const r = await dryRun(sampleBundle('00_Version16/Aura01.efkefc'), { scale: 1 });
    expect(r.peak.instances).toBeLessThanOrEqual(EFFECT_LIMITS.avatar.instances);
    expect(r.peak.triangles).toBeGreaterThan(10_000);
    expect(effectFitProblems(fitOf(r), 'avatar')).toEqual([]);
  }, 30_000);

  it('finds a trail too busy for an avatar, but not for a world', async () => {
    const r = await dryRun(sampleBundle('00_Basic/Simple_Track1.efkefc'), { scale: 1 });
    expect(r.peak.instances).toBe(406);
    expect(effectFitProblems(fitOf(r), 'avatar')).toEqual([expect.stringMatching(/406 particles/)]);
    expect(effectFitProblems(fitOf(r), 'world')).toEqual([]);
  }, 30_000);

  it('tells a loop from an effect that ends', async () => {
    const r = await dryRun(sampleBundle('00_Version16/ForceFieldTornado.efkefc'), { scale: 1, frames: 300, seeds: [1] });
    expect(r.frames).toBeNull();
    expect(r.peak.instances).toBeGreaterThan(300);
  }, 30_000);

  it('names a texture the bundle lacks', async () => {
    const b = sampleBundle('00_Basic/Laser01.efkefc');
    b.files.delete('Texture/Particle02.png');
    const r = await dryRun(b, { scale: 1, frames: 10, seeds: [1] });
    expect(r.missing).toEqual(['Texture/Particle02.png']);
  }, 30_000);

  it('plays the same effect the same way with the same seed', async () => {
    const b = sampleBundle('00_Basic/Laser01.efkefc');
    const a = await dryRun(b, { scale: 1, seeds: [5] });
    const c = await dryRun(b, { scale: 1, seeds: [5] });
    expect(c.peak).toEqual(a.peak);
    expect(c.frames).toBe(a.frames);
  }, 30_000);

  it('keeps one runtime going across effects, and frees what it stops', async () => {
    const { runtime, stub } = await standIn(await testBuild());
    try {
      const laser = sampleBundle('00_Basic/Laser01.efkefc');
      const effect = runtime.load(laser, { scale: 1, images: imageSizes(laser), sounds: false });
      const handles = [runtime.play(effect, 1), runtime.play(effect, 2), runtime.play(effect, 3)];
      for (let f = 0; f < 30; f++) runtime.update(1);
      expect(runtime.totalInstances()).toBeGreaterThan(handles.length);
      stub.reset();
      runtime.drawGl();
      expect(stub.count.quads).toBeGreaterThan(0);
      runtime.stopAll();
      runtime.update(1);
      expect(handles.some((h) => runtime.exists(h))).toBe(false);
      expect(runtime.totalInstances()).toBe(0);
      runtime.release(effect);
    } finally {
      runtime.dispose();
    }
  }, 30_000);
});
