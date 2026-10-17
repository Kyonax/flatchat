// SPDX-License-Identifier: MPL-2.0
// Where the camera goes (S1.09): at the eyes in first person; in third person behind and above the
// avatar, pulled in when a wall or a pillar would come between, so the view never ends up inside a
// solid. Pure arithmetic over the world's boxes.
import { BODY, type Box } from '@flatchat/sim';

export interface CameraPose {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

const BOOM = 3.6;
const LIFT = 0.35;
const MARGIN = 0.25;

const inside = (x: number, y: number, z: number, boxes: readonly Box[]): boolean =>
  boxes.some((b) => x > b.min.x - MARGIN && x < b.max.x + MARGIN && y > b.min.y - MARGIN && y < b.max.y + MARGIN && z > b.min.z - MARGIN && z < b.max.z + MARGIN);

/** `scale` is the player's height over the standard body's (S2.07): the eyes, the lift and the
 *  boom grow and shrink with it. */
export function cameraPose(person: 'first' | 'third', feet: { x: number; y: number; z: number }, yaw: number, pitch: number, boxes: readonly Box[], scale = 1): CameraPose {
  const eye = { x: feet.x, y: feet.y + BODY.eye * scale, z: feet.z };
  // The look direction: yaw 0 faces -z; pitch up is positive.
  const dir = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  if (person === 'first') return { position: eye, target: { x: eye.x + dir.x, y: eye.y + dir.y, z: eye.z + dir.z } };
  const head = { x: eye.x, y: eye.y + LIFT * scale, z: eye.z };
  const boom = Math.min(9, Math.max(1.2, BOOM * scale));
  // March back along the boom and stop before the first solid.
  let reach = boom;
  for (let d = 0.2; d <= boom; d += 0.1) {
    if (inside(head.x - dir.x * d, head.y - dir.y * d, head.z - dir.z * d, boxes)) {
      reach = Math.max(0.3, d - 0.2);
      break;
    }
  }
  return {
    position: { x: head.x - dir.x * reach, y: head.y - dir.y * reach, z: head.z - dir.z * reach },
    target: { x: head.x + dir.x, y: head.y + dir.y, z: head.z + dir.z },
  };
}
