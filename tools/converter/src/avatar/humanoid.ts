// SPDX-License-Identifier: MPL-2.0
// The skeleton every avatar is mapped onto: VRM 1.0's humanoid, fingers included (S4.02). A VRM
// names its bones; a plain GLB's bones are recognised by their names (Mixamo's, Ready Player Me's,
// Unity's and Blender's usual ones). Every avatar ends facing +Z with its left hand at +X, as VRM
// 1.0 wants: VRM 0.x avatars (which face -Z) and GLBs found facing the other way are turned round
// by conjugating every transform with a half turn about Y, so bones that had no rotation still
// have none.
import { type Document, type Node, PropertyType } from '@gltf-transform/core';
import type { Json, JsonObject, VRMData, VRMDocument } from './vrm.ts';

/** VRM 1.0's human bones, each with its parent in the humanoid (the nearest existing one counts). */
export const HUMAN_BONES: ReadonlyArray<readonly [string, string | null]> = [
  ['hips', null],
  ['spine', 'hips'],
  ['chest', 'spine'],
  ['upperChest', 'chest'],
  ['neck', 'upperChest'],
  ['head', 'neck'],
  ['leftEye', 'head'],
  ['rightEye', 'head'],
  ['jaw', 'head'],
  ['leftUpperLeg', 'hips'],
  ['leftLowerLeg', 'leftUpperLeg'],
  ['leftFoot', 'leftLowerLeg'],
  ['leftToes', 'leftFoot'],
  ['rightUpperLeg', 'hips'],
  ['rightLowerLeg', 'rightUpperLeg'],
  ['rightFoot', 'rightLowerLeg'],
  ['rightToes', 'rightFoot'],
  ['leftShoulder', 'upperChest'],
  ['leftUpperArm', 'leftShoulder'],
  ['leftLowerArm', 'leftUpperArm'],
  ['leftHand', 'leftLowerArm'],
  ['rightShoulder', 'upperChest'],
  ['rightUpperArm', 'rightShoulder'],
  ['rightLowerArm', 'rightUpperArm'],
  ['rightHand', 'rightLowerArm'],
  ...(['left', 'right'] as const).flatMap((side) =>
    (['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const).flatMap((finger) => {
      const parts = finger === 'Thumb' ? (['Metacarpal', 'Proximal', 'Distal'] as const) : (['Proximal', 'Intermediate', 'Distal'] as const);
      return parts.map((part, i) => [`${side}${finger}${part}`, i === 0 ? `${side}Hand` : `${side}${finger}${parts[i - 1]}`] as const);
    }),
  ),
];
export const HUMAN_BONE_NAMES: ReadonlySet<string> = new Set(HUMAN_BONES.map(([n]) => n));
/** The bones VRM 1.0 requires. */
export const REQUIRED_BONES = [
  'hips',
  'spine',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const;
/** The bones the impostor keeps (about 20, S4.03): the body without fingers, eyes and jaw. */
export const IMPOSTOR_BONES: ReadonlySet<string> = new Set([
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
]);

// ------------------------------------------------------------------------- plain GLB rigs

/** A bone name, simplified: no rig prefix (mixamorig:, Armature|, DEF-, J_Bip_C_…), no
 *  separators, lower case. */
function simplify(name: string): string {
  return name
    .replace(/^.*[:|]/, '')
    .replace(/^(mixamorig\d*|def|org|bip0?1|bip|cc_base|j_bip_[clr]|j_)[_.\-\s]*/i, '')
    .replace(/[_.\-\s]/g, '')
    .toLowerCase();
}

const SIDES: ReadonlyArray<readonly [RegExp, 'left' | 'right']> = [
  [/^(left|l)(?=[a-z])/, 'left'],
  [/^(right|r)(?=[a-z])/, 'right'],
  [/(left|l)$/, 'left'],
  [/(right|r)$/, 'right'],
];

/** Each human bone's usual names in other rigs, simplified, side removed. */
const ALIASES: Record<string, readonly string[]> = {
  hips: ['hips', 'hip', 'pelvis'],
  neck: ['neck', 'neck1', 'neck01'],
  head: ['head'],
  eye: ['eye'],
  jaw: ['jaw'],
  shoulder: ['shoulder', 'clavicle', 'collar'],
  upperArm: ['upperarm', 'arm', 'uparm', 'armupper'],
  lowerArm: ['lowerarm', 'forearm', 'elbow', 'armlower'],
  hand: ['hand', 'wrist'],
  upperLeg: ['upperleg', 'upleg', 'thigh', 'legupper'],
  lowerLeg: ['lowerleg', 'leg', 'knee', 'shin', 'calf', 'leglower'],
  foot: ['foot', 'ankle'],
  toes: ['toes', 'toe', 'toebase', 'ball'],
};
const FINGERS: Record<string, readonly string[]> = {
  Thumb: ['thumb', 'fthumb'],
  Index: ['index', 'indexfinger', 'pointer', 'findex'],
  Middle: ['middle', 'middlefinger', 'fmiddle'],
  Ring: ['ring', 'ringfinger', 'fring'],
  Little: ['little', 'pinky', 'pinkie', 'littlefinger', 'fpinky'],
};
/** The spine's links: rigs number them (Spine, Spine1, Spine2; spine_01 to spine_03), so they are
 *  mapped by their depth below the hips instead. */
const SPINE_LINK = /^(spine\d*|chest|upperchest|chestupper|torso|waist)$/;

export type BoneMatch = string | { side: 'left' | 'right'; finger: string; joint: number } | 'spine-link';

/** The human bone a node's name stands for in a plain GLB rig, if it is one. A side may come first
 *  or last, and a name can start with an l or an r that is no side (Unreal's lowerarm_r, ring_01_l):
 *  each reading is tried, and the one that names a bone wins. */
export function humanBoneOf(name: string): BoneMatch | undefined {
  const n = simplify(name);
  for (const [re, side] of SIDES) {
    if (!re.test(n)) continue;
    const rest = n.replace(re, '');
    if (rest.length < 3) continue;
    const bone = sidedBone(rest, side);
    if (bone !== undefined) return bone;
  }
  if (SPINE_LINK.test(n)) return 'spine-link';
  for (const bone of ['hips', 'neck', 'head'] as const) if (ALIASES[bone]!.includes(n)) return bone;
  return undefined;
}

/** A bone of one side, by its name with the side taken off. */
function sidedBone(n: string, side: 'left' | 'right'): BoneMatch | undefined {
  for (const bone of ['eye', 'shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes'] as const) {
    if (ALIASES[bone]!.includes(n)) return `${side}${bone[0]!.toUpperCase()}${bone.slice(1)}`;
  }
  // Fingers: a name and a joint number (1–3, or 0–2 on some rigs, or 01–03).
  const m = /^(?:hand)?([a-z]+?)(?:finger)?(0?[0-3])$/.exec(n);
  if (m) {
    const finger = Object.entries(FINGERS).find(([, names]) => names.includes(m[1]!))?.[0];
    if (finger) return { side, finger, joint: Number(m[2]) };
  }
  return undefined;
}

/** Maps a plain GLB's nodes onto the humanoid by their names; fingers numbered from the root. */
export function mapByNames(doc: Document): Map<string, Node> {
  const found = new Map<string, Node>();
  const fingers = new Map<string, Array<{ joint: number; node: Node }>>();
  const spine: Node[] = [];
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh() || node.getCamera()) continue;
    const r = humanBoneOf(node.getName());
    if (r === undefined) continue;
    if (r === 'spine-link') spine.push(node);
    else if (typeof r === 'string') {
      if (!found.has(r)) found.set(r, node);
    } else {
      const key = `${r.side}${r.finger}`;
      fingers.set(key, [...(fingers.get(key) ?? []), { joint: r.joint, node }]);
    }
  }
  for (const [key, joints] of fingers) {
    const parts = key.includes('Thumb') ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.sort((a, b) => a.joint - b.joint);
    // A rig with a fourth (tip) joint keeps the first three; one numbered from 0 maps the same way.
    joints.slice(0, 3).forEach((j, i) => found.set(`${key}${parts[i]}`, j.node));
  }
  // The spine's links below the hips, nearest first: spine, chest, upper chest.
  const depth = (n: Node): number => {
    let d = 0;
    for (let p = n.getParentNode(); p; p = p.getParentNode()) d += 1;
    return d;
  };
  const hips = found.get('hips');
  const below = (n: Node): boolean => {
    for (let p = n.getParentNode(); p; p = p.getParentNode()) if (p === hips) return true;
    return false;
  };
  const links = spine.filter((n) => !hips || below(n)).sort((a, b) => depth(a) - depth(b));
  (['spine', 'chest', 'upperChest'] as const).forEach((bone, i) => {
    if (links[i]) found.set(bone, links[i]!);
  });
  return found;
}

