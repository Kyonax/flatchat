// SPDX-License-Identifier: MPL-2.0
// Writes Stage 1's greybox plaza (packages/sim's PLAZA) as a world folder in the world format:
// kits/worlds/plaza/world.toml and scenes/plaza.glb, with one mesh per surface, a box collider
// (OMI_physics_body) per solid and a spawn point (OMI_spawn_point). The folder is made, not drawn:
// run this again after changing PLAZA.
//
//   node tools/converter/scripts/make-plaza.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAZA, type Surface } from '@flatchat/sim';
import { addBox, type MeshSpec, type NodeSpec, writeGlb } from '../src/glb-writer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'kits', 'worlds', 'plaza');

// The same colours as the client's greybox, as linear RGB.
const SRGB: Record<Surface, number> = { ground: 0x4b5a3c, paving: 0x9a958c, stone: 0x7d7a74, wood: 0x8a6542, accent: 0xf9cd26, wall: 0x5c5a57 };
const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const colour = (hex: number): [number, number, number, number] => [linear(((hex >> 16) & 255) / 255), linear(((hex >> 8) & 255) / 255), linear((hex & 255) / 255), 1];

const meshes: MeshSpec[] = [];
const bySurface = new Map<Surface, number>();
for (const s of PLAZA.solids) {
  let i = bySurface.get(s.surface);
  if (i === undefined) {
    i = meshes.push({ name: s.surface, positions: [], normals: [], indices: [], colour: colour(SRGB[s.surface]) }) - 1;
    bySurface.set(s.surface, i);
  }
  addBox(meshes[i]!, [s.min.x, s.min.y, s.min.z], [s.max.x, s.max.y, s.max.z]);
}

const shapes = PLAZA.solids.map((s) => ({ type: 'box', box: { size: [s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z] } }));
const nodes: NodeSpec[] = [
  ...meshes.map((m, k) => ({ name: m.name, mesh: k })),
  ...PLAZA.solids.map((s, k) => ({
    name: `solid-${k}`,
    translation: [(s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2] as [number, number, number],
    extensions: { OMI_physics_body: { motion: { type: 'static' }, collider: { shape: k } } },
  })),
  {
    name: 'spawn',
    translation: [PLAZA.spawn.x, PLAZA.spawn.y, PLAZA.spawn.z],
    extensions: { OMI_spawn_point: { title: 'The fountain', group: 'start' } },
  },
];

mkdirSync(join(OUT, 'scenes'), { recursive: true });
writeFileSync(join(OUT, 'scenes', 'plaza.glb'), writeGlb(meshes, nodes, { OMI_physics_shape: { shapes } }, ['OMI_physics_shape', 'OMI_physics_body', 'OMI_spawn_point']));
writeFileSync(
  join(OUT, 'world.toml'),
  `# SPDX-License-Identifier: CC-BY-4.0
# Stage 1's greybox plaza, made by tools/converter/scripts/make-plaza.ts from packages/sim.
format = 1
name = "The Plaza"
description = "A paved square with a fountain, a stage and platforms: where FlatChat started."

[capacity]
recommended = 40
maximum = 60

[persistence]
mode = "reset"

[movement]
flying = false

[voice]
range = 25

[[scenes]]
id = "plaza"
file = "scenes/plaza.glb"
`,
);
process.stdout.write(`wrote ${OUT}: ${meshes.length} meshes, ${PLAZA.solids.length} solids\n`);
