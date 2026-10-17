// SPDX-License-Identifier: MPL-2.0
// The greybox world's look (S1.09): one merged mesh per surface (six draw calls for the whole
// plaza, whatever the number of boxes), soft light from the sky and the sun, and fog that hides the
// far wall. Built from the same boxes the controller collides with (packages/sim), and only from
// scene-graph objects, so it builds in plain Node for the tests.
import { type Surface, type WorldMap } from '@flatchat/sim';
import * as THREE from 'three/webgpu';

export const SURFACE_COLOURS: Record<Surface, number> = {
  ground: 0x4b5a3c,
  paving: 0x9a958c,
  stone: 0x7d7a74,
  wood: 0x8a6542,
  accent: 0xf9cd26,
  wall: 0x5c5a57,
};

export interface WorldScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Draw calls the static world costs. */
  meshes: number;
}

/** One box as 24 vertices (four per face, so each face keeps its own normal) and 36 indices. */
function pushBox(min: THREE.Vector3, max: THREE.Vector3, positions: number[], normals: number[], indices: number[]): void {
  const faces: Array<{ n: [number, number, number]; v: Array<[number, number, number]> }> = [
    { n: [1, 0, 0], v: [[max.x, min.y, max.z], [max.x, min.y, min.z], [max.x, max.y, min.z], [max.x, max.y, max.z]] },
    { n: [-1, 0, 0], v: [[min.x, min.y, min.z], [min.x, min.y, max.z], [min.x, max.y, max.z], [min.x, max.y, min.z]] },
    { n: [0, 1, 0], v: [[min.x, max.y, max.z], [max.x, max.y, max.z], [max.x, max.y, min.z], [min.x, max.y, min.z]] },
    { n: [0, -1, 0], v: [[min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, min.y, max.z], [min.x, min.y, max.z]] },
    { n: [0, 0, 1], v: [[min.x, min.y, max.z], [max.x, min.y, max.z], [max.x, max.y, max.z], [min.x, max.y, max.z]] },
    { n: [0, 0, -1], v: [[max.x, min.y, min.z], [min.x, min.y, min.z], [min.x, max.y, min.z], [max.x, max.y, min.z]] },
  ];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const v of f.v) {
      positions.push(...v);
      normals.push(...f.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

export function buildWorldScene(map: WorldMap, aspect = 16 / 9): WorldScene {
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x9fb8d0);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 40, map.size * 0.9);
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3a3f33, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.8);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);

  const bySurface = new Map<Surface, { positions: number[]; normals: number[]; indices: number[] }>();
  for (const solid of map.solids) {
    let g = bySurface.get(solid.surface);
    if (!g) {
      g = { positions: [], normals: [], indices: [] };
      bySurface.set(solid.surface, g);
    }
    pushBox(new THREE.Vector3(solid.min.x, solid.min.y, solid.min.z), new THREE.Vector3(solid.max.x, solid.max.y, solid.max.z), g.positions, g.normals, g.indices);
  }
  for (const [surface, g] of bySurface) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
    geometry.setIndex(g.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: SURFACE_COLOURS[surface] }));
    mesh.name = `surface:${surface}`;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }
  const camera = new THREE.PerspectiveCamera(70, aspect, 0.1, map.size * 1.5);
  return { scene, camera, meshes: bySurface.size };
}
