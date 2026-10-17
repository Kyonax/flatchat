// SPDX-License-Identifier: MPL-2.0
// Turning a built world's scene GLB into three.js objects (S2.04). The bytes came from a world
// server, so before three.js parses them they are checked with packages/content: glTF 2.0, every
// buffer and image inside the GLB (no URI of any kind), the limits. Geometry is meshopt-compressed
// and textures are KTX2 (the converter's output): the decoders come with the bundle, the Basis
// transcoder handed to KTX2Loader as data URLs because a packaged client's page cannot fetch
// files (its worker starts from a blob URL: the page's policy allows workers from blob: only).
import { inspectScene, readGltf } from '@flatchat/content';
import * as THREE from 'three/webgpu';
// trap-lint: allow T11 because it parses only built worlds' GLBs, named by their hash and checked by packages/content first
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// trap-lint: allow T11 because it decodes only the converter's KTX2 textures inside those checked GLBs
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import transcoderJs from 'three/examples/jsm/libs/basis/basis_transcoder.js?raw';
import transcoderWasm from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url&inline';

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

function loader(renderer: THREE.WebGPURenderer): GLTFLoader {
  if (!ktx2) {
    const manager = new THREE.LoadingManager();
    const js = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(transcoderJs)))}`;
    manager.setURLModifier((url) => (url.endsWith('basis_transcoder.js') ? js : url.endsWith('basis_transcoder.wasm') ? transcoderWasm : url));
    ktx2 = new KTX2Loader(manager).setTranscoderPath('basis/');
    ktx2.detectSupport(renderer as never);
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
}

/** A scene's objects, ready to add; static, so their matrices are computed once. */
export async function loadScene(renderer: THREE.WebGPURenderer, bytes: Uint8Array): Promise<THREE.Group> {
  checkGlb(bytes);
  const gltf = await loader(renderer).parseAsync(bytes.slice().buffer, '');
  const group = gltf.scene as unknown as THREE.Group;
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
  return group;
}
