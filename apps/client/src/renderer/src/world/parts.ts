// SPDX-License-Identifier: MPL-2.0
// The base library on screen (S2.05, Q-L6): every part a world places, drawn from the client's own
// definitions (packages/content's BASE_PARTS) with nothing downloaded but where they stand. One
// instanced mesh per kind of part, its boxes merged into one geometry coloured with the library's
// palette, so a park of hundreds of parts costs a draw call per kind.
import { BASE_PARTS, type BuiltPart, PART_COLOURS } from '@flatchat/content';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const geometries = new Map<string, THREE.BufferGeometry>();

/** One part's boxes as one geometry, each box in its colour (vertex colours). */
export function partGeometry(id: string): THREE.BufferGeometry {
  const known = geometries.get(id);
  if (known) return known;
  const colour = new THREE.Color();
  const boxes = BASE_PARTS[id]!.boxes.map((b) => {
    const g = new THREE.BoxGeometry(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    g.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    colour.setHex(PART_COLOURS[b.colour]);
    const count = g.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colours.set([colour.r, colour.g, colour.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return g;
  });
  const merged = mergeGeometries(boxes) ?? new THREE.BufferGeometry();
  for (const g of boxes) g.dispose();
  geometries.set(id, merged);
  return merged;
}

/** Every placed part, grouped by kind into instanced meshes. */
export function buildParts(parts: readonly BuiltPart[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'base-parts';
  const byId = new Map<string, BuiltPart[]>();
  for (const p of parts) {
    if (!Object.hasOwn(BASE_PARTS, p.id)) continue;
    let list = byId.get(p.id);
    if (!list) byId.set(p.id, (list = []));
    list.push(p);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const m = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const size = new THREE.Vector3();
  for (const [id, list] of byId) {
    const mesh = new THREE.InstancedMesh(partGeometry(id), material, list.length);
    mesh.name = id;
    list.forEach((p, k) => {
      m.compose(at.set(...p.position), turn.set(...p.rotation), size.set(...p.scale));
      mesh.setMatrixAt(k, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
