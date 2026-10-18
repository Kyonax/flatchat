// SPDX-License-Identifier: MPL-2.0
// The player's movement among a world's real solids (S2.06, DR-13): Rapier's kinematic character
// controller over the built world's colliders (boxes, spheres, capsules, cylinders and triangle
// meshes from collision.bin), with packages/sim's numbers: the same speeds, jump and step height
// the world server checks against. Slopes up to 45° are walked, steps up to 0.45 m climbed, and
// the feet snap to the ground going down stairs. Flying, where a world allows it, moves freely.
import type { Collider } from '@flatchat/content';
import { BODY, MOVE, type MoveInput, wishVelocity } from '@flatchat/sim';
import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<void> | undefined;

/** Loads Rapier's WebAssembly once (the compat build carries it inside, so no file is fetched). */
export function loadPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export interface Body {
  x: number;
  y: number;
  z: number;
  vy: number;
  grounded: boolean;
}

const HALF = (BODY.height - 2 * BODY.radius) / 2;

export class Physics {
  private readonly world: RAPIER.World;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private vx = 0;
  private vz = 0;
  state: Body;
  flying = false;

  /** Builds the world's solids; the player starts standing at `start` (the feet). */
  constructor(colliders: readonly Collider[], start: { x: number; y: number; z: number }) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    for (const c of colliders) {
      let desc: RAPIER.ColliderDesc | null;
      if (c.type === 'trimesh') desc = RAPIER.ColliderDesc.trimesh(c.positions, c.indices);
      else {
        desc =
          c.type === 'box'
            ? RAPIER.ColliderDesc.cuboid(c.half[0], c.half[1], c.half[2])
            : c.type === 'sphere'
              ? RAPIER.ColliderDesc.ball(c.radius)
              : c.type === 'capsule'
                ? RAPIER.ColliderDesc.capsule(c.halfHeight, c.radius)
                : RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius);
        desc.setTranslation(c.position[0], c.position[1], c.position[2]).setRotation({ x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] });
      }
      if (desc) this.world.createCollider(desc);
    }
    this.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y + HALF + BODY.radius, start.z));
    this.collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(HALF, BODY.radius), this.body);
    this.controller = this.world.createCharacterController(0.02);
    this.controller.enableAutostep(BODY.step, 0.15, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((50 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.world.step();
    this.state = { ...start, vy: 0, grounded: false };
  }

  /** Puts the player somewhere (the server's spawn, or a correction). */
  teleport(x: number, y: number, z: number): void {
    this.body.setNextKinematicTranslation({ x, y: y + HALF + BODY.radius, z });
    this.body.setTranslation({ x, y: y + HALF + BODY.radius, z }, true);
    this.vx = 0;
    this.vz = 0;
    this.state = { x, y, z, vy: 0, grounded: false };
    this.world.step();
  }

  /** One frame of movement, in sub-steps of at most 1/60 s. `up` is for flying (+1 up, -1 down). */
  step(input: MoveInput, frame: number, up = 0): Body {
    let left = Math.min(frame, 0.25);
    while (left > 1e-6) {
      const dt = Math.min(left, 1 / 60);
      this.sub(input, dt, up);
      left -= dt;
    }
    return this.state;
  }

  private sub(input: MoveInput, dt: number, up: number): void {
    const s = this.state;
    const wish = wishVelocity(input);
    const rate = MOVE.accel * (s.grounded || this.flying ? 1 : MOVE.airControl) * dt;
    const dvx = wish.x - this.vx;
    const dvz = wish.z - this.vz;
    const dl = Math.hypot(dvx, dvz);
    if (dl <= rate) {
      this.vx = wish.x;
      this.vz = wish.z;
    } else {
      this.vx += (dvx / dl) * rate;
      this.vz += (dvz / dl) * rate;
    }
    if (this.flying) s.vy = up * (input.run ? MOVE.run : MOVE.walk);
    else {
      if (s.grounded && input.jump) s.vy = MOVE.jumpSpeed;
      else if (s.grounded && s.vy <= 0) s.vy = -1;
      s.vy = Math.max(-MOVE.terminal, s.vy - MOVE.gravity * dt);
    }
    this.controller.computeColliderMovement(this.collider, { x: this.vx * dt, y: s.vy * dt, z: this.vz * dt });
    const m = this.controller.computedMovement();
    const p = this.body.translation();
    const next = { x: p.x + m.x, y: p.y + m.y, z: p.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.world.step();
    const grounded = !this.flying && this.controller.computedGrounded();
    // Bumped a ceiling: the jump ends.
    if (s.vy > 0 && m.y < s.vy * dt * 0.5) s.vy = 0;
    if (grounded && s.vy < 0) s.vy = 0;
    this.state = { x: next.x, y: next.y - HALF - BODY.radius, z: next.z, vy: s.vy, grounded };
  }

  /** Whether a world solid stands between two points (S6.06's occlusion): a ray through everything
   *  but the player, stopping `clearance` metres short of `to` (a sound inside its own fountain or
   *  speaker box is not behind it). */
  blocked(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, clearance = 0.5): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > clearance)) return false;
    const ray = new RAPIER.Ray(from, { x: dx / d, y: dy / d, z: dz / d });
    return this.world.castRay(ray, d - clearance, true, undefined, undefined, this.collider) !== null;
  }

  dispose(): void {
    this.world.free();
  }
}
