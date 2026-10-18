// SPDX-License-Identifier: MPL-2.0
// Building plans (Track P's P.01, docs/svg-plans.md): the SVG is read without a browser (transforms,
// straight paths, entities; a curve refused with where it is); a plan reads into metres with every
// problem at once; a wall breaks around its openings (a window's sill and lintel, a door's lintel
// alone) into solids as well as faces; a rectangular slab is a box and any other a triangle mesh;
// light is baked into the vertex colours, darker where a wall stands between a light and a face.
// The docking bay builds to the same bytes every time, as committed, and the world format's
// validator and the host tool's converter take it with no warning, within the budgets.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGltf, validateWorld } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { buildPlan, earClip, planSolids } from '../src/plan/build.ts';
import { readPlan } from '../src/plan/plan.ts';
import { parseSvg, PlanError, shapeOf, transformOf } from '../src/plan/svg.ts';
import { convertWorld, readFolder } from '../src/world.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BAY = join(ROOT, 'kits', 'worlds', 'docking-bay');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const plan = (floors: string, attrs = 'data-flatchat-plan="1"'): string => `<?xml version="1.0"?><!-- a test --><svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${floors}</svg>`;
const room = (more = ''): string =>
  plan(`<g class="floor" data-height="3">
    <rect class="slab" x="0" y="0" width="10" height="8"/>
    <polygon class="wall" points="0,0 10,0 10,8 0,8" data-thickness="0.2"/>
    <circle class="spawn" cx="5" cy="4" r="0.2"/>${more}</g>`);

describe('the SVG a plan is written in', () => {
  it('reads elements, attributes and entities, skipping comments and declarations', () => {
    const svg = parseSvg('<?xml version="1.0"?><!DOCTYPE svg><svg a="1 &amp; 2"><!-- note --><g><rect x="1"/></g><![CDATA[ x ]]></svg>');
    expect(svg.attrs['a']).toBe('1 & 2');
    expect(svg.children[0]!.children[0]).toMatchObject({ name: 'rect', attrs: { x: '1' } });
    expect(() => parseSvg('<svg><g></svg>')).toThrow(PlanError);
  });

  it('applies transforms and draws straight paths, refusing curves', () => {
    const m = transformOf('translate(10, 0) rotate(90)', 'test');
    const line = shapeOf(parseSvg('<svg><line x1="0" y1="0" x2="1" y2="0"/></svg>').children[0]!, m, 'line')!;
    expect(line.points.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])).toEqual([[10, 0], [10, 1]]);
    const path = shapeOf(parseSvg('<svg><path d="M0 0 H4 v3 L0,3 Z"/></svg>').children[0]!, transformOf(undefined, ''), 'path')!;
    expect(path).toMatchObject({ points: [[0, 0], [4, 0], [4, 3], [0, 3]], closed: true });
    expect(() => shapeOf(parseSvg('<svg><path d="M0 0 C1 1 2 2 3 3"/></svg>').children[0]!, transformOf(undefined, ''), 'the arc')).toThrow(/the arc: a plan is straight lines/);
  });
});

describe('a plan', () => {
  it('reads into metres, floor by floor, its floors’ attributes the defaults', () => {
    const p = readPlan(plan('<g class="floor" data-elevation="2" data-height="4" data-material="hull"><rect class="slab" x="0" y="0" width="100" height="50"/><line class="wall" x1="0" y1="0" x2="100" y2="0"/><circle class="spawn" cx="50" cy="25" r="1" data-facing="90"/></g>', 'data-flatchat-plan="1" data-scale="0.1" data-name="Hut"'));
    expect(p).toMatchObject({ name: 'Hut', scale: 0.1 });
    expect(p.floors[0]).toMatchObject({ elevation: 2, height: 4, slabs: [{ ring: [[0, 0], [10, 0], [10, 5], [0, 5]], material: 'hull' }], walls: [{ path: [[0, 0], [10, 0]], height: 4, material: 'hull' }], spawns: [{ at: [5, 2.5], facing: 90 }] });
  });

  it('reports every problem at once', () => {
    try {
      readPlan(plan('<rect class="wall" x="0" y="0" width="1" height="1"/><g class="floor"><polyline class="slab" points="0,0 1,0"/><circle class="prop" cx="1" cy="1" r="1"/></g>'));
      throw new Error('it read');
    } catch (err) {
      const problems = (err as PlanError).problems.join(' | ');
      expect(problems).toMatch(/sit inside a floor layer/);
      expect(problems).toMatch(/a slab is a closed shape/);
      expect(problems).toMatch(/a prop names its base part/);
      expect(problems).toMatch(/a spawn point at least/);
    }
    expect(() => readPlan('<svg></svg>')).toThrow(/no plan/);
  });
});

