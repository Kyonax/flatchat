// SPDX-License-Identifier: MPL-2.0
// The SVG a building plan is written in (Track P's P.01, docs/svg-plans.md), read without a
// browser: its elements with their attributes and children (comments, the XML declaration, a
// doctype and CDATA skipped; the five named entities and numeric ones decoded), and each shape's
// points in plan units with every transform above it applied. A plan is straight lines: rect, line,
// polyline, polygon, circle (a marker: its centre) and path with M, L, H, V and Z; a curve is
// refused, with where it is, so a plan never turns into something its author did not draw.

export interface SvgElement {
  name: string;
  attrs: Record<string, string>;
  children: SvgElement[];
}

export class PlanError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m)));

/** The document's root element (the `svg`). */
export function parseSvg(text: string): SvgElement {
  const root: SvgElement = { name: '#document', attrs: {}, children: [] };
  const stack: SvgElement[] = [root];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const end = text.indexOf('>', lt);
    if (end < 0) throw new PlanError([`an unclosed tag at character ${lt}`]);
    const tag = text.slice(lt + 1, end);
    i = end + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new PlanError([`</${name}> closes ${open ? `<${open.name}>` : 'nothing'}`]);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = body.match(/^\s*([^\s/>]+)/)?.[1] ?? '';
    const attrs: Record<string, string> = {};
    for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]!] = decode(m[3] ?? m[4] ?? '');
    const el: SvgElement = { name, attrs, children: [] };
    stack.at(-1)!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length > 1) throw new PlanError([`<${stack.at(-1)!.name}> is never closed`]);
  const svg = root.children.find((c) => c.name === 'svg');
  if (!svg) throw new PlanError(['the file has no <svg> element']);
  return svg;
}

/** A 2-D affine transform as SVG writes it: [a, b, c, d, e, f] maps (x, y) to (ax + cy + e, bx + dy + f). */
export type Matrix2 = [number, number, number, number, number, number];
export const IDENTITY2: Matrix2 = [1, 0, 0, 1, 0, 0];

export function multiply2(m: Matrix2, n: Matrix2): Matrix2 {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

export const apply2 = (m: Matrix2, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Numbers in an attribute (commas or spaces between, "px" allowed). */
export function numbers(s: string | undefined): number[] {
  return [...(s ?? '').matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].map((m) => Number(m[0]));
}

/** A `transform` attribute as one matrix: translate, rotate (about a point too), scale and matrix. */
export function transformOf(attr: string | undefined, where: string): Matrix2 {
  let m = IDENTITY2;
  for (const t of (attr ?? '').matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const kind = t[1]!;
    const n = numbers(t[2]);
    let next: Matrix2;
    if (kind === 'translate') next = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
    else if (kind === 'scale') next = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
    else if (kind === 'matrix' && n.length === 6) next = n as Matrix2;
    else if (kind === 'rotate') {
      const a = ((n[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
      next = multiply2(multiply2([1, 0, 0, 1, cx, cy], [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else throw new PlanError([`${where}: a transform plans cannot use (${kind})`]);
    m = multiply2(m, next);
  }
  return m;
}

/** A shape's points in plan units, transformed; `closed` for a ring (rect, polygon, path with Z). */
export interface Shape {
  points: Array<[number, number]>;
  closed: boolean;
  /** A circle's radius, for markers. */
  radius?: number;
}

/** The shape an element draws, if it draws one. */
export function shapeOf(el: SvgElement, m: Matrix2, where: string): Shape | undefined {
  const a = el.attrs;
  const num = (k: string): number => numbers(a[k])[0] ?? 0;
  const pts = (list: number[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let k = 0; k + 1 < list.length; k += 2) out.push(apply2(m, list[k]!, list[k + 1]!));
    return out;
  };
  switch (el.name) {
    case 'rect': {
      const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')];
      return { points: pts([x, y, x + w, y, x + w, y + h, x, y + h]), closed: true };
    }
    case 'line':
      return { points: pts([num('x1'), num('y1'), num('x2'), num('y2')]), closed: false };
    case 'polyline':
    case 'polygon':
      return { points: pts(numbers(a['points'])), closed: el.name === 'polygon' };
    case 'circle':
    case 'ellipse': {
      const r = el.name === 'circle' ? num('r') : (num('rx') + num('ry')) / 2;
      return { points: pts([num('cx'), num('cy')]), closed: false, radius: r * Math.hypot(m[0], m[1]) };
    }
    case 'path':
      return pathShape(a['d'] ?? '', m, where);
    default:
      return undefined;
  }
}

function pathShape(d: string, m: Matrix2, where: string): Shape {
  const tokens = [...d.matchAll(/([MmLlHhVvZzCcSsQqTtAa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g)].map((t) => t[1] ?? Number(t[2]));
  const points: Array<[number, number]> = [];
  let [x, y] = [0, 0];
  let [sx, sy] = [0, 0];
  let closed = false;
  let cmd = '';
  let k = 0;
  const next = (): number => {
    const v = tokens[k++];
    if (typeof v !== 'number') throw new PlanError([`${where}: a path's ${cmd} is missing a number`]);
    return v;
  };
  while (k < tokens.length) {
    if (typeof tokens[k] === 'string') cmd = tokens[k++] as string;
    else if (!cmd) throw new PlanError([`${where}: a path starts with a number`]);
    if (/[CcSsQqTtAa]/.test(cmd)) throw new PlanError([`${where}: a plan is straight lines (the path draws a curve, ${cmd})`]);
    if (cmd === 'Z' || cmd === 'z') {
      closed = true;
      [x, y] = [sx, sy];
      continue;
    }
    if (points.length > 0 && closed) throw new PlanError([`${where}: one ring to a path (draw another path for the next)`]);
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M':
        [x, y] = rel ? [x + next(), y + next()] : [next(), next()];
        if (points.length > 0) throw new PlanError([`${where}: one ring to a path (draw another path for the next)`]);
        [sx, sy] = [x, y];
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        [x, y] = rel ? [x + next(), y + next()] : [next(), next()];
        break;
      case 'H':
        x = rel ? x + next() : next();
        break;
      case 'V':
        y = rel ? y + next() : next();
        break;
    }
    points.push(apply2(m, x, y));
  }
  // A closed ring drawn back to its start keeps one copy of it.
  if (closed && points.length > 1) {
    const [a, b] = [points[0]!, points.at(-1)!];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) points.pop();
  }
  return { points, closed };
}