// ------------------------------------------------------------------------- facing and axes

function worldMatrixOf(node: Node): number[] {
  return node.getWorldMatrix() as unknown as number[];
}

/** Which way the avatar faces, from its hands: +Z when its left hand is on the +X side. */
export function facesPlusZ(bones: Map<string, Node>): boolean {
  const left = bones.get('leftHand') ?? bones.get('leftUpperArm');
  const right = bones.get('rightHand') ?? bones.get('rightUpperArm');
  if (!left || !right) return true;
  return worldMatrixOf(left)[12]! >= worldMatrixOf(right)[12]!;
}

const flipV3 = (v: number[]): number[] => [-v[0]!, v[1]!, -v[2]!];

/** Turns the whole document round half a turn about Y: every node's transform, every inverse
 *  bind matrix, every vertex (positions, normals, tangents, morph targets). */
export function turnAround(doc: Document): void {
  const root = doc.getRoot();
  for (const node of root.listNodes()) {
    node.setTranslation(flipV3(node.getTranslation()) as [number, number, number]);
    const [x, y, z, w] = node.getRotation();
    node.setRotation([-x, y, -z, w]);
  }
  const R = [-1, 1, -1, 1];
  const done = new Set<unknown>();
  for (const skin of root.listSkins()) {
    const ibm = skin.getInverseBindMatrices();
    if (!ibm || done.has(ibm)) continue;
    done.add(ibm);
    const m: number[] = [];
    for (let i = 0; i < ibm.getCount(); i++) {
      ibm.getElement(i, m);
      // IBM' = R·IBM·R⁻¹ with R = diag(-1, 1, -1, 1): element (row r, column c) times R[r]·R[c].
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = m[c * 4 + r]! * R[r]! * R[c]!;
      ibm.setElement(i, m);
    }
  }
  const v: number[] = [];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const accessors = [prim.getAttribute('POSITION'), prim.getAttribute('NORMAL'), prim.getAttribute('TANGENT')];
      for (const t of prim.listTargets()) accessors.push(t.getAttribute('POSITION'), t.getAttribute('NORMAL'), t.getAttribute('TANGENT'));
      for (const a of accessors) {
        if (!a || done.has(a)) continue;
        done.add(a);
        for (let i = 0; i < a.getCount(); i++) {
          a.getElement(i, v);
          v[0] = -v[0]!;
          v[2] = -v[2]!;
          a.setElement(i, v);
        }
      }
    }
  }
}

