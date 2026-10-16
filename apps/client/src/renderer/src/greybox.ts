// SPDX-License-Identifier: MPL-2.0
// The blank world: a greybox floor grid, two lights and a turning block. Only scene-graph objects,
// so it builds in plain Node for the unit tests; the renderer lives in scene.ts.
import * as THREE from 'three/webgpu';

export interface Greybox {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  block: THREE.Mesh;
}

export function buildGreybox(aspect = 16 / 9): Greybox {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);

  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 200);
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 0.5, 0);

  scene.add(new THREE.HemisphereLight(0xdde3ff, 0x202024, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 10, 4);
  scene.add(sun);
  scene.add(new THREE.GridHelper(40, 40, 0x5a5a66, 0x2a2a32));

  const block = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.6 }),
  );
  block.position.y = 0.5;
  scene.add(block);

  return { scene, camera, block };
}

/** One frame of motion: the block turns once every 2π seconds. */
export function animate(box: Greybox, timeMs: number): void {
  box.block.rotation.y = timeMs / 1000;
}
