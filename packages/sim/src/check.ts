// SPDX-License-Identifier: Apache-2.0
// The world server's view of a move (S1.08, sf-004): each client moves itself and sends its pose;
// the server accepts what the controller could have done and corrects the rest. A move is
// impossible when it covers more ground than running allows (with slack for jitter), or, where
// flying is off, when it rises above the reach of a jump from anything nearby. Falling is always
// allowed. Walls are not checked yet: walking through them gains nothing in Stage 1's plaza.
import { type Box, JUMP_APEX, MOVE, type Vec3 } from './movement.ts';

export interface MoveLimits {
  /** Ground speed accepted, m/s: running plus a margin. */
  maxSpeed: number;
  /** Metres of tolerance per pose for jitter and rounding. */
  slack: number;
  flying: boolean;
  /** How far around the player a surface counts as one it could have jumped from, metres. */
  reach: number;
}

export const DEFAULT_LIMITS: MoveLimits = { maxSpeed: MOVE.run * 1.15, slack: 0.75, flying: false, reach: 4 };

export type MoveVerdict = 'ok' | 'too-fast' | 'too-high';

/** The highest top among the boxes whose footprint lies within `reach` of (x, z). */
export function highestNear(x: number, z: number, reach: number, boxes: readonly Box[]): number {
  let top = 0;
  for (const b of boxes) {
    const dx = Math.max(b.min.x - x, 0, x - b.max.x);
    const dz = Math.max(b.min.z - z, 0, z - b.max.z);
    if (dx * dx + dz * dz <= reach * reach) top = Math.max(top, b.max.y);
  }
  return top;
}

export function checkMove(from: Vec3, to: Vec3, dt: number, limits: MoveLimits, boxes: readonly Box[]): MoveVerdict {
  if (Math.hypot(to.x - from.x, to.z - from.z) > limits.maxSpeed * Math.max(0, dt) + limits.slack) return 'too-fast';
  if (!limits.flying && to.y > from.y && to.y > highestNear(to.x, to.z, limits.reach, boxes) + JUMP_APEX + limits.slack) return 'too-high';
  return 'ok';
}
