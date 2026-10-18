// SPDX-License-Identifier: MPL-2.0
// Quaternions and vectors for the animation converter (S5.07): glTF's conventions, [x, y, z, w]
// with w last, rotations applied to column vectors, a product a·b meaning b first, then a.

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export const IDENTITY: Quat = [0, 0, 0, 1];

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** The inverse of a unit quaternion. */
export function qinv(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** The same rotation with w ≥ 0 (glTF readers do not care; comparisons and golden files do). */
export function qcanon(q: Quat): Quat {
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (d > 0.9995) return qnorm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** The angle between two orientations, in radians (atan2 of the relative turn: steady for small
 *  angles, where an arccosine of a dot product near 1 magnifies rounding). */
export function qangle(a: Quat, b: Quat): number {
  const r = qmul(qinv(qnorm(a)), qnorm(b));
  return 2 * Math.atan2(Math.hypot(r[0], r[1], r[2]), Math.abs(r[3]));
}

export function qaxis(axis: Vec3, angle: number): Quat {
  const l = Math.hypot(...axis) || 1;
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Euler angles in degrees, applied as their channels are listed (BVH's rule: the first listed
 *  is the outermost, so a vector turns by the last one first). */
export function qeuler(order: string, degrees: readonly number[]): Quat {
  let q: Quat = IDENTITY;
  for (let i = 0; i < order.length; i++) {
    const axis: Vec3 = order[i] === 'X' ? [1, 0, 0] : order[i] === 'Y' ? [0, 1, 0] : [0, 0, 1];
    q = qmul(q, qaxis(axis, ((degrees[i] ?? 0) * Math.PI) / 180));
  }
  return q;
}

export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** The smallest rotation taking direction u onto direction v. */
export function qfromTo(u: Vec3, v: Vec3): Quat {
  const a = vnorm(u);
  const b = vnorm(v);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // Opposite: any axis at right angles.
    const axis: Vec3 = Math.abs(a[0]) < 0.9 ? vnorm(vcross(a, [1, 0, 0])) : vnorm(vcross(a, [0, 1, 0]));
    return qaxis(axis, Math.PI);
  }
  const c = vcross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vscale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function vlen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** The angle between two directions, in radians. */
export function vangle(a: Vec3, b: Vec3): number {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((vlen(a) || 1) * (vlen(b) || 1));
  return Math.acos(Math.max(-1, Math.min(1, d)));
}
