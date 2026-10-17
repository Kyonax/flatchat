// SPDX-License-Identifier: Apache-2.0
// The greybox plaza (S1.09): the first place players meet, as plain boxes both ends share until
// worlds become files (the world format, S2.01). The client builds its meshes and the controller's
// colliders from these; the world server checks moves against them. A 128 m square world with a
// paved square in the middle: a fountain, a stage with steps, two low platforms to jump onto, two
// high ones with stairs, benches and pillars, and a wall around the edge.
import type { Box } from './movement.ts';

export type Surface = 'ground' | 'paving' | 'stone' | 'wood' | 'accent' | 'wall';

export interface Solid extends Box {
  surface: Surface;
}

export interface WorldMap {
  name: string;
  /** The world is the square [0, size) in x and z. */
  size: number;
  /** Where players appear: a point and a radius around it, facing `yaw`. */
  spawn: { x: number; y: number; z: number; radius: number; yaw: number };
  solids: readonly Solid[];
  /** Whether players may fly here (S2.06); the checks refuse rising above reach otherwise. */
  flying: boolean;
}

const box = (surface: Surface, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Solid => ({
  surface,
  min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
  max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
});

/** Steps climbing from `base` to `top` in `rise` steps of `run` metres, ending at z = `edge` (the
 *  face of what they lead up to) and coming from the `dir` side of it (+1: from larger z). The
 *  last rise lands on the platform itself. */
function stairs(surface: Surface, x0: number, x1: number, edge: number, base: number, top: number, rise: number, run: number, dir: 1 | -1): Solid[] {
  const count = Math.round((top - base) / rise) - 1;
  return Array.from({ length: count }, (_, i) => {
    // Step i + 1 counted from the platform: the nearest is the highest.
    const near = edge + dir * run * i;
    return box(surface, x0, base, near, x1, top - rise * (i + 1), near + dir * run);
  });
}

const SIZE = 128;
const C = SIZE / 2;
const PAVE = 0.15;

function build(): Solid[] {
  const s: Solid[] = [];
  // The ground under everything, and the paved square.
  s.push(box('ground', 0, -1, 0, SIZE, 0, SIZE));
  s.push(box('paving', C - 24, 0, C - 24, C + 24, PAVE, C + 24));
  // The fountain: a basin whose rim can be stood on, and its column.
  s.push(box('stone', C - 3, PAVE, C - 3, C + 3, PAVE + 0.6, C + 3));
  s.push(box('accent', C - 0.5, PAVE + 0.6, C - 0.5, C + 0.5, PAVE + 3, C + 0.5));
  // The stage on the north side (-z), 0.9 m up, with three steps down toward the fountain.
  s.push(box('wood', C - 12, PAVE, C - 22, C + 12, PAVE + 0.9, C - 13.5));
  s.push(...stairs('wood', C - 6, C + 6, C - 13.5, PAVE, PAVE + 0.9, 0.3, 0.5, 1));
  // Two low platforms to jump onto (0.75 m, under the 0.9 m jump).
  s.push(box('stone', C - 20, PAVE, C - 4, C - 15, PAVE + 0.75, C + 4));
  s.push(box('stone', C + 15, PAVE, C - 4, C + 20, PAVE + 0.75, C + 4));
  // Two high platforms (1.8 m) on the south corners, each with stairs of six 0.3 m steps.
  s.push(box('stone', C - 22, PAVE, C + 14, C - 14, PAVE + 1.8, C + 20));
  s.push(...stairs('stone', C - 20, C - 16, C + 14, PAVE, PAVE + 1.8, 0.3, 0.6, -1));
  s.push(box('stone', C + 14, PAVE, C + 14, C + 22, PAVE + 1.8, C + 20));
  s.push(...stairs('stone', C + 16, C + 20, C + 14, PAVE, PAVE + 1.8, 0.3, 0.6, -1));
  // Benches (stepped onto: 0.45 m) around the fountain.
  for (const [x, z, w, d] of [
    [C - 1.5, C - 6, 3, 0.5],
    [C - 1.5, C + 5.5, 3, 0.5],
    [C - 6, C - 1.5, 0.5, 3],
    [C + 5.5, C - 1.5, 0.5, 3],
  ] as const) {
    s.push(box('wood', x, PAVE, z, x + w, PAVE + 0.45, z + d));
  }
  // Pillars along the square's east and west edges.
  for (const z of [C - 18, C - 6, C + 6, C + 18]) {
    s.push(box('stone', C - 24, PAVE, z - 0.4, C - 23.2, PAVE + 4, z + 0.4));
    s.push(box('stone', C + 23.2, PAVE, z - 0.4, C + 24, PAVE + 4, z + 0.4));
  }
  // The wall around the world.
  s.push(box('wall', 0, 0, 0, SIZE, 3, 1), box('wall', 0, 0, SIZE - 1, SIZE, 3, SIZE), box('wall', 0, 0, 1, 1, 3, SIZE - 1), box('wall', SIZE - 1, 0, 1, SIZE, 3, SIZE - 1));
  return s;
}

export const PLAZA: WorldMap = {
  name: 'plaza',
  size: SIZE,
  spawn: { x: C, y: PAVE, z: C + 12, radius: 3, yaw: 0 },
  solids: build(),
  flying: false,
};

/** An empty flat world of any size (the bots' load tests, Stage 0's runs). */
export function flatWorld(size: number): WorldMap {
  return {
    name: 'flat',
    size,
    spawn: { x: size / 2, y: 0, z: size / 2, radius: Math.min(16, size / 4), yaw: 0 },
    solids: [box('ground', 0, -1, 0, size, 0, size)],
    flying: false,
  };
}
