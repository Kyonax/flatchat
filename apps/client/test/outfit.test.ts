// SPDX-License-Identifier: MPL-2.0
// Outfits on avatars (S5.05), without a window: the test tee's fit for the feminine body, as the
// item converter writes it, put on the feminine body's own converted level by bone names, stays
// 8 mm out from the skin (it was made 8 mm out along the body's normals) at rest and in poses, as
// the skin under it moves; bound wrongly, it would not. The regions it hides leave the body's
// triangles, and come back; a prop rides its point's bone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACH_POINTS, type Region } from '@flatchat/content';
import { convertItem } from '@flatchat/converter';
import { avatarIO, convertAvatar } from '@flatchat/converter/avatar';
// trap-lint: allow T11 because the test reads the converter's own output to measure it, never a creator's file
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { fitTemplate, hideRegions, REGION_NAMES, regionsOf, restPlaces, wearFit, wearProp } from '../src/renderer/src/world/outfit';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]): Uint8Array => new Uint8Array(readFileSync(join(ROOT, ...p)));

/** A GLB parsed by three.js in Node: its textures left out (there is no image decoder here). */
async function parse(bytes: Uint8Array): Promise<THREE.Object3D> {
  const io = avatarIO();
  const doc = await io.readBinary(bytes);
  for (const t of doc.getRoot().listTextures()) t.dispose();
  const plain = await io.writeBinary(doc);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer, '');
  return gltf.scene;
}

let body: THREE.Object3D;
let fit: THREE.Object3D;
beforeAll(async () => {
  const avatar = await convertAvatar(read('kits', 'bodies', 'feminine', 'feminine.vrm'), { ktx2: false });
  body = await parse(avatar.files.get(avatar.manifest.levels.lod0.file)!);
  const item = await convertItem(read('kits', 'items', 'test-tee', 'test-tee.glb'), { ktx2: false });
  fit = await parse(item.files.get(item.manifest.fits.feminine!.file)!);
}, 120_000);

const skinOf = (root: THREE.Object3D): THREE.SkinnedMesh => {
  let best: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && m.name !== 'flatchat-fit' && (!best || m.geometry.getAttribute('position').count > best.geometry.getAttribute('position').count)) best = m;
  });
  return best!;
};

/** Every vertex where skinning puts it now, in the scene's frame. */
function posed(mesh: THREE.SkinnedMesh): Float32Array {
  const n = mesh.geometry.getAttribute('position').count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    out.set([v.x, v.y, v.z], i * 3);
  }
  return out;
}

/** Each fit vertex's distance to the nearest skin vertex, sorted, in millimetres. */
function gaps(skin: Float32Array, cloth: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < cloth.length; i += 3) {
    let best = Infinity;
    for (let j = 0; j < skin.length; j += 3) {
      const d = (cloth[i]! - skin[j]!) ** 2 + (cloth[i + 1]! - skin[j + 1]!) ** 2 + (cloth[i + 2]! - skin[j + 2]!) ** 2;
      if (d < best) best = d;
    }
    out.push(Math.sqrt(best) * 1000);
  }
  return out.sort((a, b) => a - b);
}

const bone = (name: string): THREE.Object3D => body.getObjectByName(name)!;

