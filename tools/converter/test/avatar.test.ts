// SPDX-License-Identifier: MPL-2.0
// The avatar converter (S4.02, S4.03): the reference avatars (VRM 1.0, VRM 0.x, a Mixamo-named GLB)
// convert as the golden file says, every level passes vrm-validator, a VRM 0.x is turned to face
// +Z, the levels keep what they promise (LOD1 its face, LOD2 only the mouth and blinks, the
// impostor 20 bones, one texture and at most 2,000 triangles, none of them stretched by a stride),
// the rank follows the table, the same
// file always gives the same avatar, the converter runs sandboxed, and a malformed corpus is
// refused with a reason and without a crash.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANK_LIMITS, rankOf, type AvatarStats } from '@flatchat/content';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AvatarError, type AvatarResult, convertAvatar } from '../src/avatar/convert.ts';
import { sampleAvatar, type SampleKind } from '../src/avatar/samples.ts';
import { impostorStretch, stretchedTriangles } from '../src/avatar/stride.ts';
import { VRMExtension, type VRMData } from '../src/avatar/vrm.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'avatars.json');
const require = createRequire(import.meta.url);
const vrmValidator = require('vrm-validator') as { validateBytes(b: Uint8Array, o: object): Promise<{ issues: { messages: Array<{ severity: number; code: string }> } }> };
const KINDS: SampleKind[] = ['vrm1', 'vrm0', 'glb'];

const sources = new Map<SampleKind, Uint8Array>();
const results = new Map<SampleKind, AvatarResult>();
beforeAll(async () => {
  for (const kind of KINDS) {
    const bytes = await sampleAvatar(kind);
    sources.set(kind, bytes);
    results.set(kind, await convertAvatar(bytes, { ktx2: false }));
  }
}, 60_000);

const read = async (bytes: Uint8Array): Promise<{ doc: Document; vrm: VRMData }> => {
  const doc = await new NodeIO().registerExtensions([...ALL_EXTENSIONS, VRMExtension]).readBinary(bytes);
  return { doc, vrm: doc.getRoot().getExtension<VRMData>('VRMC_vrm')! };
};
const level = (kind: SampleKind, l: 'lod0' | 'lod1' | 'lod2' | 'impostor'): Uint8Array => {
  const r = results.get(kind)!;
  return r.files.get(r.manifest.levels[l].file)!;
};

