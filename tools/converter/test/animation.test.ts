// SPDX-License-Identifier: MPL-2.0
// Animation imports (S5.07): golden files per format. The same motion (the right arm rising 80°
// above level and back, a 15° nod, a 2 cm bob: samples.ts) comes as BVH, as a GLB clip (Mixamo's
// names, facing back, resting in an A-pose, scaled from centimetres), as an FBX (made by Blender
// from the clip, read back by tools/blender/animation/fbx2glb.py; the GLB it wrote is the fixture
// CI reads, Blender being on this desktop only) and as VRMA (the BVH's own output, which must
// come back byte for byte). Each must give the VRMA the golden file records and the poses the
// motion says; what is not a humanoid animation, or is too long, is refused with a reason.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AnimationManifest, checkAnimationFile, checkAnimationManifest, readGltf } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { AnimationError, animationFormat, convertAnimation } from '../src/animation/convert.ts';
import { qangle, qaxis, type Quat } from '../src/animation/quat.ts';
import { sampleBvh, sampleClip } from '../src/animation/samples.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'animation');
const GOLDEN = join(HERE, 'golden', 'animations.json');
const FBX = new Uint8Array(readFileSync(join(FIXTURES, 'wave.fbx')));
const FBX_GLB = new Uint8Array(readFileSync(join(FIXTURES, 'wave-fbx.glb')));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const deg = (a: Quat, b: Quat): number => (qangle(a, b) * 180) / Math.PI;
const rotZ = (d: number): Quat => qaxis([0, 0, 1], (d * Math.PI) / 180);
const rotX = (d: number): Quat => qaxis([1, 0, 0], (d * Math.PI) / 180);

interface Vrma {
  extensions: { VRMC_vrm_animation: { humanoid: { humanBones: Record<string, { node: number }> } } };
  animations: Array<{ channels: Array<{ sampler: number; target: { node: number; path: string } }>; samplers: Array<{ output: number }> }>;
  accessors: Array<{ bufferView: number; componentType: number; count: number; type: string }>;
  bufferViews: Array<{ byteOffset: number }>;
}

/** A bone's keys in a VRMA: rotations (normalized shorts) or the hips' place. */
function keys(file: Uint8Array, bone: string, path: 'rotation' | 'translation'): number[][] {
  const { json, bin } = readGltf(file, 'animation.glb') as unknown as { json: Vrma; bin: Uint8Array };
  const node = json.extensions.VRMC_vrm_animation.humanoid.humanBones[bone]!.node;
  const anim = json.animations[0]!;
  const ch = anim.channels.find((c) => c.target.node === node && c.target.path === path)!;
  const acc = json.accessors[anim.samplers[ch.sampler]!.output]!;
  const view = json.bufferViews[acc.bufferView]!;
  const size = acc.type === 'VEC4' ? 4 : 3;
  const short = acc.componentType === 5122;
  const dv = new DataView(bin.buffer, bin.byteOffset + view.byteOffset);
  return Array.from({ length: acc.count }, (_, k) => Array.from({ length: size }, (_, c) => (short ? Math.max(dv.getInt16((k * size + c) * 2, true) / 32767, -1) : dv.getFloat32((k * size + c) * 4, true))));
}
const at = (k: number[][], frame: number): Quat => (k[Math.min(frame, k.length - 1)] ?? k[0]!) as Quat;

interface Case {
  format: string;
  bytes: () => Promise<Uint8Array>;
  options?: Parameters<typeof convertAnimation>[1];
  /** How close each pose must come, in degrees (the FBX: Blender's round trip re-orients the leaf
   *  head bone by about 2°). */
  tolerance: number;
  aPose: boolean;
}
const CASES: Case[] = [
  { format: 'bvh', bytes: async () => new TextEncoder().encode(sampleBvh()), tolerance: 0.1, aPose: false },
  { format: 'gltf', bytes: sampleClip, tolerance: 0.1, aPose: true },
  { format: 'fbx', bytes: async () => FBX_GLB, options: { from: 'fbx', source: { sha256: sha(FBX), bytes: FBX.length } }, tolerance: 2.5, aPose: true },
];

