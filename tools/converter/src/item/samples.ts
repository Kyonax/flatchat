// SPDX-License-Identifier: MPL-2.0
// Sample items for tests and acceptance runs: an attachment (S5.04, S5.05), a 20 cm cube with the
// declaration a creator's file would carry, rigid or, to be refused, skinned to one bone; and a
// garment made on the three standard bodies (S5.01's test tee, S5.10's jacket): each kit's own
// triangles over the regions it covers, moved out along the body's normals, skinned with the
// body's own weights. The bodies share one topology, so the same triangles make the same garment on
// each: dp-001's refit between bodies, done at authoring time. It declares itself as creators' items
// do (extras.flatchat_item on its scene, extras.flatchat_fit on each fit).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, type BodyKit, type Region, regionOfBone, type Slot } from '@flatchat/content';
import { Document, NodeIO } from '@gltf-transform/core';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { avatarIO, readAvatarLevel } from '../avatar/convert.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export async function sampleProp(declare: Record<string, unknown>, skinned = false): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const s = 0.1;
  const positions = new Float32Array([-s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s, -s, -s, s, s, -s, s, s, s, s, -s, s, s]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial('cap').setBaseColorFactor([0.8, 0.2, 0.2, 1])).setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer)).setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  const node = doc.createNode('cap').setMesh(doc.createMesh('cap').addPrimitive(prim));
  if (skinned) {
    const joint = doc.createNode('head');
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(32)).setBuffer(buffer)).setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(32).map((_, i) => (i % 4 === 0 ? 1 : 0))).setBuffer(buffer));
    node.setSkin(doc.createSkin('cap').addJoint(joint));
    doc.createScene('scene').addChild(node).addChild(joint).setExtras({ flatchat_item: declare });
  } else doc.createScene('scene').addChild(node).setExtras({ flatchat_item: declare });
  return new NodeIO().writeBinary(doc);
}

/** A garment to make on the kits: its declaration's name, slot and authors, a prefix for its
 *  meshes and material, the regions it covers (and hides), how far out from the skin, its colour. */
export interface GarmentSpec {
  name: string;
  id: string;
  slot: Slot;
  covers: readonly Region[];
  offset: number;
  colour: [number, number, number, number];
  authors: string[];
}

/** S5.01's test tee (kits/items/test-tee/, written by scripts/make-test-item.ts). */
export const TEST_TEE: GarmentSpec = { name: 'Test tee', id: 'test_tee', slot: 'top', covers: ['chest', 'belly', 'upper_arm_l', 'upper_arm_r'], offset: 0.008, colour: [0.09, 0.52, 0.58, 1], authors: ['the FlatChat contributors'] };
/** S5.10's jacket: an outer layer with long sleeves, over the tee's reach. */
export const TEST_JACKET: GarmentSpec = {
  name: 'Test jacket',
  id: 'test_jacket',
  slot: 'outer',
  covers: ['chest', 'belly', 'upper_arm_l', 'upper_arm_r', 'lower_arm_l', 'lower_arm_r'],
  offset: 0.014,
  colour: [0.55, 0.32, 0.12, 1],
  authors: ['the FlatChat contributors'],
};

/** The garment's declaration, as its scene carries it. */
export const garmentDeclaration = (g: GarmentSpec): { name: string; slot: Slot; hides: Region[]; authors: string[] } => ({ name: g.name, slot: g.slot, hides: [...g.covers].sort(), authors: g.authors });

/** One body's fit of a garment: the kit's own triangles over its regions, moved out. */
async function fit(g: GarmentSpec, body: BodyKit): Promise<Document> {
  const covers: ReadonlySet<Region> = new Set(g.covers);
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
    return region !== undefined && covers.has(region);
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
    out.pos.set([p[0]! + q[0]! * g.offset, p[1]! + q[1]! * g.offset, p[2]! + q[2]! * g.offset], i * 3);
    out.nor.set(q.slice(0, 3), i * 3);
    out.uv.set(uv!.getElement(v, []).slice(0, 2), i * 2);
    out.j.set(j0!.getElement(v, []).slice(0, 4), i * 4);
    out.w.set(w0!.getElement(v, []).slice(0, 4), i * 4);
  }
  const buffer = root.listBuffers()[0]!;
  const material = doc.createMaterial(g.id).setBaseColorFactor(g.colour).setMetallicFactor(0).setRoughnessFactor(0.9).setDoubleSided(true);
  const garment = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out.pos).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out.nor).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(out.uv).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(out.j).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(out.w).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(keep, (v) => remap.get(v)!)).setBuffer(buffer));
  const old = node.getMesh()!;
  node.setMesh(doc.createMesh(`${g.id}_${body}`).addPrimitive(garment)).setName(`${g.id}_${body}`).setExtras({ flatchat_fit: body });
  old.dispose();
  // An item, not an avatar: no VRM data, no textures of the body's.
  for (const e of root.listExtensionsUsed()) e.dispose();
  for (const t of root.listTextures()) t.dispose();
  return doc;
}

/** A garment fitted on every standard body, as one GLB that declares itself. */
export async function makeGarment(g: GarmentSpec): Promise<Uint8Array> {
  const docs = [];
  for (const body of BODY_KITS) docs.push(await fit(g, body));
  const merged = docs[0]!;
  for (const other of docs.slice(1)) mergeDocuments(merged, other);
  const [scene, ...rest] = merged.getRoot().listScenes();
  for (const s of rest) {
    for (const child of s.listChildren()) scene!.addChild(child);
    s.dispose();
  }
  scene!.setExtras({ flatchat_item: garmentDeclaration(g) });
  await merged.transform(prune(), unpartition());
  return avatarIO().writeBinary(merged);
}