describe('the reference avatars', () => {
  it('convert as the golden file says', () => {
    const summary = Object.fromEntries(
      KINDS.map((k) => {
        const m = results.get(k)!.manifest;
        return [k, { kind: m.source.kind, rank: m.rank, levels: Object.fromEntries(Object.entries(m.levels).map(([n, l]) => [n, { triangles: l.triangles, bones: l.bones, materialSlots: l.materialSlots }])), bones: m.bones.length, expressions: m.expressions, height: m.height, springs: m.springs, warnings: m.warnings }];
      }),
    );
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (process.env['FLATCHAT_GOLDEN_WRITE'] === '1') writeFileSync(GOLDEN, json);
    expect(json).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('give levels that pass vrm-validator', async () => {
    for (const kind of KINDS) {
      for (const l of ['lod0', 'lod1', 'lod2', 'impostor'] as const) {
        const report = await vrmValidator.validateBytes(level(kind, l), { maxIssues: 0 });
        expect(report.issues.messages.filter((m) => m.severity === 0).map((m) => m.code), `${kind} ${l}`).toEqual([]);
      }
    }
  });

  it('face +Z with the left hand at +X, a VRM 0.x turned round', async () => {
    for (const kind of KINDS) {
      const { vrm } = await read(level(kind, 'lod0'));
      const bones = vrm.humanBones();
      const x = (n: string): number => (bones.get(n)!.getWorldMatrix() as unknown as number[])[12]!;
      expect(x('leftHand'), kind).toBeGreaterThan(x('rightHand'));
    }
  });

  it('keep the face in LOD1, only the mouth and blinks in LOD2, and the impostor small', async () => {
    const vrm0 = results.get('vrm0')!.manifest;
    expect(vrm0.levels.lod1.triangles / vrm0.levels.lod0.triangles).toBeGreaterThan(0.45);
    expect(vrm0.levels.lod1.triangles / vrm0.levels.lod0.triangles).toBeLessThan(0.6);
    expect(vrm0.levels.lod2.triangles / vrm0.levels.lod0.triangles).toBeLessThan(0.3);
    // LOD1 keeps every expression; LOD2 drops `happy` (a colour bind) and keeps aa and blink.
    const exprs = async (l: 'lod1' | 'lod2'): Promise<string[]> => {
      const { vrm } = await read(level('vrm0', l));
      const e = (vrm.getDocument().vrm['expressions'] ?? {}) as Record<string, Record<string, unknown>>;
      return [...Object.keys(e['preset'] ?? {}), ...Object.keys(e['custom'] ?? {})].sort();
    };
    expect(await exprs('lod1')).toEqual(['aa', 'blink', 'happy']);
    expect(await exprs('lod2')).toEqual(['aa', 'blink']);
    // The mouth moves the same vertices in LOD1 as in the full avatar.
    const moved = async (l: 'lod0' | 'lod1'): Promise<number> => {
      const { doc } = await read(level('vrm0', l));
      let n = 0;
      const v: number[] = [];
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const t = prim.listTargets()[0]?.getAttribute('POSITION');
          if (!t) continue;
          for (let i = 0; i < t.getCount(); i++) if (Math.abs(t.getElement(i, v)[1]!) > 1e-5) n += 1;
        }
      }
      return n;
    };
    expect(await moved('lod1')).toBe(await moved('lod0'));
    const impostor = results.get('vrm1')!.manifest.levels.impostor;
    expect(impostor.triangles).toBeLessThanOrEqual(2000);
    expect(impostor.bones).toBe(20);
    expect(impostor.materialSlots).toBe(1);
    const { doc } = await read(level('vrm1', 'impostor'));
    expect(doc.getRoot().listTextures().map((t) => t.getSize())).toEqual([[512, 512]]);
  });

  it('walk with whole impostors: a stride stretches none of their triangles (S4.12)', async () => {
    for (const kind of KINDS) {
      const { doc, vrm } = await read(level(kind, 'impostor'));
      const r = impostorStretch(doc, vrm.humanBones());
      expect(r.triangles, kind).toBeGreaterThan(0);
      expect(r.stretched, kind).toBe(0);
    }
  });

  it('give the same avatar for the same file', async () => {
    const again = await convertAvatar(sources.get('vrm0')!, { ktx2: false });
    expect(again.id).toBe(results.get('vrm0')!.id);
  });

  it('runs sandboxed: only its upload read, only its folder written, no addons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcavatar-'));
    try {
      writeFileSync(join(dir, 'in.vrm'), sources.get('vrm1')!);
      const out = join(dir, 'out');
      require('node:fs').mkdirSync(out);
      const root = join(HERE, '..', '..', '..');
      const r = spawnSync(
        process.execPath,
        ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${join(dir, 'in.vrm')}`, `--allow-fs-write=${out}`, '--import', join(HERE, '..', 'src', 'sandbox.ts'), join(HERE, '..', 'src', 'avatar-cli.ts'), join(dir, 'in.vrm'), out, '--no-ktx2'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(r.status, r.stderr).toBe(0);
      const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) as { ok: boolean; id: string };
      expect(result).toMatchObject({ ok: true, id: results.get('vrm1')!.id });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a malformed corpus', () => {
  const refused = async (bytes: Uint8Array): Promise<string> => {
    try {
      await convertAvatar(bytes, { ktx2: false });
    } catch (err) {
      expect(err).toBeInstanceOf(AvatarError);
      return (err as AvatarError).problems.join(' / ');
    }
    throw new Error('it was not refused');
  };
  /** The VRM 1.0 sample's JSON edited, its binary chunk kept. */
  const edit = async (change: (json: Record<string, unknown>) => void): Promise<Uint8Array> => {
    const src = (await sampleAvatar('vrm1')).slice();
    const v = new DataView(src.buffer);
    const jsonLength = v.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(src.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
    change(json);
    const enc = new TextEncoder().encode(JSON.stringify(json));
    const padded = Math.ceil(enc.length / 4) * 4;
    const rest = src.subarray(20 + jsonLength);
    const out = new Uint8Array(20 + padded + rest.length);
    const o = new DataView(out.buffer);
    o.setUint32(0, 0x46546c67, true);
    o.setUint32(4, 2, true);
    o.setUint32(8, out.length, true);
    o.setUint32(12, padded, true);
    o.setUint32(16, 0x4e4f534a, true);
    out.set(enc, 20);
    out.fill(0x20, 20 + enc.length, 20 + padded);
    out.set(rest, 20 + padded);
    return out;
  };

  it('is refused with a reason, never a crash', async () => {
    const src = await sampleAvatar('vrm1');
    expect(await refused(new Uint8Array(0))).toMatch(/not a GLB or VRM/);
    expect(await refused(new TextEncoder().encode('{"asset":{"version":"2.0"}}'))).toMatch(/not a GLB or VRM/);
    expect(await refused(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251))).toMatch(/not a GLB or VRM/);
    expect(await refused(src.subarray(0, src.length >> 1))).toMatch(/not a GLB|GLB/);
    expect(await refused(await edit((j) => ((j['buffers'] as Array<Record<string, unknown>>)[0]!['uri'] = 'https://example.org/data.bin')))).toMatch(/outside data|BUFFER/);
    expect(await refused(await edit((j) => (j['extensionsRequired'] = ['KHR_draco_mesh_compression'])))).toMatch(/requires the extension KHR_draco_mesh_compression|EXTENSION/);
    expect(await refused(await edit((j) => (((j['extensions'] as Record<string, Record<string, unknown>>)['VRMC_vrm']!)['specVersion'] = '0.9')))).toMatch(/VRM 1\.0|specVersion|VRM/);
    expect(
      await refused(
        await edit((j) => {
          const bones = (((j['extensions'] as Record<string, Record<string, unknown>>)['VRMC_vrm']!)['humanoid'] as Record<string, Record<string, unknown>>)['humanBones']!;
          delete bones['leftHand'];
          delete bones['head'];
        }),
      ),
    ).toMatch(/head|leftHand|HUMANOID|required/);
    expect(await refused(await edit((j) => ((j['accessors'] as Array<Record<string, unknown>>)[0]!['count'] = 1e9)))).toMatch(/ACCESSOR|count|vertices/);
    // A model with nothing to show.
    const empty = new Document();
    empty.createScene('Scene').addChild(empty.createNode('Nothing'));
    expect(await refused(await new NodeIO().writeBinary(empty))).toMatch(/no mesh to show/);
  }, 60_000);
});

describe('the rank table', () => {
  const base: AvatarStats = { triangles: 10_000, vertices: 8000, textureBytes: 8 * 1024 * 1024, skinnedMeshes: 1, basicMeshes: 0, materialSlots: 2, bones: 60, morphTargets: 10, springs: 2, springJoints: 10, colliders: 2, collisionChecks: 20 };
  it('takes the worst of the numbers, and names them', () => {
    expect(rankOf(base)).toEqual({ rank: 'excellent', limitedBy: [] });
    expect(rankOf({ ...base, triangles: 32_001 })).toEqual({ rank: 'good', limitedBy: ['triangles'] });
    expect(rankOf({ ...base, materialSlots: RANK_LIMITS.medium.materialSlots })).toEqual({ rank: 'medium', limitedBy: ['materialSlots'] });
    expect(rankOf({ ...base, bones: 401, materialSlots: 33 })).toEqual({ rank: 'veryPoor', limitedBy: ['materialSlots', 'bones'] });
    expect(rankOf({ ...base, triangles: 70_000, textureBytes: 150 * 1024 * 1024 })).toEqual({ rank: 'poor', limitedBy: ['textureBytes'] });
  });
});

describe('free shapes (S4.11)', () => {
  it('give a robot with no skeleton a complete humanoid of empty bones, and convert it whole', async () => {
    const r = await convertAvatar(await sampleAvatar('free'), { ktx2: false });
    expect(r.manifest.shape).toBe('free');
    expect(r.manifest.warnings.join(' ')).toMatch(/a free shape: no humanoid skeleton.*bones made: hips, spine, head/);
    for (const l of ['lod0', 'lod1', 'lod2', 'impostor'] as const) {
      const report = await vrmValidator.validateBytes(r.files.get(r.manifest.levels[l].file)!, { maxIssues: 0 });
      expect(report.issues.messages.filter((m) => m.severity === 0).map((m) => m.code), l).toEqual([]);
    }
    const { vrm, doc } = await read(r.files.get(r.manifest.levels.lod0.file)!);
    expect([...vrm.humanBones().keys()].sort()).toEqual(expect.arrayContaining(['hips', 'head', 'leftHand', 'rightFoot']));
    // The whole robot hangs from the hips, where it stood.
    const hips = vrm.humanBones().get('hips')!;
    const body = doc.getRoot().listNodes().find((n) => n.getName() === 'Body')!;
    expect(body.getParentNode()).toBe(hips);
    expect(r.manifest.height).toBeCloseTo(1.28, 1);
  });

  it('keep a GLB’s bones that do map, and make only the missing ones', async () => {
    const doc = await new NodeIO().readBinary(await sampleAvatar('glb'));
    for (const n of doc.getRoot().listNodes()) if (/Arm|Hand/.test(n.getName())) n.setName(n.getName().replace(/Arm|Hand/, 'Fin'));
    const r = await convertAvatar(await new NodeIO().writeBinary(doc), { ktx2: false });
    expect(r.manifest.shape).toBe('free');
    expect(r.manifest.warnings.join(' ')).toMatch(/no leftUpperArm.*bones made: leftUpperArm/);
    expect(r.manifest.warnings.join(' ')).not.toMatch(/bones made: hips/);
  });
});


describe('the stride check (S4.12)', () => {
  it('counts a triangle a walk pulls into a sheet, not one it carries along', () => {
    const rest = [0, 0, 0, 0.1, 0, 0, 0.05, 0.1, 0];
    const carried = rest.map((v, i) => (i % 3 === 2 ? v + 0.5 : v));
    const pulled = [0, 0, 0, 0.1, 0, 0.8, 0.05, 0.1, 0];
    expect(stretchedTriangles(rest, [0, 1, 2], [carried])).toBe(0);
    expect(stretchedTriangles(rest, [0, 1, 2], [carried, pulled])).toBe(1);
  });
});