/** The vectors inside the VRM data that live in a node's or the model's space, turned round too:
 *  collider offsets and tails, gravity directions, the look-at offset. */
export function turnVrmAround(data: VRMData): void {
  const doc: VRMDocument = data.getDocument();
  const flip = (v: Json | undefined): Json | undefined => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? flipV3(v as number[]) : v);
  const lookAt = doc.vrm['lookAt'] as JsonObject | undefined;
  if (lookAt?.['offsetFromHeadBone']) lookAt['offsetFromHeadBone'] = flip(lookAt['offsetFromHeadBone'])!;
  for (const c of (doc.springBone?.['colliders'] ?? []) as JsonObject[]) {
    const shape = c['shape'] as JsonObject | undefined;
    for (const kind of ['sphere', 'capsule'] as const) {
      const s = shape?.[kind] as JsonObject | undefined;
      if (!s) continue;
      if (s['offset']) s['offset'] = flip(s['offset'])!;
      if (s['tail']) s['tail'] = flip(s['tail'])!;
    }
  }
  for (const spring of (doc.springBone?.['springs'] ?? []) as JsonObject[]) {
    for (const j of (spring['joints'] ?? []) as JsonObject[]) if (j['gravityDir']) j['gravityDir'] = flip(j['gravityDir'])!;
  }
  data.setDocument(doc);
}

// ------------------------------------------------------------------------- free shapes (S4.11)

