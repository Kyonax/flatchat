// SPDX-License-Identifier: MPL-2.0
// A test garment fitted on all three bodies (S5.01's verify, S5.02's checks): a tee made from each
// kit's own chest, belly and upper arms (the triangles those bones move most), moved out 8 mm along the
// body's normals, skinned with the body's own weights. The bodies share one topology, so the same
// triangles make the same garment on each: dp-001's refit between bodies, done at authoring time.
// It declares itself as an item creators would (extras.flatchat_item on its scene, extras.flatchat_fit
// on each fit), so the item converter reads it like any upload.
//
//   node tools/converter/scripts/make-test-item.ts [OUT]    (default kits/items/test-tee/test-tee.glb)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document } from '@gltf-transform/core';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { BODY_KITS, type Region, regionOfBone } from '@flatchat/content';
import { avatarIO, readAvatarLevel } from '../src/avatar/convert.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = process.argv[2] ?? join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb');
const COVERS: ReadonlySet<Region> = new Set(['chest', 'belly', 'upper_arm_l', 'upper_arm_r']);
const OFFSET = 0.008;
export const DECLARATION = { name: 'Test tee', slot: 'top', hides: [...COVERS].sort(), authors: ['the FlatChat contributors'] };

async function fit(body: (typeof BODY_KITS)[number]): Promise<Document> {
  const { doc } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', body, `${body}.vrm`))));
  const root = doc.getRoot();
  const node = root.listNodes().find((n) => n.getMesh() && n.getSkin())!;
  const joints = node.getSkin()!.listJoints().map((j) => j.getName());
  const prim = node.getMesh()!.listPrimitives().find((p) => (p.getMaterial()?.getName() ?? '').endsWith('.body'))!;
  const [pos, nor, uv, j0, w0] = (['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'] as const).map((s) => prim.getAttribute(s)!);
  const count = pos!.getCount();
  const covered = Array.from({ length: count }, (_, v) => {
    const j = j0!.getElement(v, []);
    const w = w0!.getElement(v, []);
    let best = 0;
    for (let k = 1; k < 4; k++) if (w[k]! > w[best]!) best = k;
    const region = regionOfBone(joints[j[best]!]!);
    return region !== undefined && COVERS.has(region);
  });
  const idx = prim.getIndices()!.getArray()!;
  const keep: number[] = [];
  for (let t = 0; t + 2 < idx.length; t += 3) if (covered[idx[t]!] && covered[idx[t + 1]!] && covered[idx[t + 2]!]) keep.push(idx[t]!, idx[t + 1]!, idx[t + 2]!);
  const remap = new Map<number, number>();
  for (const v of keep) if (!remap.has(v)) remap.set(v, remap.size);
  const n = remap.size;
  const out = { pos: new Float32Array(n * 3), nor: new Float32Array(n * 3), uv: new Float32Array(n * 2), j: new Uint16Array(n * 4), w: new Float32Array(n * 4) };
  for (const [v, i] of remap) {
    const p = pos!.getElement(v, []);
    const q = nor!.getElement(v, []);
    out.pos.set([p[0]! + q[0]! * OFFSET, p[1]! + q[1]! * OFFSET, p[2]! + q[2]! * OFFSET], i * 3);
    out.nor.set(q.slice(0, 3), i * 3);
    out.uv.set(uv!.getElement(v, []).slice(0, 2), i * 2);
    out.j.set(j0!.getElement(v, []).slice(0, 4), i * 4);
    out.w.set(w0!.getElement(v, []).slice(0, 4), i * 4);
  }
  const buffer = root.listBuffers()[0]!;
  const material = doc.createMaterial('test_tee').setBaseColorFactor([0.09, 0.52, 0.58, 1]).setMetallicFactor(0).setRoughnessFactor(0.9).setDoubleSided(true);
  const tee = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out.pos).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out.nor).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(out.uv).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(out.j).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(out.w).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(keep, (v) => remap.get(v)!)).setBuffer(buffer));
  const old = node.getMesh()!;
  node.setMesh(doc.createMesh(`test_tee_${body}`).addPrimitive(tee)).setName(`test_tee_${body}`).setExtras({ flatchat_fit: body });
  old.dispose();
  // An item, not an avatar: no VRM data, no textures of the body's.
  for (const e of root.listExtensionsUsed()) e.dispose();
  for (const t of root.listTextures()) t.dispose();
  return doc;
}

const io = avatarIO();
const docs = [];
for (const body of BODY_KITS) docs.push(await fit(body));
const merged = docs[0]!;
for (const other of docs.slice(1)) mergeDocuments(merged, other);
const [scene, ...rest] = merged.getRoot().listScenes();
for (const s of rest) {
  for (const child of s.listChildren()) scene!.addChild(child);
  s.dispose();
}
scene!.setExtras({ flatchat_item: DECLARATION });
await merged.transform(prune(), unpartition());
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, await io.writeBinary(merged));
process.stdout.write(`${JSON.stringify({ event: 'test-item', out: OUT })}\n`);