describe('animation imports', () => {
  it('turn each format into the VRMA the golden file records, with the motion it carries', async () => {
    const golden: Record<string, unknown> = {};
    const outputs = new Map<string, Uint8Array>();
    for (const c of CASES) {
      const r = await convertAnimation(await c.bytes(), { name: c.format, ...c.options });
      const file = r.files.get(r.manifest.file)!;
      outputs.set(c.format, file);
      expect(() => checkAnimationFile(readGltf(file, 'animation.glb').json as Record<string, unknown>)).not.toThrow();
      expect(checkAnimationManifest(JSON.parse(new TextDecoder().decode(r.manifestBytes)))).toMatchObject({ source: { format: c.format }, loop: true, duration: 2, use: 'emote' });
      expect(r.manifest.bones).toHaveLength(21);
      // The right arm 80° up at one second; the nod at its height at half a second; the left arm
      // as it rested (the clip's A-pose shows as an A-pose); the hips at the source's height, bobbing 2 cm.
      expect(deg(at(keys(file, 'rightUpperArm', 'rotation'), 30), rotZ(-80))).toBeLessThan(c.tolerance);
      expect(deg(at(keys(file, 'head', 'rotation'), 15), rotX(15))).toBeLessThan(c.tolerance);
      expect(deg(at(keys(file, 'leftUpperArm', 'rotation'), 0), c.aPose ? rotZ(-45) : [0, 0, 0, 1])).toBeLessThan(c.tolerance);
      const hips = keys(file, 'hips', 'translation');
      expect(hips[0]![1]).toBeCloseTo(0.95, 2);
      expect(hips[15]![1]! - hips[0]![1]!).toBeCloseTo(0.02, 3);
      golden[c.format] = { vrma: sha(file), bytes: file.length, warnings: r.manifest.warnings };
    }
    // VRMA in: the BVH's own output comes back byte for byte.
    const again = await convertAnimation(outputs.get('bvh')!, { name: 'vrma' });
    expect(again.manifest.source.format).toBe('vrma');
    expect(again.manifest.file).toBe(sha(outputs.get('bvh')!));
    golden['vrma'] = { vrma: again.manifest.file, bytes: again.manifest.bytes, warnings: again.manifest.warnings };
    const json = `${JSON.stringify(golden, null, 2)}\n`;
    if (process.env['FLATCHAT_GOLDEN_WRITE'] === '1') writeFileSync(GOLDEN, json);
    expect(JSON.parse(json)).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  }, 120_000);

  it('know a file by its first bytes', async () => {
    expect(animationFormat(FBX)).toBe('fbx');
    expect(animationFormat(new TextEncoder().encode(sampleBvh()))).toBe('bvh');
    expect(animationFormat(await sampleClip())).toBe('gltf');
    expect(animationFormat(new TextEncoder().encode('{"just": "json"}'))).toBe('unknown');
  });
});

describe('an animation is refused', () => {
  const refused = async (bytes: Uint8Array): Promise<string> => {
    try {
      await convertAnimation(bytes);
    } catch (err) {
      if (err instanceof AnimationError) return err.problems.join(' | ');
      throw err;
    }
    throw new Error('it converted');
  };

  it('when it is no humanoid, too long, an FBX not yet through Blender, or not an animation at all', async () => {
    const tail = `HIERARCHY\nROOT Tail\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n JOINT Tip\n {\n  OFFSET 0 10 0\n  CHANNELS 3 Zrotation Xrotation Yrotation\n  End Site\n  {\n   OFFSET 0 5 0\n  }\n }\n}\nMOTION\nFrames: 2\nFrame Time: 0.0333333\n0 0 0 0 0 0 0 0 0\n0 0 0 0 0 0 0 0 0\n`;
    expect(await refused(new TextEncoder().encode(tail))).toMatch(/no hips/);
    const long = sampleBvh().replace(/Frame Time: [\d.]+/, 'Frame Time: 3');
    expect(await refused(new TextEncoder().encode(long))).toMatch(/s at most/);
    expect(await refused(FBX)).toMatch(/headless Blender/);
    expect(await refused(new TextEncoder().encode('just some text'))).toMatch(/not an animation FlatChat reads/);
  });
});

// The FBX's road through Blender, where Blender is (this desktop; CI reads the fixture it wrote).
const BLENDER = process.env['FLATCHAT_BLENDER'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender', 'blender-5.2.2-linux-x64', 'blender');
describe.runIf(existsSync(BLENDER))('the FBX through headless Blender', () => {
  it('becomes a GLB that converts to the same motion as the fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcfbx-'));
    try {
      execFileSync(BLENDER, ['-b', '--factory-startup', '-noaudio', '-Y', '--offline-mode', '--python', join(HERE, '..', '..', 'blender', 'animation', 'fbx2glb.py'), '--', join(FIXTURES, 'wave.fbx'), join(dir, 'out.glb')], { stdio: 'ignore', timeout: 120_000 });
      const fresh = await convertAnimation(new Uint8Array(readFileSync(join(dir, 'out.glb'))), { from: 'fbx' });
      const fixture = await convertAnimation(FBX_GLB, { from: 'fbx' });
      const a = fresh.files.get(fresh.manifest.file)!;
      const b = fixture.files.get(fixture.manifest.file)!;
      for (const bone of ['rightUpperArm', 'head', 'leftUpperArm']) for (const f of [0, 15, 30]) expect(deg(at(keys(a, bone, 'rotation'), f), at(keys(b, bone, 'rotation'), f))).toBeLessThan(0.1);
      expect((fresh.manifest as AnimationManifest).duration).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
