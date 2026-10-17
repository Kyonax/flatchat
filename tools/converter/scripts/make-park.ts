// SPDX-License-Identifier: MPL-2.0
// Writes a park made only of the base library's parts (S2.05) as a world folder:
// kits/worlds/park/world.toml and scenes/park.glb, whose nodes are markers alone (a spawn point and
// FLATCHAT_world parts): no mesh, no texture, no buffer. Every client draws the parts from its own
// library, so a player arriving downloads only the plan. Run this again after changing it.
//
//   node tools/converter/scripts/make-park.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NodeSpec, writeGlb } from '../src/glb-writer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'kits', 'worlds', 'park');

const nodes: NodeSpec[] = [];
/** A part at (x, z) on the ground, turned `deg` degrees to the left. */
const part = (id: string, x: number, z: number, deg = 0, y = 0): void => {
  const half = (deg * Math.PI) / 360;
  nodes.push({ name: `${id.split(':')[1]}-${nodes.length}`, translation: [x, y, z], rotation: [0, Math.sin(half), 0, Math.cos(half)], extensions: { FLATCHAT_world: { part: { id } } } });
};

// The ground: 32 m of paving in 8 m tiles.
for (const x of [4, 12, 20, 28]) for (const z of [4, 12, 20, 28]) part('flatchat:floor-8', x, z);
// A fence around it, with a gap to the south for the arch.
for (let k = 0; k < 8; k++) {
  const c = 2 + k * 4;
  part('flatchat:fence-4', c, 0.2);
  if (c !== 14 && c !== 18) part('flatchat:fence-4', c, 31.8);
  part('flatchat:fence-4', 0.2, c, 90);
  part('flatchat:fence-4', 31.8, c, 90);
}
part('flatchat:arch-4', 16, 31.4);
// A tree in each corner and lamps around the middle.
for (const [x, z] of [[5, 5], [27, 5], [5, 27], [27, 27]] as const) part('flatchat:tree', x, z);
for (const [x, z] of [[11, 11], [21, 11], [11, 21], [21, 21]] as const) part('flatchat:lamp', x, z);
// A table in the middle with benches facing it.
part('flatchat:table', 16, 16);
part('flatchat:bench', 16, 18.6);
part('flatchat:bench', 16, 13.4, 180);
part('flatchat:bench', 13.4, 16, 90);
part('flatchat:bench', 18.6, 16, -90);
// A platform to climb by its stairs, a doorway, rocks and crates.
part('flatchat:platform-4', 26, 12);
part('flatchat:stairs-4', 26, 16);
part('flatchat:wall-door-4', 6, 16, 90);
part('flatchat:rock', 8, 26);
part('flatchat:rock', 24, 26, 40);
part('flatchat:crate', 28, 22);
part('flatchat:crate', 29.1, 22, 15);
part('flatchat:pillar', 12, 6);
part('flatchat:pillar', 20, 6);
// Where players arrive: by the arch, facing the middle.
nodes.push({ name: 'spawn', translation: [16, 0, 27], extensions: { OMI_spawn_point: { title: 'The arch', group: 'start' } } });

mkdirSync(join(OUT, 'scenes'), { recursive: true });
writeFileSync(join(OUT, 'scenes', 'park.glb'), writeGlb([], nodes, {}, ['FLATCHAT_world', 'OMI_spawn_point']));
writeFileSync(
  join(OUT, 'world.toml'),
  `# SPDX-License-Identifier: CC-BY-4.0
# A park made only of the base library's parts (S2.05), by tools/converter/scripts/make-park.ts.
format = 1
name = "The Park"
description = "Paving, fences, trees, benches, a platform and an arch, all from the base library: nothing to download but the plan."

[capacity]
recommended = 30
maximum = 40

[persistence]
mode = "reset"

[movement]
flying = false

[voice]
range = 25

[[scenes]]
id = "park"
file = "scenes/park.glb"
`,
);
process.stdout.write(`wrote ${OUT}: ${nodes.length - 1} parts and a spawn point\n`);
