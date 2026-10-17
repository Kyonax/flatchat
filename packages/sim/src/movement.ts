// SPDX-License-Identifier: Apache-2.0
// The character controller (S1.08, S1.09): how a player walks, runs, jumps, falls and climbs steps
// among axis-aligned boxes. The client runs it every frame to move its own avatar (sf-004: each
// client moves itself); the world server uses the same constants to check what clients send
// (check.ts). Pure arithmetic: no engine, no clock, no randomness, so both ends agree. The full
// movement set (slopes, seats, flying, click to move) moves to Rapier with the world format (S2.06).
//
// Axes: y is up; a yaw of 0 faces -z, and yaw grows turning left (counter-clockwise from above),
// as three.js cameras do.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A solid axis-aligned box: floors, steps, platforms, walls, pillars. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** The player's body: an upright box this wide and tall (a capsule's stand-in). */
export const BODY = {
  /** Half the width, metres. */
  radius: 0.3,
  height: 1.75,
  /** The camera's height in first person. */
  eye: 1.62,
  /** A ledge up to this high is stepped onto without jumping (stairs). */
  step: 0.45,
} as const;

export const MOVE = {
  /** Metres per second. */
  walk: 3.6,
  run: 7,
  /** Upward speed at take-off: a jump of jumpSpeed² / (2 gravity) = 0.9 m. */
  jumpSpeed: 5.2,
  /** m/s², heavier than Earth's for a snappier jump. */
  gravity: 15,
  /** How fast the ground velocity reaches the input's (m/s²), and the share of it left in the air. */
  accel: 40,
  airControl: 0.3,
  /** The fastest fall, m/s. */
  terminal: 40,
} as const;

/** The highest a jump lifts the feet, metres. */
export const JUMP_APEX = (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * MOVE.gravity);

export interface MoveState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

export interface MoveInput {
  /** -1 to 1: back to forward. */
  forward: number;
  /** -1 to 1: left to right. */
  right: number;
  run: boolean;
  /** Held: a jump starts when grounded. */
  jump: boolean;
  /** Where the player faces, radians. */
  yaw: number;
}

export function standing(x: number, y: number, z: number): MoveState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true };
}

/** The ground velocity an input asks for, in world axes. */
export function wishVelocity(input: MoveInput): { x: number; z: number } {
  const f = Math.max(-1, Math.min(1, input.forward));
  const r = Math.max(-1, Math.min(1, input.right));
  const len = Math.hypot(f, r);
  if (len === 0) return { x: 0, z: 0 };
  const speed = input.run ? MOVE.run : MOVE.walk;
  const s = speed / Math.max(1, len);
  // Facing (-sin yaw, -cos yaw); right of it is (cos yaw, -sin yaw).
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  return { x: (-sin * f + cos * r) * s, z: (-cos * f - sin * r) * s };
}

const overlaps = (x: number, y: number, z: number, b: Box): boolean =>
  x + BODY.radius > b.min.x && x - BODY.radius < b.max.x && z + BODY.radius > b.min.z && z - BODY.radius < b.max.z && y + BODY.height > b.min.y && y < b.max.y;

function blockedAt(x: number, y: number, z: number, boxes: readonly Box[]): Box | undefined {
  for (const b of boxes) if (overlaps(x, y, z, b)) return b;
  return undefined;
}

/** Moves along one horizontal axis; climbs a low ledge, else stops at the obstacle's face. */
function slide(s: MoveState, axis: 'x' | 'z', delta: number, boxes: readonly Box[]): void {
  if (delta === 0) return;
  const nx = axis === 'x' ? s.x + delta : s.x;
  const nz = axis === 'z' ? s.z + delta : s.z;
  const hit = blockedAt(nx, s.y, nz, boxes);
  if (!hit) {
    s.x = nx;
    s.z = nz;
    return;
  }
  // A step: the obstacle's top is within reach and there is room above it.
  const rise = hit.max.y - s.y;
  if (s.grounded && rise > 0 && rise <= BODY.step && !blockedAt(nx, hit.max.y, nz, boxes)) {
    s.x = nx;
    s.z = nz;
    s.y = hit.max.y;
    return;
  }
  // Stop flush against the face that was hit.
  if (axis === 'x') {
    s.x = delta > 0 ? hit.min.x - BODY.radius - 1e-4 : hit.max.x + BODY.radius + 1e-4;
    s.vx = 0;
  } else {
    s.z = delta > 0 ? hit.min.z - BODY.radius - 1e-4 : hit.max.z + BODY.radius + 1e-4;
    s.vz = 0;
  }
}

/** How far below a surface the feet may be and still stand on it: positions travel rounded to
 *  1/128 m (7.8 mm), so a player placed on a 0.15 m floor arrives at 0.1484 m. */
export const SNAP = 0.01;

/** The top of the highest box under the body's footprint at or just above `y` (else -Infinity). */
export function groundBelow(x: number, y: number, z: number, boxes: readonly Box[]): number {
  let top = -Infinity;
  for (const b of boxes) {
    if (x + BODY.radius > b.min.x && x - BODY.radius < b.max.x && z + BODY.radius > b.min.z && z - BODY.radius < b.max.z && b.max.y <= y + SNAP) {
      top = Math.max(top, b.max.y);
    }
  }
  return top;
}

/** One step of `dt` seconds (keep dt at most 1/20 s; the client sub-steps longer frames). */
export function step(prev: MoveState, input: MoveInput, dt: number, boxes: readonly Box[]): MoveState {
  const s: MoveState = { ...prev };
  // The ground velocity moves toward the input's at `accel` (less in the air), never past it.
  const wish = wishVelocity(input);
  const rate = MOVE.accel * (s.grounded ? 1 : MOVE.airControl) * dt;
  const dvx = wish.x - s.vx;
  const dvz = wish.z - s.vz;
  const dl = Math.hypot(dvx, dvz);
  if (dl <= rate) {
    s.vx = wish.x;
    s.vz = wish.z;
  } else {
    s.vx += (dvx / dl) * rate;
    s.vz += (dvz / dl) * rate;
  }
  if (s.grounded && input.jump) {
    s.vy = MOVE.jumpSpeed;
    s.grounded = false;
  }
  slide(s, 'x', s.vx * dt, boxes);
  slide(s, 'z', s.vz * dt, boxes);
  // Vertical: gravity, then land on what is below or bump what is above.
  s.vy = Math.max(-MOVE.terminal, s.vy - MOVE.gravity * dt);
  const ny = s.y + s.vy * dt;
  if (s.vy <= 0) {
    const ground = groundBelow(s.x, s.y, s.z, boxes);
    if (ny <= ground) {
      s.y = ground;
      s.vy = 0;
      s.grounded = true;
    } else {
      s.y = ny;
      s.grounded = false;
    }
  } else {
    const ceiling = blockedAt(s.x, ny, s.z, boxes);
    if (ceiling) {
      s.y = Math.min(ny, ceiling.min.y - BODY.height - 1e-4);
      s.vy = 0;
    } else {
      s.y = ny;
    }
    s.grounded = false;
  }
  return s;
}

/** Runs `step` over a frame of any length in sub-steps of at most 1/60 s. */
export function advance(prev: MoveState, input: MoveInput, frame: number, boxes: readonly Box[]): MoveState {
  let s = prev;
  let left = Math.min(frame, 0.25);
  while (left > 1e-6) {
    const dt = Math.min(left, 1 / 60);
    s = step(s, input, dt, boxes);
    left -= dt;
  }
  return s;
}
