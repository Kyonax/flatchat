// SPDX-License-Identifier: MPL-2.0
// A building plan (Track P's P.01, dp-007, docs/svg-plans.md): a semantic SVG, a layer per floor,
// whose shapes say what they are by their class and data- attributes. Read here into metres: the
// page's x is the world's x and its y the world's z (down the page is +z, so up the page is the way
// a spawned player faces at 0°); heights, thicknesses and elevations are metres already. A
// floor's own attributes are its shapes' defaults. Every problem is reported at once, with the
// element it is about.
import { IDENTITY2, type Matrix2, multiply2, numbers, parseSvg, PlanError, shapeOf, type SvgElement, transformOf } from './svg.ts';

export type P2 = [number, number];

export interface Slab {
  ring: P2[];
  material: string;
  /** Its top, above the floor's elevation, and how thick it is below that. */
  top: number;
  thickness: number;
}

export interface Wall {
  path: P2[];
  closed: boolean;
  thickness: number;
  height: number;
  material: string;
}

export interface Opening {
  a: P2;
  b: P2;
  /** Its bottom and top, above the floor. */
  sill: number;
  head: number;
}

export interface Stairs {
  /** The flight's footprint: its four corners. */
  ring: P2[];
  /** The way up, as a unit vector on the page, and how high it climbs. */
  up: P2;
  rise: number;
  steps: number;
  material: string;
}

export interface Strip {
  path: P2[];
  closed: boolean;
  /** Its middle above the floor, and its own height. */
  y: number;
  size: number;
  colour: [number, number, number];
}

export interface Prop {
  at: P2;
  part: string;
  /** Degrees clockwise on the page (the part's front faces up the page at 0). */
  rotate: number;
  y: number;
}

export interface Light {
  at: P2;
  y: number;
  colour: [number, number, number];
  intensity: number;
  range: number;
}

export interface Spawn {
  at: P2;
  facing: number;
  title: string;
  group: string;
}

export interface Floor {
  id: string;
  elevation: number;
  height: number;
  slabs: Slab[];
  walls: Wall[];
  openings: Opening[];
  stairs: Stairs[];
  strips: Strip[];
  props: Prop[];
  lights: Light[];
  spawns: Spawn[];
}

export interface Plan {
  name: string;
  description: string;
  /** Metres to one unit of the page. */
  scale: number;
  floors: Floor[];
}

/** sRGB #rrggbb as linear RGB. */
export function linearColour(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return fallback;
  const v = parseInt(m[1]!, 16);
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [lin(((v >> 16) & 255) / 255), lin(((v >> 8) & 255) / 255), lin((v & 255) / 255)];
}

const KINDS = ['slab', 'wall', 'opening', 'stairs', 'strip', 'prop', 'light', 'spawn'] as const;
type Kind = (typeof KINDS)[number];

