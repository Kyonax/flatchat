// SPDX-License-Identifier: MPL-2.0
// Isometric previews of a building plan (Track P's P.01, T-16): the plan's solids as the builder
// makes them (planSolids), drawn by one of the two picture-making skills the spike compares. They
// are previews, never the plan's source. A cut-away, as architects draw one: a wall taller than
// 4 m is cut 1.5 m above its floor so the rooms show, the roof and the space round the station are
// left out, each base part is its boxes. Units: a tenth of a metre; x east, y south, z up.
//
//   node tools/converter/scripts/plan-preview.ts PLAN.svg --with anatomy --kit DIR --out FILE.html
//   node tools/converter/scripts/plan-preview.ts PLAN.svg --with iso-figures --kit DIR --out FILE.html
//
// The anatomy skill (MIT, github.com/wheresryan22/anatomy) is read from DIR/kit/iso-kit.mjs; it
// extrudes any ring and shades it. iso-figures (the owner's skill) is read from
// DIR/assets/figure-template.html, whose core draws boxes along the axes; the figure is written
// in place of the template's example. Neither is copied into this repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BASE_PARTS } from '@flatchat/content';
import { planSolids } from '../src/plan/build.ts';
import { readPlan } from '../src/plan/plan.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { with: { type: 'string' }, kit: { type: 'string' }, out: { type: 'string' } } });
const planFile = positionals[0];
if (!planFile || !values.kit || !values.out || (values.with !== 'anatomy' && values.with !== 'iso-figures')) {
  console.error('usage: plan-preview.ts PLAN.svg --with anatomy|iso-figures --kit DIR --out FILE');
  process.exit(2);
}
const plan = readPlan(readFileSync(planFile, 'utf8'));
const solids = planSolids(plan);
const U = 10;

/** A solid to draw: a ring on the floor plane between two heights, and how it should look. */
interface Prism {
  ring: Array<[number, number]>;
  z0: number;
  z1: number;
  tone: 'lo' | 'mid' | 'hi';
  slab?: boolean;
}

