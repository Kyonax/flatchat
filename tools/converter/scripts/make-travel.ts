// SPDX-License-Identifier: MPL-2.0
// Two worlds that lead to each other, for the travel checks (S2.11): copies of the plaza kit, each
// with one more scene holding a portal to the other world (an arch south of the spawn, its box
// reaching below the paving) and an `arrival` spawn group, then built for a world server.
//
//   node tools/converter/scripts/make-travel.ts OUT --worlds ID_A,ID_B [--names "A name,B name"]
//
// Writes OUT/a and OUT/b (world folders) and OUT/a.built and OUT/b.built. One JSON line names the
// portal's centre and the arrival point, in the plaza's metres.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLAZA } from '@flatchat/sim';
import { addBox, type MeshSpec, type NodeSpec, writeGlb } from '../src/glb-writer.ts';
import { convertWorld, readFolder, writeBuilt } from '../src/world.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = join(ROOT, 'kits', 'worlds', 'plaza');

const { values, positionals } = parseArgs({ allowPositionals: true, options: { worlds: { type: 'string' }, names: { type: 'string', default: 'Travel A,Travel B' } } });
const out = positionals[0];
const ids = (values.worlds ?? '').split(',');
const names = values.names.split(',');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!out || ids.length !== 2 || !ids.every((id) => UUID.test(id)) || names.length !== 2) {
  process.stderr.write('usage: make-travel.ts OUT --worlds ID_A,ID_B [--names "A,B"]\n');
  process.exit(2);
}

const C = PLAZA.size / 2;
const pave = PLAZA.spawn.y;
/** The portal: an arch 6 m south of the spawn, 4 m wide; its box reaches 0.25 m below the paving,
 *  so a player standing on it is inside. */
export const PORTAL = { center: [C, pave + 1.25, C + 18] as [number, number, number], size: [4, 3, 2] as [number, number, number] };
export const ARRIVAL = [C, pave, C + 8] as [number, number, number];

function travelScene(to: string): Uint8Array {
  const arch: MeshSpec = { name: 'portal-arch', positions: [], normals: [], indices: [], colour: [0.95, 0.6, 0.02, 1] };
  const [x, , z] = PORTAL.center;
  addBox(arch, [x - 2.2, pave, z - 0.15], [x - 1.9, pave + 3.2, z + 0.15]);
  addBox(arch, [x + 1.9, pave, z - 0.15], [x + 2.2, pave + 3.2, z + 0.15]);
  addBox(arch, [x - 2.2, pave + 3.2, z - 0.15], [x + 2.2, pave + 3.5, z + 0.15]);
  const nodes: NodeSpec[] = [
    { name: 'portal-arch', mesh: 0 },
    { name: 'portal', translation: PORTAL.center, extensions: { FLATCHAT_world: { portal: { world: to, spawn: 'arrival', size: PORTAL.size } } } },
    { name: 'arrival', translation: ARRIVAL, extensions: { OMI_spawn_point: { title: 'Arrivals', group: 'arrival' } } },
  ];
  return writeGlb([arch], nodes, {}, ['FLATCHAT_world', 'OMI_spawn_point']);
}

const report: Record<string, unknown> = { event: 'travel-worlds', portal: PORTAL.center, arrival: ARRIVAL };
for (const [k, label] of [[0, 'a'], [1, 'b']] as const) {
  const dir = join(out, label);
  mkdirSync(dir, { recursive: true });
  cpSync(KIT, dir, { recursive: true });
  writeFileSync(join(dir, 'scenes', 'travel.glb'), travelScene(ids[1 - k]!));
  const toml = readFileSync(join(dir, 'world.toml'), 'utf8').replace(/^name = ".*"$/m, `name = ${JSON.stringify(names[k])}`);
  writeFileSync(join(dir, 'world.toml'), `${toml.trimEnd()}\n\n[[scenes]]\nid = "travel"\nfile = "scenes/travel.glb"\n`);
  const built = await convertWorld(readFolder(dir), { ktx2: false });
  writeBuilt(join(out, `${label}.built`), built.out);
  report[label] = { id: ids[k], leadsTo: ids[1 - k], built: join(out, `${label}.built`) };
}
process.stdout.write(`${JSON.stringify(report)}\n`);
