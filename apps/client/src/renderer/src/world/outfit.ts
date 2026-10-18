// SPDX-License-Identifier: MPL-2.0
// What a player wears, on their avatar (S5.05, dp-001, dp-002). Clothes go on the three standard
// bodies only: each item carries a fit made on each body it fits, skinned to the kits' bones by name
// and bound as the body is (the converter checked its skeleton against the body's in the bind pose),
// so here it is put on the avatar's own bones with its own inverse bind matrices, and moves exactly
// as the skin under it. The regions it hides go from the body's triangles (each vertex's region is
// the one of the bone that moves it most, as the converter counts it). A prop goes on any avatar,
// a free shape too: it rides its point's bone, placed where the point sat at rest (attachMatrix).
import { attachBone, attachMatrix, type AttachPoint, REGIONS, type Region, regionOfBone, type WornAdjust, wornAdjustment } from '@flatchat/content';
import * as THREE from 'three/webgpu';

const NO_REGION = 255;
/** The regions in order: what regionsOf's numbers index. */
export const REGION_NAMES = Object.keys(REGIONS) as Region[];
const REGION_INDEX = new Map<string, number>(REGION_NAMES.map((r, i) => [r, i]));

/** Each vertex's region (an index into REGION_NAMES, 255 for none): the region of the bone with the
 *  most weight on it, by the bone's name. */
export function regionsOf(mesh: THREE.SkinnedMesh): Uint8Array {
  const cached = mesh.userData['flatchatRegions'] as Uint8Array | undefined;
  if (cached) return cached;
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  const count = mesh.geometry.getAttribute('position').count;
  const out = new Uint8Array(count).fill(NO_REGION);
  if (index && weight) {
    const byBone = mesh.skeleton.bones.map((b) => REGION_INDEX.get(regionOfBone(b.name) ?? '') ?? NO_REGION);
    for (let v = 0; v < count; v++) {
      let best = -1;
      let most = 0;
      for (let k = 0; k < 4; k++) {
        const w = weight.getComponent(v, k);
        if (w > most) {
          most = w;
          best = index.getComponent(v, k);
        }
      }
      if (best >= 0) out[v] = byBone[best] ?? NO_REGION;
    }
  }
  mesh.userData['flatchatRegions'] = out;
  return out;
}

/** Leaves out the triangles whose three corners are all in hidden regions (the edge of a region
 *  stays, under the garment's opening), or puts every one back for an empty set. Answers how many
 *  triangles are drawn now. */
export function hideRegions(mesh: THREE.SkinnedMesh, hidden: ReadonlySet<Region>): number {
  const g = mesh.geometry;
  const whole = (g.userData['flatchatWholeIndex'] as THREE.BufferAttribute | undefined) ?? g.index ?? undefined;
  if (!whole) return g.getAttribute('position').count / 3;
  g.userData['flatchatWholeIndex'] = whole;
  const key = [...hidden].sort().join(',');
  if (g.userData['flatchatHidden'] === key) return (g.index?.count ?? whole.count) / 3;
  g.userData['flatchatHidden'] = key;
  if (hidden.size === 0) {
    g.setIndex(whole);
    return whole.count / 3;
  }
  const regions = regionsOf(mesh);
  const off = new Uint8Array(256);
  for (const r of hidden) off[REGION_INDEX.get(r) ?? NO_REGION] = 1;
  off[NO_REGION] = 0;
  const src = whole.array;
  const kept: number[] = [];
  for (let i = 0; i + 2 < whole.count; i += 3) {
    const a = src[i]!;
    const b = src[i + 1]!;
    const c = src[i + 2]!;
    if (off[regions[a]!] && off[regions[b]!] && off[regions[c]!]) continue;
    kept.push(a, b, c);
  }
  const array = whole.array instanceof Uint32Array || g.getAttribute('position').count > 65535 ? new Uint32Array(kept) : new Uint16Array(kept);
  g.setIndex(new THREE.BufferAttribute(array, 1));
  return kept.length / 3;
}

