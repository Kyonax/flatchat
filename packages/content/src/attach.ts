// SPDX-License-Identifier: Apache-2.0
// Attachment points (S5.04, Q-M18): named places on any avatar where a prop is worn (a hat on the
// head's top, a sword at a hip, a backpack on the back), with the small adjustments a player may make.
// A standard body carries each point as a marker (kits/bodies/, its attach_* nodes); on any other
// avatar, a free shape included, a point is its bone's place at rest plus an offset scaled by the
// avatar's height, carried with the bone as it moves. Pure arithmetic on glTF's column-major 4×4
// matrices, shared by the converter, its tests and the client.

/** Each point: the VRM 1.0 humanoid bone it follows, and its offset from that bone at rest, as a
 *  share of the avatar's height, in the avatar's frame (VRM faces +Z, up is +Y, its left is +X).
 *  The kits' markers (generate.py's MARKERS) are these for a 1.7 m body. */
export const ATTACH_POINTS = {
  head_top: { bone: 'head', offset: [0, 0.1, 0] },
  face: { bone: 'head', offset: [0, 0.035, 0.065] },
  neck: { bone: 'neck', offset: [0, 0.012, 0.03] },
  chest: { bone: 'upperChest', offset: [0, 0.03, 0.07] },
  back: { bone: 'upperChest', offset: [0, 0, -0.082] },
  hips: { bone: 'hips', offset: [0, 0, 0] },
  hip_l: { bone: 'leftUpperLeg', offset: [0.047, -0.005, 0] },
  hip_r: { bone: 'rightUpperLeg', offset: [-0.047, -0.005, 0] },
  hand_l: { bone: 'leftHand', offset: [0, 0, 0] },
  hand_r: { bone: 'rightHand', offset: [0, 0, 0] },
  foot_l: { bone: 'leftFoot', offset: [0, 0, 0] },
  foot_r: { bone: 'rightFoot', offset: [0, 0, 0] },
} as const satisfies Record<string, { bone: string; offset: readonly [number, number, number] }>;
export type AttachPoint = keyof typeof ATTACH_POINTS;

/** Where a point's bone is missing (upperChest and neck are optional in VRM 1.0), the next one up. */
const STAND_INS: Record<string, string[]> = { upperChest: ['chest', 'spine'], neck: ['head'], chest: ['spine'] };

/** The bone a point follows on an avatar that has `has` bones, or none. */
export function attachBone(point: AttachPoint, has: (bone: string) => boolean): string | undefined {
  const bone = ATTACH_POINTS[point].bone;
  return [bone, ...(STAND_INS[bone] ?? [])].find(has);
}

/** A player's adjustment to a point: metres, radians (X, Y, Z, applied in that order) and a size. */
export interface AttachAdjustment {
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}
export const NO_ADJUSTMENT: AttachAdjustment = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
/** How far a player may move, turn and resize a prop from its point. */
export const ADJUST_LIMITS = { offset: 0.1, rotation: Math.PI / 4, scale: [0.8, 1.25] as const };

/** A worn prop's adjustment as the protocol (version 9) and the core carry it: whole centimetres,
 *  whole degrees (X, Y, Z) and a size in percent. */
export interface WornAdjust {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}
/** ADJUST_LIMITS in those units: 10 cm, 45 degrees, 80 to 125 percent. */
export const WORN_LIMITS = {
  offsetCm: Math.round(ADJUST_LIMITS.offset * 100),
  rotationDeg: Math.round((ADJUST_LIMITS.rotation * 180) / Math.PI),
  scalePercent: [Math.round(ADJUST_LIMITS.scale[0] * 100), Math.round(ADJUST_LIMITS.scale[1] * 100)] as const,
};