/** Where each missing required bone goes, from its parent, as shares of the model's height. */
const STAND_INS: Record<string, { parent: string[]; at: [number, number, number] }> = {
  spine: { parent: ['hips'], at: [0, 0.08, 0] },
  head: { parent: ['neck', 'upperChest', 'chest', 'spine'], at: [0, 0.3, 0] },
  leftUpperArm: { parent: ['leftShoulder', 'upperChest', 'chest', 'spine'], at: [0.12, 0.2, 0] },
  leftLowerArm: { parent: ['leftUpperArm'], at: [0.14, 0, 0] },
  leftHand: { parent: ['leftLowerArm'], at: [0.13, 0, 0] },
  rightUpperArm: { parent: ['rightShoulder', 'upperChest', 'chest', 'spine'], at: [-0.12, 0.2, 0] },
  rightLowerArm: { parent: ['rightUpperArm'], at: [-0.14, 0, 0] },
  rightHand: { parent: ['rightLowerArm'], at: [-0.13, 0, 0] },
  leftUpperLeg: { parent: ['hips'], at: [0.06, -0.03, 0] },
  leftLowerLeg: { parent: ['leftUpperLeg'], at: [0, -0.23, 0] },
  leftFoot: { parent: ['leftLowerLeg'], at: [0, -0.23, 0] },
  rightUpperLeg: { parent: ['hips'], at: [-0.06, -0.03, 0] },
  rightLowerLeg: { parent: ['rightUpperLeg'], at: [0, -0.23, 0] },
  rightFoot: { parent: ['rightLowerLeg'], at: [0, -0.23, 0] },
};

/** The model's box at rest, in world space (skinned meshes in their bind space). */
export function restBox(doc: Document): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const v: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getSkin() ? null : worldMatrixOf(node);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const p = m ? [m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!, m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!, m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!] : [v[0]!, v[1]!, v[2]!];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, p[k]!);
          max[k] = Math.max(max[k]!, p[k]!);
        }
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : undefined;
}

/** A free shape (S4.11): a robot, a creature or a prop on the shared skeleton. Without hips, a
 *  hips node is made at the model's middle and the whole model hangs from it (so it walks, turns
 *  and bobs as one); every other missing required bone becomes an empty node where a body would
 *  have it, so three-vrm finds a complete humanoid and the shared motions move what the model has.
 *  Answers the bones it made. */
export function completeFreeShape(doc: Document, data: VRMData, missing: readonly string[]): string[] {
  const box = restBox(doc);
  if (!box) throw new Error('the model has no mesh to show');
  const height = Math.max(0.3, box.max[1] - box.min[1]);
  const vdoc = data.getDocument();
  const humanoid = (vdoc.vrm['humanoid'] ??= { humanBones: {} }) as JsonObject;
  const humanBones = (humanoid['humanBones'] ??= {}) as JsonObject;
  const made: string[] = [];
  const nodeOf = (name: string): Node | undefined => {
    const slot = ((humanBones[name] as JsonObject | undefined)?.['node'] as { $node?: number } | undefined)?.$node;
    return slot === undefined ? undefined : data.node(slot);
  };
  const scene = doc.getRoot().listScenes()[0] ?? doc.createScene('Scene');
  if (missing.includes('hips')) {
    const at: [number, number, number] = [(box.min[0] + box.max[0]) / 2, box.min[1] + height * 0.5, (box.min[2] + box.max[2]) / 2];
    const hips = doc.createNode('FreeShapeHips').setTranslation(at);
    // Everything the scene held hangs from the hips now, where it was.
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      const t = child.getTranslation();
      child.setTranslation([t[0] - at[0], t[1] - at[1], t[2] - at[2]]);
      hips.addChild(child);
    }
    scene.addChild(hips);
    humanBones['hips'] = { node: { $node: data.addNode(hips) } };
    made.push('hips');
  }
  for (const name of REQUIRED_BONES) {
    if (name === 'hips' || nodeOf(name)) continue;
    const plan = STAND_INS[name]!;
    const parent = plan.parent.map(nodeOf).find((n): n is Node => !!n) ?? nodeOf('hips')!;
    const node = doc.createNode(`FreeShape_${name}`).setTranslation([plan.at[0] * height, plan.at[1] * height, plan.at[2] * height]);
    parent.addChild(node);
    humanBones[name] = { node: { $node: data.addNode(node) } };
    made.push(name);
  }
  data.setDocument(vdoc);
  return made;
}

/** Every node a VRM document references must survive the converter's clean-up. */
export function protectedNodes(data: VRMData | null): Set<Node> {
  return new Set(data ? data.listNodes() : []);
}

export const NODE_TYPE = PropertyType.NODE;
