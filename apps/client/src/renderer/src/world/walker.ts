// SPDX-License-Identifier: MPL-2.0
// Click to move (S2.06, DR-13): a path of points becomes the same input the keys make (forward and
// right, relative to where the player faces), so a walk to a spot is an ordinary walk to the world
// server, checked like any other. It ends at the last point, when the player stops getting closer
// for 1.5 s (something in the way), or when the page drops it because a key was pressed.

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

/** Close enough to a point to head for the next one, in metres. */
const ARRIVE = 0.35;
const STUCK_S = 1.5;

export class PathWalker {
  private readonly points: readonly PathPoint[];
  private next = 0;
  private best = Number.POSITIVE_INFINITY;
  private stuck = 0;
  done = false;

  constructor(points: readonly PathPoint[]) {
    this.points = points.slice();
    this.done = this.points.length === 0;
  }

  /** This frame's input for a player at `at` facing `yaw` (0 faces -z), `dt` seconds after the last. */
  input(at: PathPoint, yaw: number, dt: number): { forward: number; right: number } {
    while (this.next < this.points.length && Math.hypot(this.points[this.next]!.x - at.x, this.points[this.next]!.z - at.z) < ARRIVE) {
      this.next += 1;
      this.best = Number.POSITIVE_INFINITY;
      this.stuck = 0;
    }
    if (this.done || this.next >= this.points.length) {
      this.done = true;
      return { forward: 0, right: 0 };
    }
    const p = this.points[this.next]!;
    const dx = p.x - at.x;
    const dz = p.z - at.z;
    const d = Math.hypot(dx, dz);
    if (d < this.best - 0.05) {
      this.best = d;
      this.stuck = 0;
    } else if ((this.stuck += dt) > STUCK_S) {
      this.done = true;
      return { forward: 0, right: 0 };
    }
    const ux = dx / d;
    const uz = dz / d;
    // Facing (-sin yaw, -cos yaw); its right is (cos yaw, -sin yaw) (packages/sim's wishVelocity).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const last = this.next === this.points.length - 1;
    const pace = last ? Math.min(1, 0.3 + d) : 1;
    return { forward: (-sin * ux - cos * uz) * pace, right: (cos * ux - sin * uz) * pace };
  }
}
