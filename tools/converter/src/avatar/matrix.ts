// SPDX-License-Identifier: MPL-2.0
// 4×4 matrices as glTF stores them (column-major arrays of 16), for the impostor's skinning.

export type M4 = number[];

export function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}

export function apply(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

export function invert(m: M4): M4 {
  // A rigid transform with scale: invert the 3x3 block, then the translation.
  const [a, b, c, , d, e, f, , g, h, i] = m as [number, number, number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const s = 1 / (det || 1);
  const r = [(e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s, 0, (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s, 0, (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s, 0];
  const [tx, ty, tz] = [m[12]!, m[13]!, m[14]!];
  return [...r, -(r[0]! * tx + r[4]! * ty + r[8]! * tz), -(r[1]! * tx + r[5]! * ty + r[9]! * tz), -(r[2]! * tx + r[6]! * ty + r[10]! * tz), 1];
}

/** The rotation in a transform, its scale taken out, with no translation. */
export function rotationOf(m: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!) || 1;
    for (let r = 0; r < 3; r++) out[c * 4 + r] = m[c * 4 + r]! / len;
  }
  out[15] = 1;
  return out;
}

/** A rotation's inverse: its transpose. */
export function transposed(m: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = m[r * 4 + c]!;
  out[15] = 1;
  return out;
}

/** A turn about the X axis, in radians. */
export function turnX(a: number): M4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/** A turn about the Y axis, in radians. */
export function turnY(a: number): M4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** A turn about the Z axis, in radians. */
export function turnZ(a: number): M4 {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
