// SPDX-License-Identifier: MPL-2.0
// Emotes and dances on avatars (S5.07), without a window: the converter's VRMA of the sample motion
// (the right arm rising 80° above level at one second, the hips bobbing 2 cm) plays through
// three-vrm-animation on the feminine body's own converted level, as the client plays it, and
// moves that body's raw bones as the motion says.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAnimation, sampleBvh } from '@flatchat/converter';
import { avatarIO, convertAvatar } from '@flatchat/converter/avatar';
import { type VRM, VRMLoaderPlugin } from '@pixiv/three-vrm';
import { createVRMAnimationClip, type VRMAnimation, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
// trap-lint: allow T11 because the test reads the converter's own output to measure it, never a creator's file
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A GLB as three.js parses it in Node: textures left out (there is no image decoder here). */
async function parse(bytes: Uint8Array, plugin: (parser: never) => unknown): Promise<THREE.Object3D & { userData: Record<string, unknown> }> {
  const io = avatarIO();
  const doc = await io.readBinary(bytes);
  for (const t of doc.getRoot().listTextures()) t.dispose();
  const plain = await io.writeBinary(doc);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register(plugin as never);
  const gltf = await loader.parseAsync(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer, '');
  return Object.assign(gltf.scene, { userData: gltf.userData });
}

let vrm: VRM;
let animation: VRMAnimation;
beforeAll(async () => {
  const avatar = await convertAvatar(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', 'feminine', 'feminine.vrm'))), { ktx2: false });
  vrm = (await parse(avatar.files.get(avatar.manifest.levels.lod0.file)!, (p) => new VRMLoaderPlugin(p))).userData['vrm'] as VRM;
  const dance = await convertAnimation(new TextEncoder().encode(sampleBvh()), { use: 'dance' });
  const vrma = dance.files.get(dance.manifest.file)!;
  // A VRMA is read as it is: it has no textures to leave out.
  const loader = new GLTFLoader();
  loader.register((p) => new VRMAnimationLoaderPlugin(p));
  const gltf = await loader.parseAsync(vrma.buffer.slice(vrma.byteOffset, vrma.byteOffset + vrma.byteLength) as ArrayBuffer, '');
  animation = (gltf.userData['vrmAnimations'] as VRMAnimation[])[0]!;
}, 120_000);

const elevation = (from: string, to: string): number => {
  vrm.scene.updateMatrixWorld(true);
  const a = vrm.humanoid.getRawBoneNode(from as Parameters<VRM['humanoid']['getRawBoneNode']>[0])!.getWorldPosition(new THREE.Vector3());
  const b = vrm.humanoid.getRawBoneNode(to as Parameters<VRM['humanoid']['getRawBoneNode']>[0])!.getWorldPosition(new THREE.Vector3());
  const d = b.sub(a).normalize();
  return (Math.asin(d.y) * 180) / Math.PI;
};

describe('a converted dance on a converted body', () => {
  it('raises the arm as the motion says and bobs the hips', () => {
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(createVRMAnimationClip(animation, vrm)).play();
    const at = (t: number): void => {
      mixer.setTime(t);
      vrm.update(0);
    };
    at(0);
    expect(Math.abs(elevation('rightUpperArm', 'rightLowerArm'))).toBeLessThan(3);
    const hips0 = vrm.humanoid.getRawBoneNode('hips')!.getWorldPosition(new THREE.Vector3()).y;
    at(1);
    expect(elevation('rightUpperArm', 'rightLowerArm')).toBeGreaterThan(77);
    expect(elevation('rightUpperArm', 'rightLowerArm')).toBeLessThan(83);
    // The left arm stays level; the hips bob up at half a second (2 cm, scaled to this body).
    expect(Math.abs(elevation('leftUpperArm', 'leftLowerArm'))).toBeLessThan(3);
    at(0.5);
    const lift = vrm.humanoid.getRawBoneNode('hips')!.getWorldPosition(new THREE.Vector3()).y - hips0;
    expect(lift).toBeGreaterThan(0.01);
    expect(lift).toBeLessThan(0.03);
  });
});