/** Reads a plan from its SVG text. */
export function readPlan(text: string): Plan {
  const svg = parseSvg(text);
  if (svg.attrs['data-flatchat-plan'] !== '1') throw new PlanError(['the <svg> is no plan: give it data-flatchat-plan="1" (docs/svg-plans.md)']);
  const scale = numbers(svg.attrs['data-scale'])[0] ?? 1;
  const problems: string[] = [];
  if (!(scale > 0)) problems.push('data-scale is metres to one unit of the page, above 0');
  const plan: Plan = { name: svg.attrs['data-name'] ?? 'A plan', description: svg.attrs['data-description'] ?? '', scale, floors: [] };
  const toWorld = (p: P2): P2 => [p[0] * scale, p[1] * scale];
  const label = (el: SvgElement): string => `<${el.name}${el.attrs['id'] ? ` id="${el.attrs['id']}"` : ''}${el.attrs['class'] ? ` class="${el.attrs['class']}"` : ''}>`;

  const visit = (el: SvgElement, m: Matrix2, floor: Floor | undefined, defaults: Record<string, string>): void => {
    const here = multiply2(m, transformOf(el.attrs['transform'], label(el)));
    const classes = (el.attrs['class'] ?? '').split(/\s+/);
    if (el.name === 'g' && classes.includes('floor')) {
      if (floor) problems.push(`${label(el)}: a floor inside a floor`);
      const n = (k: string, d: number): number => numbers(el.attrs[k])[0] ?? d;
      const f: Floor = { id: el.attrs['id'] ?? `floor-${plan.floors.length}`, elevation: n('data-elevation', 0), height: n('data-height', 3), slabs: [], walls: [], openings: [], stairs: [], strips: [], props: [], lights: [], spawns: [] };
      plan.floors.push(f);
      const own = Object.fromEntries(Object.entries(el.attrs).filter(([k]) => k.startsWith('data-') && k !== 'data-elevation' && k !== 'data-height'));
      for (const c of el.children) visit(c, here, f, { ...defaults, ...own });
      return;
    }
    const kind = KINDS.find((k) => classes.includes(k)) as Kind | undefined;
    if (!kind) {
      for (const c of el.children) visit(c, here, floor, defaults);
      return;
    }
    if (!floor) {
      problems.push(`${label(el)}: a plan's shapes sit inside a floor layer (<g class="floor">)`);
      return;
    }
    let shape;
    try {
      shape = shapeOf(el, here, label(el));
    } catch (err) {
      problems.push(...(err instanceof PlanError ? err.problems : [String(err)]));
      return;
    }
    if (!shape) {
      problems.push(`${label(el)}: a ${kind} is drawn as a rect, line, polyline, polygon, path or circle`);
      return;
    }
    const attr = (k: string): string | undefined => el.attrs[k] ?? defaults[k];
    const num = (k: string, d: number): number => numbers(attr(k))[0] ?? d;
    const pts = shape.points.map(toWorld);
    switch (kind) {
      case 'slab':
        if (!shape.closed || pts.length < 3) problems.push(`${label(el)}: a slab is a closed shape of three corners or more`);
        else floor.slabs.push({ ring: pts, material: attr('data-material') ?? 'deck', top: num('data-top', 0), thickness: num('data-thickness', 0.2) });
        break;
      case 'wall':
        if (pts.length < 2) problems.push(`${label(el)}: a wall is a line of two points or more`);
        else floor.walls.push({ path: pts, closed: shape.closed, thickness: num('data-thickness', 0.2), height: num('data-wall-height', floor.height), material: attr('data-material') ?? 'panel' });
        break;
      case 'opening':
        if (pts.length !== 2) problems.push(`${label(el)}: an opening is a line along a wall, its two ends`);
        else floor.openings.push({ a: pts[0]!, b: pts[1]!, sill: num('data-sill', 0), head: num('data-head', 2.4) });
        break;
      case 'stairs': {
        if (!shape.closed || pts.length !== 4) {
          problems.push(`${label(el)}: stairs are a rect (or four corners)`);
          break;
        }
        const up = ((num('data-up', 0) - 90) * Math.PI) / 180;
        const rise = num('data-rise', floor.height);
        floor.stairs.push({ ring: pts, up: [Math.cos(up), Math.sin(up)], rise, steps: Math.max(1, Math.round(num('data-steps', Math.ceil(rise / 0.2)))), material: attr('data-material') ?? 'deck' });
        break;
      }
      case 'strip':
        floor.strips.push({ path: pts, closed: shape.closed, y: num('data-y', 2.6), size: num('data-size', 0.08), colour: linearColour(attr('data-colour'), [0.2, 0.9, 1]) });
        break;
      case 'prop':
        floor.props.push({ at: pts[0]!, part: attr('data-part') ?? '', rotate: num('data-rotate', 0), y: num('data-y', 0) });
        if (!attr('data-part')) problems.push(`${label(el)}: a prop names its base part (data-part)`);
        break;
      case 'light':
        floor.lights.push({ at: pts[0]!, y: num('data-y', floor.height - 0.4), colour: linearColour(attr('data-colour'), [1, 1, 1]), intensity: num('data-intensity', 1), range: num('data-range', 8) });
        break;
      case 'spawn':
        floor.spawns.push({ at: pts[0]!, facing: num('data-facing', 0), title: attr('data-title') ?? 'Arrival', group: attr('data-group') ?? 'start' });
        break;
    }
  };
  for (const c of svg.children) visit(c, IDENTITY2, undefined, {});
  if (plan.floors.length === 0) problems.push('a plan has a floor layer at least (<g class="floor">)');
  if (!plan.floors.some((f) => f.spawns.length > 0)) problems.push('a plan has a spawn point at least (class="spawn")');
  if (problems.length) throw new PlanError(problems);
  return plan;
}
