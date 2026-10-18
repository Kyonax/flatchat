// SPDX-License-Identifier: MPL-2.0
// Turning an avatar level (S4.05, DR-11) into three.js objects. The bytes are the converter's VRM
// 1.0 output from the core's store, fetched by hash and checked against it in the main process;
// before three-vrm parses them, packages/content checks them again (one GLB, everything inside,
// only the converter's extensions, the hard limits). MToon becomes node materials on the WebGPU
// renderer; each avatar gets one skeleton, shared texture objects and no outline pass, as spike
// S0.09 measured a crowd needs.
import { checkAnimationFile, checkAvatarLevel, checkItemFit, checkItemProp, readGltf } from '@flatchat/content';
import { MToonMaterialLoaderPlugin, type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { type VRMAnimation, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import type * as THREE from 'three/webgpu';
import { shareTextures } from '../crowd/avatar';
import { loader } from './scene-loader';

export class AvatarLoadError extends Error {}

export interface ParsedLevel {
  vrm: VRM;
  /** The hips' height at rest, metres (for the bob and for sitting). */
  hipsHeight: number;
}

/** Parses one level. Throws AvatarLoadError when the bytes are not a level the converter wrote. */
export async function parseLevel(renderer: THREE.WebGPURenderer, bytes: ArrayBuffer): Promise<ParsedLevel> {
  try {
    checkAvatarLevel(readGltf(new Uint8Array(bytes), 'level.glb').json as Record<string, unknown>);
  } catch (err) {
    throw new AvatarLoadError(`not an avatar level: ${err instanceof Error ? err.message : String(err)}`);
  }
  const l = loader(renderer);
  l.register((parser) => new VRMLoaderPlugin(parser, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }) }));
  const gltf = await l.parseAsync(bytes, '');
  const vrm = gltf.userData['vrm'] as VRM | undefined;
  if (!vrm) throw new AvatarLoadError('the level has no VRM data');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  shareTextures(vrm.scene);
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Skinned meshes move past their bounds; the avatar's holder is culled as a whole instead.
    mesh.frustumCulled = false;
    if (!Array.isArray(mesh.material)) return;
    // three-vrm draws MToon's outline as a second material over the same triangles.
    const surface = mesh.material.find((m) => !(m as { isOutline?: boolean }).isOutline);
    for (const m of mesh.material) if (m !== surface) m.dispose();
    if (surface) mesh.material = surface;
  });
  vrm.scene.updateMatrixWorld(true);
  const hips = vrm.humanoid.getRawBoneNode('hips');
  const hipsHeight = hips ? hips.getWorldPosition(hips.position.clone()).y : 0.9;
  return { vrm, hipsHeight };
}

/** Frees what a level holds on the GPU. */
export function disposeLevel(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene);
}

/** Parses an item's file (S5.05): a fit (one skinned mesh on the kits' bones) or a prop (rigid
 *  meshes), checked first with the client's own checks, its MToon materials as node materials. */
export async function parseItemFile(renderer: THREE.WebGPURenderer, bytes: ArrayBuffer, kind: 'fit' | 'prop'): Promise<THREE.Object3D> {
  try {
    const json = readGltf(new Uint8Array(bytes), `${kind}.glb`).json as Record<string, unknown>;
    if (kind === 'fit') checkItemFit(json);
    else checkItemProp(json);
  } catch (err) {
    throw new AvatarLoadError(`not an item's ${kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const l = loader(renderer);
  l.register((parser) => new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }));
  const gltf = await l.parseAsync(bytes, '');
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.frustumCulled = false;
  });
  return gltf.scene;
}

/** Parses an emote's or a dance's VRMA (S5.07), checked first with the client's own check. */
export async function parseAnimation(renderer: THREE.WebGPURenderer, bytes: ArrayBuffer): Promise<VRMAnimation> {
  try {
    checkAnimationFile(readGltf(new Uint8Array(bytes), 'animation.glb').json as Record<string, unknown>);
  } catch (err) {
    throw new AvatarLoadError(`not an animation: ${err instanceof Error ? err.message : String(err)}`);
  }
  const l = loader(renderer);
  l.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await l.parseAsync(bytes, '');
  const animation = (gltf.userData['vrmAnimations'] as VRMAnimation[] | undefined)?.[0];
  if (!animation) throw new AvatarLoadError('the file has no VRM animation');
  return animation;
}
