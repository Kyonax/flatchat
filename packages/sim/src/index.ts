// SPDX-License-Identifier: Apache-2.0
// FlatChat's movement rules, shared by the client (prediction) and the world server (checks).
export { checkMove, DEFAULT_LIMITS, highestNear, type MoveLimits, type MoveVerdict } from './check.ts';
export { advance, BODY, type Box, groundBelow, JUMP_APEX, MOVE, type MoveInput, type MoveState, SNAP, standing, step, type Vec3, wishVelocity } from './movement.ts';
export { flatWorld, PLAZA, type Solid, type Surface, type WorldMap } from './plaza.ts';