const cutFor = (z: number): number => {
  // The cut above the floor a solid stands on.
  const floor = [...plan.floors].sort((a, b) => b.elevation - a.elevation).find((f) => z >= f.elevation - 1e-6) ?? plan.floors[0]!;
  return floor.elevation + 1.5;
};
const prisms: Prism[] = [];
const boxRing = (c: [number, number, number], half: [number, number, number], yaw: number): Array<[number, number]> => {
  const [cs, sn] = [Math.cos(yaw), Math.sin(yaw)];
  // The box's local x is the world's (cos yaw, -sin yaw) on the floor (x, z).
  const ax: [number, number] = [cs, -sn];
  const az: [number, number] = [sn, cs];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [(c[0] + ax[0] * half[0] * a! + az[0] * half[2] * b!) * U, (c[2] + ax[1] * half[0] * a! + az[1] * half[2] * b!) * U]);
};
for (const b of solids.boxes) {
  const z0 = b.centre[1] - b.half[1];
  let z1 = b.centre[1] + b.half[1];
  if (b.kind === 'wall' && b.half[1] * 2 > 4) z1 = Math.min(z1, cutFor(z0));
  // A lintel above its floor's cut is left out with the rest of the wall over it.
  if (b.kind === 'wall' && z0 >= cutFor(z0) - 1e-6) continue;
  if (z1 - z0 < 0.01) continue;
  prisms.push({ ring: boxRing(b.centre, b.half, b.yaw), z0: z0 * U, z1: z1 * U, tone: 'mid' });
}
for (const s of solids.slabs) prisms.push({ ring: s.ring.map(([x, z]) => [x * U, z * U]), z0: s.bottom * U, z1: s.top * U, tone: s.material === 'pad' ? 'hi' : 'lo', slab: true });
for (const p of solids.props) {
  const part = BASE_PARTS[p.part];
  if (!part) continue;
  const yaw = (-p.rotate * Math.PI) / 180;
  for (const box of part.boxes) {
    const centre: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    // Turned about the part's origin, then placed.
    const [cs, sn] = [Math.cos(yaw), Math.sin(yaw)];
    const world: [number, number, number] = [p.at[0] + centre[0] * cs + centre[2] * sn, p.at[1] + centre[1], p.at[2] - centre[0] * sn + centre[2] * cs];
    prisms.push({ ring: boxRing(world, [(box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2], yaw), z0: (world[1] - (box.max[1] - box.min[1]) / 2) * U, z1: (world[1] + (box.max[1] - box.min[1]) / 2) * U, tone: 'hi' });
  }
}
// Back to front: by the height a prism stands at (a slab by its top, under what stands on it),
// slabs first at a height, then by how near its middle is to the viewer (from +x, +y, above).
const layer = (p: Prism): number => (p.slab ? p.z1 : p.z0);
const near = (p: Prism): number => p.ring.reduce((n, [x, y]) => n + x + y, 0) / p.ring.length;
prisms.sort((a, b) => layer(a) - layer(b) || Number(!a.slab) - Number(!b.slab) || near(a) - near(b));

const name = plan.name;
if (values.with === 'anatomy') {
  const k = (await import(pathToFileURL(join(resolve(values.kit), 'kit', 'iso-kit.mjs')).href)) as Record<string, (...args: unknown[]) => unknown>;
  const points = prisms.flatMap((p) => p.ring.flatMap(([x, y]) => [[x, y, p.z0], [x, y, p.z1]]));
  const P = k['fitProjection']!(points, 1200, 820, { pad: 30, azimuth: 45, elevation: 34 });
  const body = prisms.map((p) => k['solidSvg']!(k['extrude']!(p.ring, p.z0, p.z1 - p.z0, P, { convex: true }), { tone: p.tone }) as string).join('');
  const figure = k['figureSvg']!({ width: 1200, height: 820, label: `${name}: an isometric cut-away of its plan`, body }) as string;
  const plate = k['plateHtml']!({ fig: 'Fig 1', title: name, hint: 'A building plan, cut 1.5 m above each floor', readout: `${prisms.length} solids`, body: figure }) as string;
  writeFileSync(values.out, k['pageHtml']!({ title: name, theme: 'dark', body: plate, width: 1100 }) as string);
} else {
  const template = readFileSync(join(resolve(values.kit), 'assets', 'figure-template.html'), 'utf8');
  const start = template.indexOf('<script>\n/* Fig 1 ');
  const end = template.indexOf('</script>', start);
  if (start < 0 || end < 0) throw new Error('the iso-figures template has no example figure block to replace');
  // iso-figures draws boxes along the axes: each prism as its bounds.
  const boxes = prisms.map((p) => {
    const xs = p.ring.map(([x]) => x);
    const ys = p.ring.map(([, y]) => y);
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    return [x0, y0, p.z0, Math.max(...xs) - x0, Math.max(...ys) - y0, p.z1 - p.z0].map((v) => Math.round(v * 10) / 10);
  });
  const all = boxes.flatMap(([x, y, z, w, d, h]) => [[x, y, z], [x! + w!, y! + d!, z! + h!], [x, y! + d!, z], [x! + w!, y, z! + h!]]);
  const block = `<script>
/* ${name}: an isometric cut-away of its plan (Track P's P.01), written by tools/converter/scripts/plan-preview.ts. */
FIGS.push({
  id: 'plan',
  name: ${JSON.stringify(name)},
  no: 1,
  hint: 'A building plan, cut 1.5 m above each floor',
  aria: ${JSON.stringify(`${name}: an isometric cut-away of its plan, its walls cut 1.5 m above each floor.`)},
  mount(stage, api) {
    const BOXES = ${JSON.stringify(boxes)};
    const K = api.iso.frame(${JSON.stringify(all)});
    stage.setAttribute('viewBox', K.viewBox);
    stage.innerHTML = BOXES.map((b) => K.box(...b, 0)).join('');
    api.readout(BOXES.length + ' solids');
  },
});
`;
  writeFileSync(values.out, template.slice(0, start) + block + template.slice(end));
}
console.log(`preview: ${values.with}: ${prisms.length} solids → ${values.out}`);
