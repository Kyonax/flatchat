// SPDX-License-Identifier: Apache-2.0
// The base library (S2.05, Q-L6, Q-E3): parts every client carries, which a world places by id
// with FLATCHAT_world's `part` marker instead of shipping their geometry. Each part is a set of
// boxes in metres (its looks, in the library's colours, and its solids), with its origin at the
// centre of its footprint on the floor (y = 0) and its front facing -z, like a spawn point; a
// part's seats are where a player sits on it. Version 1 is a greybox kit: Track P's art may
// replace how a part looks, never its id, its size or its solids.

export type Vec3 = [number, number, number];

export const PART_COLOURS = {
  stone: 0x7d7a74,
  paving: 0x9a958c,
  wood: 0x8a6542,
  metal: 0x5c5f66,
  leaf: 0x4f7a3a,
  accent: 0xf9cd26,
} as const;

export type PartColour = keyof typeof PART_COLOURS;

export interface PartBox {
  min: Vec3;
  max: Vec3;
  colour: PartColour;
  /** A box players cannot walk through (the default); leaves and lamp heads are not. */
  solid?: boolean;
}

export interface PartDef {
  title: string;
  boxes: readonly PartBox[];
  seats?: ReadonlyArray<{ position: Vec3; yaw: number }>;
}

const box = (min: Vec3, max: Vec3, colour: PartColour, solid = true): PartBox => ({ min, max, colour, ...(solid ? {} : { solid: false }) });

/** Six steps of 0.25 m rising toward -z over 4 m, 2 m wide: a 1.5 m climb. */
function stairs(): PartBox[] {
  const run = 4 / 6;
  return Array.from({ length: 6 }, (_, i) => box([-1, 0, 2 - (i + 1) * run], [1, (i + 1) * 0.25, 2 - i * run], 'stone'));
}

export const BASE_PARTS: Readonly<Record<string, PartDef>> = {
  'flatchat:floor-4': { title: 'Floor, 4 m', boxes: [box([-2, -0.2, -2], [2, 0, 2], 'paving')] },
  'flatchat:floor-8': { title: 'Floor, 8 m', boxes: [box([-4, -0.2, -4], [4, 0, 4], 'paving')] },
  'flatchat:platform-4': { title: 'Platform, 4 m, 1.5 m high', boxes: [box([-2, 0, -2], [2, 1.5, 2], 'stone')] },
  'flatchat:stairs-4': { title: 'Stairs, 4 m, up 1.5 m', boxes: stairs() },
  'flatchat:wall-4': { title: 'Wall, 4 m', boxes: [box([-2, 0, -0.1], [2, 3, 0.1], 'stone')] },
  'flatchat:wall-door-4': {
    title: 'Wall with a doorway, 4 m',
    boxes: [box([-2, 0, -0.1], [-0.6, 3, 0.1], 'stone'), box([0.6, 0, -0.1], [2, 3, 0.1], 'stone'), box([-0.6, 2.3, -0.1], [0.6, 3, 0.1], 'stone')],
  },
  'flatchat:arch-4': {
    title: 'Arch, 4 m',
    boxes: [box([-2, 0, -0.3], [-1.4, 3.5, 0.3], 'stone'), box([1.4, 0, -0.3], [2, 3.5, 0.3], 'stone'), box([-2, 3.5, -0.3], [2, 4, 0.3], 'accent')],
  },
  'flatchat:pillar': { title: 'Pillar, 3 m', boxes: [box([-0.25, 0, -0.25], [0.25, 3, 0.25], 'stone')] },
  'flatchat:fence-4': {
    title: 'Fence, 4 m',
    boxes: [box([-2, 0, -0.05], [-1.9, 1, 0.05], 'wood'), box([1.9, 0, -0.05], [2, 1, 0.05], 'wood'), box([-2, 0.4, -0.04], [2, 0.5, 0.04], 'wood'), box([-2, 0.85, -0.04], [2, 0.95, 0.04], 'wood')],
  },
  'flatchat:bench': {
    title: 'Bench',
    boxes: [box([-0.8, 0.4, -0.25], [0.8, 0.46, 0.25], 'wood'), box([-0.75, 0, -0.2], [-0.65, 0.4, 0.2], 'wood'), box([0.65, 0, -0.2], [0.75, 0.4, 0.2], 'wood')],
    seats: [
      { position: [-0.4, 0.46, 0], yaw: 0 },
      { position: [0.4, 0.46, 0], yaw: 0 },
    ],
  },
  'flatchat:table': {
    title: 'Table',
    boxes: [
      box([-0.8, 0.72, -0.5], [0.8, 0.78, 0.5], 'wood'),
      ...([
        [-0.72, -0.42],
        [0.66, -0.42],
        [-0.72, 0.36],
        [0.66, 0.36],
      ] as const).map(([x, z]) => box([x, 0, z], [x + 0.06, 0.72, z + 0.06], 'wood')),
    ],
  },
  'flatchat:crate': { title: 'Crate, 1 m', boxes: [box([-0.5, 0, -0.5], [0.5, 1, 0.5], 'wood')] },
  'flatchat:rock': { title: 'Rock', boxes: [box([-0.6, 0, -0.5], [0.6, 0.6, 0.5], 'stone'), box([-0.35, 0.6, -0.3], [0.3, 0.85, 0.25], 'stone')] },
  'flatchat:lamp': { title: 'Lamp post', boxes: [box([-0.06, 0, -0.06], [0.06, 2.6, 0.06], 'metal'), box([-0.18, 2.6, -0.18], [0.18, 2.85, 0.18], 'accent', false)] },
  'flatchat:tree': {
    title: 'Tree',
    boxes: [box([-0.15, 0, -0.15], [0.15, 2.2, 0.15], 'wood'), box([-1.2, 2.2, -1.2], [1.2, 3.4, 1.2], 'leaf', false), box([-0.8, 3.4, -0.8], [0.8, 4.2, 0.8], 'leaf', false)],
  },
};

/** At most this many parts in a world's scenes. */
export const MAX_PARTS = 10_000;

export function isPart(id: unknown): id is string {
  return typeof id === 'string' && Object.hasOwn(BASE_PARTS, id);
}
