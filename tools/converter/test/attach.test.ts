// SPDX-License-Identifier: MPL-2.0
// Attachment points on real avatars (S5.04's verify: all three bodies and a free-shape avatar):
// computed from the shared rules, every point lands within 5 cm of the kits' own markers, and on the
// free-shape robot and the VRM reference avatar every point finds a bone and lands on the model. An
// attachment (a prop worn at a point) converts; a skinned one, or one without a point, does not.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACH_POINTS, type AttachPoint, attachBone, attachMatrix, BODY_KITS, checkItemProp, readGltf } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { convertAvatar, readAvatarLevel } from '../src/avatar/convert.ts';
import { sampleAvatar } from '../src/avatar/samples.ts';
import { convertItem, ItemError } from '../src/item/convert.ts';
import { sampleProp } from '../src/item/samples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const POINTS = Object.keys(ATTACH_POINTS) as AttachPoint[];
const xyz = (m: ArrayLike<number>): [number, number, number] => [m[12]!, m[13]!, m[14]!];

describe('attachment points on the kits', () => {
  for (const body of BODY_KITS) {
    it(`${body}: every point within 5 cm of its marker`, async () => {
      const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', body, `${body}.vrm`))));
      const bones = data.humanBones();
      const ys = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;
      const p: number[] = [];
      let [lo, hi] = [Infinity, -Infinity];
      for (let i = 0; i < ys.getCount(); i++) {
        ys.getElement(i, p);
        lo = Math.min(lo, p[1]!);
        hi = Math.max(hi, p[1]!);
      }
      for (const point of POINTS) {
        const marker = doc.getRoot().listNodes().find((n) => n.getName() === `attach_${point}`);
        expect(marker, point).toBeDefined();
        const bone = bones.get(attachBone(point, (b) => bones.has(b))!)!;
        const m = bone.getWorldMatrix();
        const computed = xyz(attachMatrix(point, m, m, hi - lo));
        const actual = xyz(marker!.getWorldMatrix());
        expect(Math.hypot(...computed.map((v, i) => v - actual[i]!)), point).toBeLessThan(0.05);
      }
    });
  }
});

describe('attachment points on other avatars', () => {
  for (const kind of ['free', 'vrm1'] as const) {
    it(`the ${kind} reference avatar: every point finds a bone and lands on the model`, async () => {
      const r = await convertAvatar(await sampleAvatar(kind), { ktx2: false });
      const { doc, data } = await readAvatarLevel(r.files.get(r.manifest.levels.lod0.file)!);
      const bones = data.humanBones();
      const box = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      for (const node of doc.getRoot().listNodes()) {
        const [x, y, z] = xyz(node.getWorldMatrix());
        [x, y, z].forEach((v, i) => {
          box.lo[i] = Math.min(box.lo[i]!, v);
          box.hi[i] = Math.max(box.hi[i]!, v);
        });
      }
      const margin = 0.15 * r.manifest.height;
      for (const point of POINTS) {
        const name = attachBone(point, (b) => bones.has(b));
        expect(name, point).toBeDefined();
        const m = bones.get(name!)!.getWorldMatrix();
        const at = xyz(attachMatrix(point, m, m, r.manifest.height));
        at.forEach((v, i) => {
          expect(v, `${point} axis ${i}`).toBeGreaterThan(box.lo[i]! - margin);
          expect(v, `${point} axis ${i}`).toBeLessThan(box.hi[i]! + margin);
        });
      }
    }, 60_000);
  }
});

describe('attachments', () => {
  it('convert into one prop worn at their point', async () => {
    const r = await convertItem(await sampleProp({ name: 'Test cap', slot: 'attachment', attach: 'head_top' }), { ktx2: false });
    expect(r.manifest).toMatchObject({ slot: 'attachment', attach: 'head_top', hides: [], fits: {} });
    expect(r.manifest.prop!.triangles).toBe(12);
    expect(() => checkItemProp(readGltf(r.files.get(r.manifest.prop!.file)!, 'prop.glb').json as unknown as Record<string, unknown>)).not.toThrow();
  });

  it('are refused skinned, or without their point', async () => {
    await expect(convertItem(await sampleProp({ name: 'Cap', slot: 'attachment', attach: 'head_top' }, true), { ktx2: false })).rejects.toThrow(/rigid meshes, no skin/);
    await expect(convertItem(await sampleProp({ name: 'Cap', slot: 'attachment' }), { ktx2: false })).rejects.toBeInstanceOf(ItemError);
  });
});
