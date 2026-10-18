// SPDX-License-Identifier: MPL-2.0
// Turning a built world's scene GLB into three.js objects (S2.04). The bytes came from a world
// server, so before three.js parses them they are checked with packages/content: glTF 2.0, every
// buffer and image inside the GLB (no URI of any kind), the limits. Geometry is meshopt-compressed
// and textures are KTX2 (the converter's output): the decoders come with the bundle, the Basis
// transcoder handed to KTX2Loader as data URLs because a packaged client's page cannot fetch
// files (its worker starts from a blob URL: the page's policy allows workers from blob: only), and
// with its text-built embind helpers swapped for closures, since that policy forbids eval.
// The converter's levels of detail (sibling nodes marked `extras.flatchatLod` 0, 1, 2; three.js
// puts extras in userData) become THREE.LOD objects that switch by the camera's distance.
import { inspectScene, readGltf } from '@flatchat/content';
import * as THREE from 'three/webgpu';
// trap-lint: allow T11 because it parses only built worlds' GLBs, named by their hash and checked by packages/content first
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// trap-lint: allow T11 because it decodes only the converter's KTX2 textures inside those checked GLBs
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import transcoderJs from 'three/examples/jsm/libs/basis/basis_transcoder.js?raw';
import transcoderWasm from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url&inline';
import { withoutEval } from './basis-transcoder';

export class SceneError extends Error {}

/** Refuses a scene that is not a self-contained, valid GLB. */
export function checkGlb(bytes: Uint8Array): void {
  let json;
  try {
    json = readGltf(bytes, 'scene.glb').json;
  } catch (err) {
    throw new SceneError(`not a GLB: ${err instanceof Error ? err.message : String(err)}`);
  }
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((x) => (x as { uri?: unknown }).uri !== undefined);
  if (external) throw new SceneError('a built scene keeps every buffer and image inside its GLB');
  const { problems } = inspectScene(json, 'scene.glb');
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length > 0) throw new SceneError(errors.map((p) => p.message).join('; '));
}

let ktx2: KTX2Loader | undefined;

/** A glTF loader with the converter's decoders (meshopt geometry, KTX2 textures), the KTX2
 *  transcoder shared by every loader: worlds' scenes here, avatars' levels in avatar-loader.ts. */
export function loader(renderer: THREE.WebGPURenderer): GLTFLoader {
  if (!ktx2) {
    const manager = new THREE.LoadingManager();
    // The transcoder with its two embind helpers rewritten: the worker may not evaluate text (basis-transcoder.ts).
    const js = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(withoutEval(transcoderJs))))}`;
    manager.setURLModifier((url) => (url.endsWith('basis_transcoder.js') ? js : url.endsWith('basis_transcoder.wasm') ? transcoderWasm : url));
    ktx2 = new KTX2Loader(manager).setTranscoderPath('basis/');
    ktx2.detectSupport(renderer as never);
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
}

/** Where a mesh switches to its simpler levels: multiples of its radius, never closer than 12 m
 *  and 30 m. */
export function lodDistances(radius: number): [number, number] {
  return [Math.max(12, radius * 8), Math.max(30, radius * 20)];
}

const lodLevel = (o: THREE.Object3D): number | undefined => {
  const v = o.userData['flatchatLod'];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 8 ? v : undefined;
};

/** Gathers each set of marked sibling levels into a THREE.LOD centred on the full level, keeping
 *  every level where it was. Returns how many it made. */
export function levelsOfDetail(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const parents = new Set<THREE.Object3D>();
  root.traverse((o) => {
    if (lodLevel(o) !== undefined && o.parent) parents.add(o.parent);
  });
  let made = 0;
  for (const parent of parents) {
    const levels = parent.children.filter((c) => lodLevel(c) !== undefined).sort((a, b) => lodLevel(a)! - lodLevel(b)!);
    if (levels.length < 2 || lodLevel(levels[0]!) !== 0) continue;
    const box = new THREE.Box3().setFromObject(levels[0]!);
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const centre = parent.worldToLocal(box.getCenter(new THREE.Vector3()));
    const lod = new THREE.LOD();
    lod.name = `${parent.name}.levels`;
    lod.position.copy(centre);
    const [near, far] = lodDistances(radius);
    for (const [k, level] of levels.entries()) {
      level.position.sub(centre);
      lod.addLevel(level, k === 0 ? 0 : k === 1 ? near : far * (k - 1), 0.1);
    }
    parent.add(lod);
    made += 1;
  }
  root.updateMatrixWorld(true);
  return made;
}

/** A scene's objects, ready to add; static, so their matrices are computed once. */
export async function loadScene(renderer: THREE.WebGPURenderer, bytes: Uint8Array): Promise<THREE.Group> {
  checkGlb(bytes);
  const gltf = await loader(renderer).parseAsync(bytes.slice().buffer, '');
  const group = gltf.scene as unknown as THREE.Group;
  levelsOfDetail(group);
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
  return group;
}