/** A fit as parsed once, shared by every avatar wearing it: each skinned part's geometry and
 *  material, its joints by name, its inverse bind matrices and its bind matrix. */
export interface FitTemplate {
  parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; joints: string[]; inverses: THREE.Matrix4[]; bind: THREE.Matrix4 }>;
}

/** The skinned parts of a parsed fit (its glTF scene). */
export function fitTemplate(scene: THREE.Object3D): FitTemplate {
  scene.updateMatrixWorld(true);
  const parts: FitTemplate['parts'] = [];
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    parts.push({ geometry: m.geometry, material: m.material, joints: m.skeleton.bones.map((b) => b.name), inverses: m.skeleton.boneInverses.map((x) => x.clone()), bind: m.bindMatrix.clone() });
  });
  return { parts };
}

/** The fit on a body: new skinned meshes on the body's own bones (found by name under `body`, the
 *  avatar's scene), sharing the template's geometry and material. Undefined when the body lacks a
 *  bone the fit is skinned to (it is not the body the fit was made for). */
export function wearFit(t: FitTemplate, body: THREE.Object3D): THREE.SkinnedMesh[] | undefined {
  const bones = new Map<string, THREE.Bone>();
  body.traverse((o) => {
    if ((o as THREE.Bone).isBone && o.name && !bones.has(o.name)) bones.set(o.name, o as THREE.Bone);
  });
  const out: THREE.SkinnedMesh[] = [];
  for (const p of t.parts) {
    const skeleton = p.joints.map((n) => bones.get(n));
    if (skeleton.some((b) => !b)) return undefined;
    const mesh = new THREE.SkinnedMesh(p.geometry, p.material);
    mesh.name = 'flatchat-fit';
    // Skinned meshes move past their bounds; the avatar's holder is culled as a whole.
    mesh.frustumCulled = false;
    mesh.bind(new THREE.Skeleton(skeleton as THREE.Bone[], p.inverses), p.bind);
    out.push(mesh);
  }
  return out;
}

/** Each bone's place at rest, relative to the avatar's scene, taken once the level is parsed (it
 *  stands at rest then): what a prop's point is measured from. */
export function restPlaces(root: THREE.Object3D): Map<string, THREE.Matrix4> {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const out = new Map<string, THREE.Matrix4>();
  root.traverse((o) => {
    if (o.name && !out.has(o.name)) out.set(o.name, toRoot.clone().multiply(o.matrixWorld));
  });
  return out;
}

/** A prop at its point: a pivot under the point's bone (`node(humanBone)` finds a VRM humanoid
 *  bone's node), placed where the point sat at rest (the bone's rest place plus the point's offset
 *  × the avatar's height, then the player's adjustment), so it follows the bone from then on.
 *  Undefined when the avatar has no bone for the point. */
export function wearProp(prop: THREE.Object3D, point: AttachPoint, node: (humanBone: string) => THREE.Object3D | undefined, rest: Map<string, THREE.Matrix4>, height: number, adjust: WornAdjust | undefined): THREE.Object3D | undefined {
  const bone = attachBone(point, (b) => node(b) !== undefined);
  const target = bone ? node(bone) : undefined;
  const restAt = target ? rest.get(target.name) : undefined;
  if (!target || !restAt) return undefined;
  const r = restAt.elements;
  const world = attachMatrix(point, r, r, height, wornAdjustment(adjust));
  const pivot = new THREE.Group();
  pivot.name = 'flatchat-prop';
  pivot.matrixAutoUpdate = false;
  pivot.matrix.copy(restAt.clone().invert().multiply(new THREE.Matrix4().fromArray(world)));
  pivot.add(prop);
  prop.traverse((o) => ((o as THREE.Mesh).frustumCulled = false));
  target.add(pivot);
  return pivot;
}
