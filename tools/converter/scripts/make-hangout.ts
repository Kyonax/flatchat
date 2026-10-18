// SPDX-License-Identifier: MPL-2.0
// The owner's hangout world (S7.03): the docking bay of Track P's P.01, built again from its SVG plan
// (kits/worlds/docking-bay/plan.svg), with a lounge of base library parts on its deck (benches facing
// the bay window, tables with benches round them, lamps, a small stage, two planters), the hangar as
// a hall reverb zone (S6.06), a low hum through it, and a station's look (S6.05): a black sky, the
// stars' light through the window, bloom on the neon strips. Then it converts the folder with the host
// tool's converter, as a host would, and says what it made.
//
//   node tools/converter/scripts/make-hangout.ts [OUT]       OUT defaults to kits/worlds/hangout
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NodeSpec, writeGlb } from '../src/glb-writer.ts';
import { buildPlan } from '../src/plan/build.ts';
import { readPlan } from '../src/plan/plan.ts';
import { convertWorld, readFolder } from '../src/world.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = resolve(process.argv[2] ?? join(ROOT, 'kits', 'worlds', 'hangout'));
type V3 = [number, number, number];

/** A turn about y, as a quaternion: the part faces `yaw` radians from north. */
const turn = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const part = (name: string, id: string, at: V3, yaw = 0): NodeSpec => ({ name, translation: at, rotation: turn(yaw), extensions: { FLATCHAT_world: { part: { id } } } });

/** The lounge, in the bay's metres (x east, z south from the hull's north-west corner; the window is
 *  the north wall, z = 0, from x = 7 to 33; the landing pad is x 13–27, z 8–22; the stairs x 4–6.4).
 *  A bench's seats face north at yaw 0. */
function lounge(): NodeSpec[] {
  const nodes: NodeSpec[] = [];
  // Two rows of benches facing the window, a walkway down the middle.
  for (const [i, x] of [11.5, 15, 25, 28.5].entries()) nodes.push(part(`window-bench-${i}`, 'flatchat:bench', [x, 0, 3.5]));
  for (const [i, x] of [13.2, 16.8, 23.2, 26.8].entries()) nodes.push(part(`window-bench-back-${i}`, 'flatchat:bench', [x, 0, 6]));
  // Three tables on the east side, a bench either side of each, facing it.
  for (const [i, z] of [10, 14, 18].entries()) {
    nodes.push(part(`table-${i}`, 'flatchat:table', [34, 0, z]));
    nodes.push(part(`table-${i}-north`, 'flatchat:bench', [34, 0, z - 0.9], Math.PI));
    nodes.push(part(`table-${i}-south`, 'flatchat:bench', [34, 0, z + 0.9]));
  }
  // Lamps along the lounge, a small stage by the window's west end, planters in the north corners.
  for (const [i, at] of ([[10, 0, 7.5], [30, 0, 7.5], [31, 0, 20.5], [37.5, 0, 20.5]] as V3[]).entries()) nodes.push(part(`lamp-${i}`, 'flatchat:lamp', at));
  nodes.push(part('stage', 'flatchat:platform-4', [9, 0, 2.6]));
  nodes.push(part('planter-west', 'flatchat:tree', [2, 0, 2]));
  nodes.push(part('planter-east', 'flatchat:tree', [38, 0, 2]));
  // The hangar's sound: a hall, 40 by 30 m and 8 m high, and a low hum through it.
  nodes.push({ name: 'hangar-hall', translation: [20, 4, 15], extensions: { FLATCHAT_world: { zone: { kind: 'reverb', size: [40, 8, 30], room: 'hall', mix: 0.35 } } } });
  nodes.push({ name: 'hangar-hum', translation: [20, 6, 15], extensions: { KHR_audio_emitter: { emitter: 0 } } });
  return nodes;
}

/** Four seconds of a station's hum: 55 Hz with its next harmonics, a slow swell and a little air;
 *  16-bit mono, seeded, so it is the same every time. */
function humWav(seconds = 4, rate = 22_050): Uint8Array {
  const n = seconds * rate;
  const bytes = new Uint8Array(44 + n * 2);
  const v = new DataView(bytes.buffer);
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
  let seed = 20_261_018;
  let air = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    air += 0.02 * ((seed / 0xffffffff) * 2 - 1 - air);
    // Whole cycles in the four seconds, so the loop has no seam.
    const swell = 0.8 + 0.2 * Math.sin((2 * Math.PI * t) / seconds);
    const hum = 0.6 * Math.sin(2 * Math.PI * 55 * t) + 0.25 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 165 * t);
    v.setInt16(44 + i * 2, Math.round((hum * swell + air * 0.6) * 7000), true);
  }
  return bytes;
}

const WORLD_TOML = `# SPDX-License-Identifier: CC-BY-4.0
# The owner's hangout (S7.03), written by tools/converter/scripts/make-hangout.ts: the docking bay
# from its SVG plan, with a lounge of base library parts, a hall's echo and a hum.
format = 1
name = "The Hangout"
description = "A docking bay on a station's rim, its deck turned lounge: benches facing the stars, tables, a small stage."

[capacity]
recommended = 40
maximum = 60

[persistence]
mode = "reset"

[movement]
flying = false

[voice]
range = 25

[look]
sky = "#05060a"
fog = false
sun = { colour = "#d8e6ff", intensity = 1.4, direction = [0.2, 0.6, -1] }
ambient = { sky = "#7d8fb8", ground = "#3a3f4c", intensity = 1.5 }
bloom = { strength = 0.8, threshold = 0.75, radius = 0.45 }
filters = { vignette = 0.3, grain = 0.08, saturation = 1.08, contrast = 1.05 }

[[scenes]]
id = "bay"
file = "scenes/bay.glb"

[[scenes]]
id = "lounge"
file = "scenes/lounge.glb"
`;

const plan = readPlan(readFileSync(join(ROOT, 'kits', 'worlds', 'docking-bay', 'plan.svg'), 'utf8'));
const bay = buildPlan(plan, 'bay');
mkdirSync(join(out, 'scenes'), { recursive: true });
writeFileSync(join(out, 'scenes', 'bay.glb'), bay.glb);
const sound = {
  audio: [{ uri: 'hum.wav' }],
  sources: [{ audio: 0, gain: 0.25, loop: true, autoPlay: true }],
  emitters: [{ type: 'positional', gain: 1, sources: [0], positional: { refDistance: 12, maxDistance: 60 } }],
};
writeFileSync(join(out, 'scenes', 'lounge.glb'), writeGlb([], lounge(), { KHR_audio_emitter: sound }, ['FLATCHAT_world', 'KHR_audio_emitter']));
writeFileSync(join(out, 'scenes', 'hum.wav'), humWav());
writeFileSync(join(out, 'world.toml'), WORLD_TOML);
const built = await convertWorld(readFolder(out));
const scenes = built.world.scenes;
process.stdout.write(
  `${JSON.stringify({
    event: 'hangout',
    out,
    bay: { triangles: bay.triangles, materials: bay.materials, solids: bay.solids, parts: bay.parts },
    built: {
      files: built.world.files.length,
      bytes: built.world.files.reduce((n, f) => n + f.size, 0),
      parts: scenes.reduce((n, s) => n + s.parts.length, 0),
      seats: scenes.reduce((n, s) => n + s.seats.length, 0),
      spawns: scenes.reduce((n, s) => n + s.spawns.length, 0),
      zones: scenes.flatMap((s) => s.zones).map((z) => z.kind),
      emitters: scenes.reduce((n, s) => n + s.emitters.length, 0),
      look: !!built.world.manifest.look,
    },
  })}\n`,
);
