// SPDX-License-Identifier: MPL-2.0
// The spatial grid behind interest management: square cells of CELL_SIZE metres (32) on the
// ground plane, the same cells the protocol's cell blocks use (docs/protocol.md). Pure functions.
import { CELL_SIZE } from '@flatchat/protocol';

/** The cell index of one ground coordinate (x or z), in metres. */
export function cellOf(v: number): number {
  return Math.floor(v / CELL_SIZE);
}

// Cell indices fit the protocol's int 16, so a pair packs into one safe integer key.
const OFFSET = 32_768;
const SPAN = 65_536;

export function cellKey(cx: number, cz: number): number {
  return (cx + OFFSET) * SPAN + (cz + OFFSET);
}

export function keyCx(key: number): number {
  return Math.floor(key / SPAN) - OFFSET;
}

export function keyCz(key: number): number {
  return (key % SPAN) - OFFSET;
}

/** Distance in metres from a point to the nearest point of a cell's square (0 inside it). */
export function distanceToCell(x: number, z: number, cx: number, cz: number): number {
  const x0 = cx * CELL_SIZE;
  const z0 = cz * CELL_SIZE;
  const dx = x < x0 ? x0 - x : x > x0 + CELL_SIZE ? x - (x0 + CELL_SIZE) : 0;
  const dz = z < z0 ? z0 - z : z > z0 + CELL_SIZE ? z - (z0 + CELL_SIZE) : 0;
  return Math.hypot(dx, dz);
}
