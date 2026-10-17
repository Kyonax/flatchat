// SPDX-License-Identifier: MPL-2.0
// Two worlds that lead to each other, for the travel checks (S2.11): copies of the plaza kit, each
// with one more scene holding a portal to the other world (an arch south of the spawn, its box
// reaching below the paving), an `arrival` spawn group and the fountain's sound (S2.14: a looping
// positional emitter over the fountain, a seeded noise made here as a WAV), then built for a world
// server.
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

/** Two seconds of running water: low-passed noise from a fixed seed, swelling slowly; 16-bit mono. */
function fountainWav(seconds = 2, rate = 22_050): Uint8Array {
  const n = seconds * rate;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * 2, true);
  let seed = 20_261_017;
  let low = 0;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    low += 0.15 * ((seed / 0xffffffff) * 2 - 1 - low);
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.7 * i) / rate);
    v.setInt16(44 + i * 2, Math.round(low * swell * 9000), true);
  }
  return out;
}

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
    { name: 'fountain-sound', translation: [C, pave + 1, C], extensions: { KHR_audio_emitter: { emitter: 0 } } },
  ];
  const sound = {
    audio: [{ uri: 'fountain.wav' }],
    sources: [{ audio: 0, gain: 0.7, loop: true, autoPlay: true }],
    emitters: [{ type: 'positional', gain: 1, sources: [0], positional: { refDistance: 2, maxDistance: 25 } }],
  };
  return writeGlb([arch], nodes, { KHR_audio_emitter: sound }, ['FLATCHAT_world', 'OMI_spawn_point', 'KHR_audio_emitter']);
}

const report: Record<string, unknown> = { event: 'travel-worlds', portal: PORTAL.center, arrival: ARRIVAL };
for (const [k, label] of [[0, 'a'], [1, 'b']] as const) {
  const dir = join(out, label);
  mkdirSync(dir, { recursive: true });
  cpSync(KIT, dir, { recursive: true });
  writeFileSync(join(dir, 'scenes', 'travel.glb'), travelScene(ids[1 - k]!));
  writeFileSync(join(dir, 'scenes', 'fountain.wav'), fountainWav());
  const toml = readFileSync(join(dir, 'world.toml'), 'utf8').replace(/^name = ".*"$/m, `name = ${JSON.stringify(names[k])}`);
  writeFileSync(join(dir, 'world.toml'), `${toml.trimEnd()}\n\n[[scenes]]\nid = "travel"\nfile = "scenes/travel.glb"\n`);
  const built = await convertWorld(readFolder(dir), { ktx2: false });
  writeBuilt(join(out, `${label}.built`), built.out);
  report[label] = { id: ids[k], leadsTo: ids[1 - k], built: join(out, `${label}.built`) };
}
process.stdout.write(`${JSON.stringify(report)}\n`);