/** A worn adjustment rounded and clamped to WORN_LIMITS (the world fits every one it is sent). */
export function fitWornAdjust(a: WornAdjust): WornAdjust {
  const c = (v: number, lim: number): number => (Number.isFinite(v) ? Math.min(lim, Math.max(-lim, Math.round(v))) : 0);
  const [lo, hi] = WORN_LIMITS.scalePercent;
  const scale = Number.isFinite(a.scale) ? Math.min(hi, Math.max(lo, Math.round(a.scale))) : 100;
  return { x: c(a.x, WORN_LIMITS.offsetCm), y: c(a.y, WORN_LIMITS.offsetCm), z: c(a.z, WORN_LIMITS.offsetCm), rx: c(a.rx, WORN_LIMITS.rotationDeg), ry: c(a.ry, WORN_LIMITS.rotationDeg), rz: c(a.rz, WORN_LIMITS.rotationDeg), scale };
}

/** A worn adjustment as attachMatrix takes it: metres, radians and a size. */
export function wornAdjustment(a: WornAdjust | undefined): AttachAdjustment {
  if (!a) return NO_ADJUSTMENT;
  const f = fitWornAdjust(a);
  const rad = Math.PI / 180;
  return { offset: [f.x / 100, f.y / 100, f.z / 100], rotation: [f.rx * rad, f.ry * rad, f.rz * rad], scale: f.scale / 100 };
}

/** An adjustment within the limits (anything else from the network is clamped, never trusted). */
export function fitAdjustment(a: Partial<AttachAdjustment> | undefined): AttachAdjustment {
  const clamp = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const o = ADJUST_LIMITS.offset;
  const r = ADJUST_LIMITS.rotation;
  const three = (v: unknown, lim: number): [number, number, number] => {
    const xs = Array.isArray(v) ? v : [];
    return [clamp(xs[0], -lim, lim, 0), clamp(xs[1], -lim, lim, 0), clamp(xs[2], -lim, lim, 0)];
  };
  return { offset: three(a?.offset, o), rotation: three(a?.rotation, r), scale: clamp(a?.scale, ADJUST_LIMITS.scale[0], ADJUST_LIMITS.scale[1], 1) };
}

export type Matrix4 = readonly number[];

function mul(a: Matrix4, b: Matrix4): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}

function invertRigid(m: Matrix4): number[] {
  // A rotation, a uniform scale and a translation.
  const s2 = m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!;
  const r = [m[0]!, m[4]!, m[8]!, 0, m[1]!, m[5]!, m[9]!, 0, m[2]!, m[6]!, m[10]!, 0, 0, 0, 0, 1].map((x, i) => (i % 4 === 3 || i >= 12 ? x : x / s2));
  const t = [m[12]!, m[13]!, m[14]!];
  r[12] = -(r[0]! * t[0]! + r[4]! * t[1]! + r[8]! * t[2]!);
  r[13] = -(r[1]! * t[0]! + r[5]! * t[1]! + r[9]! * t[2]!);
  r[14] = -(r[2]! * t[0]! + r[6]! * t[1]! + r[10]! * t[2]!);
  r[15] = 1;
  return r;
}

function trs(t: readonly number[], euler: readonly number[], s: number): number[] {
  const [x, y, z] = euler as [number, number, number];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  // R = Rz · Ry · Rx (X applied first), column-major.
  const r = [cy * cz, cy * sz, -sy, 0, sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy, 0, cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy, 0];
  return [...r.map((v, i) => (i % 4 === 3 ? v : v * s)), t[0]!, t[1]!, t[2]!, 1];
}

/** A point's place on an avatar, as a world matrix for the prop: its bone's world matrix now, times
 *  where the point sat on that bone at rest (the bone's rest place plus the offset × height, plus
 *  the player's adjustment, turned and sized). With the bone at rest it is just that place. */
export function attachMatrix(point: AttachPoint, boneRest: Matrix4, boneNow: Matrix4, height: number, adjust: AttachAdjustment = NO_ADJUSTMENT): number[] {
  const a = fitAdjustment(adjust);
  const off = ATTACH_POINTS[point].offset;
  const at = [boneRest[12]! + off[0] * height + a.offset[0], boneRest[13]! + off[1] * height + a.offset[1], boneRest[14]! + off[2] * height + a.offset[2]];
  const restPlace = trs(at, a.rotation, a.scale);
  return mul(boneNow, mul(invertRigid(boneRest), restPlace));
}