describe('a fit on its body', () => {
  it('stays 8 mm out from the skin at rest and as the body moves', () => {
    const meshes = wearFit(fitTemplate(fit), body)!;
    expect(meshes).toHaveLength(1);
    body.add(...meshes);
    const skin = skinOf(body);
    const check = (): { median: number; worst: number } => {
      body.updateMatrixWorld(true);
      const g = gaps(posed(skin), posed(meshes[0]!));
      return { median: g[Math.floor(g.length / 2)]!, worst: g.at(-1)! };
    };
    const rest = check();
    expect(rest.median).toBeGreaterThan(6);
    expect(rest.median).toBeLessThan(9);
    expect(rest.worst).toBeLessThan(12);
    // Arms down and the trunk turned and bent: the same 8 mm.
    bone('upperarm_l').rotateZ(-1.1);
    bone('upperarm_r').rotateZ(1.1);
    bone('spine_02').rotateX(0.35);
    bone('spine_03').rotateY(0.4);
    const moved = check();
    expect(moved.median).toBeGreaterThan(6);
    expect(moved.median).toBeLessThan(9);
    expect(moved.worst).toBeLessThan(15);
    // Bound to the bones without its inverse bind matrices, it would sit far from the skin.
    const wrong = wearFit({ parts: fitTemplate(fit).parts.map((p) => ({ ...p, inverses: p.inverses.map(() => new THREE.Matrix4()) })) }, body)!;
    body.add(...wrong);
    body.updateMatrixWorld(true);
    expect(gaps(posed(skin), posed(wrong[0]!))[Math.floor(wrong[0]!.geometry.getAttribute('position').count / 2)]!).toBeGreaterThan(50);
    body.remove(...meshes, ...wrong);
    for (const name of ['upperarm_l', 'upperarm_r', 'spine_02', 'spine_03']) bone(name).rotation.set(0, 0, 0);
  });

  it('is not put on a body without its bones', () => {
    const robot = new THREE.Group();
    robot.add(new THREE.Bone());
    expect(wearFit(fitTemplate(fit), robot)).toBeUndefined();
  });
});

describe('hidden regions', () => {
  it('leave the body’s triangles whose corners are all hidden, and come back', () => {
    const skin = skinOf(body);
    const all = (skin.geometry.index?.count ?? 0) / 3;
    const regions = regionsOf(skin);
    expect(new Set(regions).size).toBeGreaterThan(10);
    const hides = new Set<Region>(['belly', 'chest', 'upper_arm_l', 'upper_arm_r']);
    const left = hideRegions(skin, hides);
    // The tee was cut from exactly these regions' triangles: as many go.
    const tee = (skinOf(fit).geometry.index?.count ?? 0) / 3;
    expect(all - left).toBe(tee);
    // No triangle left has all three corners in a hidden region.
    const idx = skin.geometry.index!.array;
    const hidden = (v: number): boolean => hides.has(REGION_NAMES[regions[v]!]!);
    for (let i = 0; i < idx.length; i += 3) expect(hidden(idx[i]!) && hidden(idx[i + 1]!) && hidden(idx[i + 2]!)).toBe(false);
    expect(hideRegions(skin, new Set())).toBe(all);
  });
});

describe('a prop at its point', () => {
  it('sits at the point at rest and rides its bone', () => {
    const humanoid: Record<string, string> = { head: 'head', hips: 'pelvis', leftHand: 'hand_l' };
    const node = (b: string): THREE.Object3D | undefined => (humanoid[b] ? body.getObjectByName(humanoid[b]) : undefined);
    const rest = restPlaces(body);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
    const pivot = wearProp(cap, 'head_top', node, rest, 1.562, undefined)!;
    body.updateMatrixWorld(true);
    const at = cap.getWorldPosition(new THREE.Vector3());
    const head = rest.get('head')!;
    const want = new THREE.Vector3(head.elements[12], head.elements[13]! + ATTACH_POINTS.head_top.offset[1] * 1.562, head.elements[14]);
    expect(at.distanceTo(want)).toBeLessThan(0.001);
    // The head turns: the cap goes with it, as far from the head as before.
    bone('head').rotateX(0.6);
    body.updateMatrixWorld(true);
    const headNow = bone('head').getWorldPosition(new THREE.Vector3());
    const capNow = cap.getWorldPosition(new THREE.Vector3());
    expect(capNow.distanceTo(at)).toBeGreaterThan(0.02);
    expect(capNow.distanceTo(headNow)).toBeCloseTo(at.distanceTo(new THREE.Vector3(head.elements[12], head.elements[13], head.elements[14])), 4);
    bone('head').rotation.set(0, 0, 0);
    pivot.removeFromParent();
    // A point the avatar has no bone for gets no prop.
    expect(wearProp(new THREE.Object3D(), 'back', node, rest, 1.562, undefined)).toBeUndefined();
  });
});
