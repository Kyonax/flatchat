// SPDX-License-Identifier: MPL-2.0
// A limb's skin stretched with its bones (S4.10, P.08): the proportion sliders move the elbows,
// wrists, knees and ankles along their bones, and each arm and leg bone's skin is scaled along the
// bone by the same share, so a forearm at 80 % is a shorter forearm, not one slid into the upper
// arm with the hand sunk into it, which no sleeve over it could follow. The stretch rides a node
// of its own under each limb bone, which every skin on the avatar (its body, its clothes) uses in
// the bone's place: the bone's children never inherit it, so nothing shears when the limb bends.
// The converter's checks pose a body with the same rule (packages/content/src/proportions.ts).
import { PROPORTION_SEGMENTS, type ProportionShares, stretchAlong } from '@flatchat/content';
import * as THREE from 'three/webgpu';

interface Segment {
  /** The node the skins use in the bone's place: under the bone, at its origin. */
  node: THREE.Bone;
  /** The bone's own direction, to the joint it moves, in its frame. */
  axis: [number, number, number];
  kind: keyof typeof PROPORTION_SEGMENTS;
}

/** The avatar's limb bones and their stretch nodes. */
export type Segments = Map<THREE.Object3D, Segment>;

/** Gives each of the avatar's limb bones a stretch node and moves every skin under `root` onto
 *  them (`node` finds a VRM humanoid bone's node). Made while the avatar stands at rest. The nodes
 *  carry their bones' names, after them in the scene, so a search by name finds the bone first. */
export function addSegments(root: THREE.Object3D, node: (humanBone: string) => THREE.Object3D | undefined): Segments {
  root.updateMatrixWorld(true);
  const out: Segments = new Map();
  const at = new THREE.Vector3();
  for (const kind of Object.keys(PROPORTION_SEGMENTS) as Array<keyof typeof PROPORTION_SEGMENTS>) {
    for (const [from, to] of PROPORTION_SEGMENTS[kind]) {
      const bone = node(from);
      const next = node(to);
      if (!bone || !next || out.has(bone)) continue;
      // The next joint in the bone's own frame.
      bone.worldToLocal(next.getWorldPosition(at));
      const len = at.length();
      if (len < 1e-6) continue;
      const stretch = new THREE.Bone();
      stretch.name = bone.name;
      stretch.userData['flatchatSegment'] = true;
      stretch.matrixAutoUpdate = false;
      bone.add(stretch);
      out.set(bone, { node: stretch, axis: [at.x / len, at.y / len, at.z / len], kind });
    }
  }
  useSegments(root, out);
  return out;
}

/** Moves every skin under `root` that uses a limb bone onto its stretch node (clothes put on
 *  later too). Their inverse binds stay right: the node sits at the bone's origin. */
export function useSegments(root: THREE.Object3D, segments: Segments): void {
  if (segments.size === 0) return;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const bones = m.skeleton.bones;
    for (let i = 0; i < bones.length; i++) {
      const s = segments.get(bones[i]!);
      if (s) bones[i] = s.node;
    }
  });
}

/** Stretches each limb's skin by its slider's share (1 as made). */
export function setSegments(segments: Segments, shares: ProportionShares): void {
  for (const s of segments.values()) {
    s.node.matrix.fromArray(stretchAlong(s.axis, shares[s.kind]));
    s.node.matrixWorldNeedsUpdate = true;
  }
}