describe('building a plan', () => {
  it('breaks a wall round its openings, into faces and solids', () => {
    // A window (sill 1, head 2) in the north wall, a door (no sill, head 2.2) in the south wall.
    const built = (more: string): number => buildPlan(readPlan(room(more)), 'room').solids;
    const plain = built('');
    // The window cuts one wall piece into two, with a sill and a lintel: three solids more.
    expect(built('<line class="opening" x1="3" y1="0" x2="5" y2="0" data-sill="1" data-head="2"/>')).toBe(plain + 3);
    // A door has no sill: two more.
    expect(built('<line class="opening" x1="4" y1="8" x2="5" y2="8" data-head="2.2"/>')).toBe(plain + 2);
    const solids = planSolids(readPlan(room('<line class="opening" x1="3" y1="0" x2="5" y2="0" data-sill="1" data-head="2"/>')));
    const north = solids.boxes.filter((b) => Math.abs(b.centre[2]) < 1e-9 && b.kind === 'wall');
    // The sill runs 0 to 1 m, the lintel 2 to 3 m, both 2 m long over the opening.
    expect(north.filter((b) => Math.abs(b.half[0] - 1) < 1e-9).map((b) => [b.centre[1] - b.half[1], b.centre[1] + b.half[1]]).sort()).toEqual([[0, 1], [2, 3]]);
  });

  it('makes a rectangular slab a box and any other a triangle mesh', () => {
    const gltf = (svg: string): Record<string, unknown> => readGltf(buildPlan(readPlan(svg), 'x').glb, 'x.glb').json as unknown as Record<string, unknown>;
    const shapes = (svg: string): string[] => ((gltf(svg)['extensions'] as { OMI_physics_shape: { shapes: Array<{ type: string }> } }).OMI_physics_shape.shapes).map((s) => s.type);
    expect(shapes(room())).not.toContain('trimesh');
    const ell = plan('<g class="floor"><polygon class="slab" points="0,0 6,0 6,2 2,2 2,6 0,6"/><circle class="spawn" cx="1" cy="1" r="0.1"/></g>');
    expect(shapes(ell)).toContain('trimesh');
    // Ear clipping covers the L's whole area.
    const area = earClip([[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]).reduce((n, [a, b, c]) => n + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2, 0);
    expect(area).toBeCloseTo(20, 9);
  });

  it('bakes the light into the vertex colours, with the walls’ shadows', () => {
    // A light in one half of a room cut by a wall: the floor beyond the wall stays at the ambient.
    const svg = room('<line class="wall" x1="5" y1="0" x2="5" y2="8"/><circle class="light" cx="2.5" cy="4" r="0.1" data-y="2" data-intensity="1" data-range="12"/>');
    const json = readGltf(buildPlan(readPlan(svg), 'r').glb, 'r.glb');
    const g = json.json as unknown as { meshes: Array<{ name: string; primitives: Array<{ attributes: Record<string, number> }> }>; accessors: Array<{ bufferView: number; count: number }>; bufferViews: Array<{ byteOffset: number }> };
    const deck = g.meshes.find((m) => m.name === 'deck')!.primitives[0]!.attributes;
    const read = (a: number, n: number): Float32Array => {
      const acc = g.accessors[a]!;
      const view = g.bufferViews[acc.bufferView]!;
      return new Float32Array(json.bin!.buffer.slice(json.bin!.byteOffset + view.byteOffset, json.bin!.byteOffset + view.byteOffset + acc.count * n * 4));
    };
    const pos = read(deck['POSITION']!, 3);
    const col = read(deck['COLOR_0']!, 3);
    const at = (x: number, z: number): number => {
      let best = 0;
      let d = Infinity;
      for (let v = 0; v < pos.length / 3; v++) {
        const e = Math.hypot(pos[v * 3]! - x, pos[v * 3 + 2]! - z);
        if (e < d) [d, best] = [e, v];
      }
      return col[best * 3]!;
    };
    expect(at(2.5, 4)).toBeGreaterThan(0.6);
    expect(at(8, 4)).toBeCloseTo(0.28, 2);
  });
});

describe('the docking bay', () => {
  const bay = readPlan(readFileSync(join(BAY, 'plan.svg'), 'utf8'));

  it('builds to the same bytes every time, as committed', () => {
    const a = buildPlan(bay, 'docking-bay');
    const b = buildPlan(bay, 'docking-bay');
    expect(sha(a.glb)).toBe(sha(b.glb));
    expect(sha(new Uint8Array(readFileSync(join(BAY, 'scenes', 'docking-bay.glb'))))).toBe(sha(a.glb));
    expect(readFileSync(join(BAY, 'world.toml'), 'utf8')).toBe(a.worldToml);
    // A low-poly room: under 20,000 triangles, in a dozen draw calls at most.
    expect(a.triangles).toBeLessThan(20_000);
    expect(a.materials).toBeLessThanOrEqual(12);
    expect(a.parts).toBe(11);
  });

  it('passes the world format and converts with no warning', async () => {
    const files = readFolder(BAY);
    expect(validateWorld(files)).toMatchObject({ ok: true, problems: [] });
    const { world, warnings, out } = await convertWorld(files, { ktx2: false });
    expect(warnings).toEqual([]);
    expect(world.scenes[0]!.spawns.map((s) => s.title).sort()).toEqual(['The deck', 'The mezzanine']);
    expect(out.size).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
