// SPDX-License-Identifier: Apache-2.0
// Creator shaders (S6.03, Q-M12, T-01, cl-007, DR-01): a material's look as a data-only node graph,
// never code from strangers. A graph is a list of nodes, each an operation from a fixed table with
// typed inputs; the client turns it into three.js node materials (TSL), which three compiles for
// WebGPU or WebGL2. What a graph cannot do is the safety:
//   - no loops and no recursion: the nodes form a graph without cycles, so nothing runs forever;
//   - bounded size: at most 128 nodes, 48 deep, 8 texture reads, so no compile bomb and no fetch storm;
//   - no NaN: every operation is safe over its whole domain (a division by nearly zero, a root or a
//     power of a negative number, normalising a zero vector) and every output is clamped, so a NaN
//     or an infinity cannot reach the screen;
//   - no raw clock: time enters only through oscillators of at most 2 Hz, so a graph cannot strobe
//     at the frame rate (it can still pulse; the trust shields and the safe-mode key are for the
//     rest, as T-01 accepted);
//   - its own mesh only: outputs are a surface's colour, glow and opacity, never vertex positions or
//     anything drawn outside the avatar.
// Every graph also needs its material's own look as a fallback (the glTF material's PBR or MToon),
// which strangers, the low tier, safe mode and a session after a GPU reset see instead (T-01). The
// cost of a graph is counted from its operations, statically, and feeds the avatar's rank.

export const SHADER_FORMAT = 1;
/** The glTF material extension that carries a graph. */
export const SHADER_EXTENSION = 'FLATCHAT_shader';

export const SHADER_LIMITS = {
  nodes: 128,
  depth: 48,
  textures: 8,
  oscillators: 2,
  /** An oscillator's highest frequency. */
  hz: 2,
  /** One graph's cost at most (refused above), and an avatar's graphs together. */
  cost: 400,
  avatarCost: 800,
  /** The brightest a glow may be (colour values above 1 bloom on an HDR target). */
  emissive: 2,
  /** A graph's JSON, in bytes. */
  bytes: 64 * 1024,
} as const;

export type ShaderType = 'float' | 'vec2' | 'vec3' | 'vec4';
const WIDTH: Record<ShaderType, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
const OF_WIDTH: Record<number, ShaderType> = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' };

/** One node: its id, its operation, and its inputs (other nodes' ids, or literal numbers). */
export interface ShaderNode {
  id: string;
  op: ShaderOp;
  /** Inputs by name: a node id, a number, or a vector of 2 to 4 numbers. */
  in: Record<string, string | number | number[]>;
  /** Parameters fixed by the creator (a texture's index, an oscillator's frequency and shape...). */
  with?: Record<string, string | number>;
}

export interface ShaderGraph {
  format: typeof SHADER_FORMAT;
  nodes: ShaderNode[];
  /** What the graph sets: the surface's colour (vec3 or vec4), glow (vec3), opacity (float). */
  out: { color?: string; emissive?: string; opacity?: string };
}

/** How each operation reads and what it costs (a rough count of GPU work: a texture read 4, noise 10). */
interface OpSpec {
  inputs: readonly string[];
  /** Inputs that may be left out. */
  optional?: readonly string[];
  cost: number;
  /** The output type from the inputs' types; undefined when they do not fit. */
  type: (t: Record<string, ShaderType>, w: Record<string, string | number>) => ShaderType | undefined;
  /** Parameters and their check. */
  params?: Record<string, (v: unknown) => boolean>;
}

const same = (t: Record<string, ShaderType>, names: readonly string[]): ShaderType | undefined => {
  // Floats spread over vectors; two vectors must match.
  let out: ShaderType = 'float';
  for (const n of names) {
    const v = t[n];
    if (!v) return undefined;
    if (v === 'float') continue;
    if (out !== 'float' && out !== v) return undefined;
    out = v;
  }
  return out;
};
const unary: OpSpec = { inputs: ['a'], cost: 1, type: (t) => t['a'] };
const binary: OpSpec = { inputs: ['a', 'b'], cost: 1, type: (t) => same(t, ['a', 'b']) };
const vector = (t: ShaderType | undefined): boolean => t !== undefined && t !== 'float';

export const SHADER_OPS = {
  // Inputs from the surface and the scene.
  uv: { inputs: [], cost: 1, type: () => 'vec2' },
  normal: { inputs: [], cost: 1, type: () => 'vec3' },
  position: { inputs: [], cost: 1, type: () => 'vec3' },
  viewDir: { inputs: [], cost: 1, type: () => 'vec3' },
  fresnel: { inputs: [], optional: ['power'], cost: 4, type: (t) => (t['power'] === undefined || t['power'] === 'float' ? 'float' : undefined) },
  // Time, only as a slow oscillation between 0 and 1.
  oscillate: { inputs: [], cost: 2, type: () => 'float', params: { hz: (v) => typeof v === 'number' && v >= 0 && v <= SHADER_LIMITS.hz, shape: (v) => v === undefined || v === 'sine' || v === 'triangle' || v === 'saw' || v === 'square' } },
  // A texture of the material's own (by its index in the material's list), at a uv.
  texture: { inputs: ['uv'], cost: 4, type: (t) => (t['uv'] === 'vec2' ? 'vec4' : undefined), params: { texture: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < SHADER_LIMITS.textures } },
  noise: { inputs: ['p'], cost: 10, type: (t) => (t['p'] === 'vec2' || t['p'] === 'vec3' ? 'float' : undefined) },
  // Arithmetic, each safe over its whole domain.
  add: binary,
  sub: binary,
  mul: binary,
  div: { ...binary, cost: 2 },
  min: binary,
  max: binary,
  pow: { ...binary, cost: 3 },
  step: binary,
  sin: unary,
  cos: unary,
  abs: unary,
  fract: unary,
  floor: unary,
  sqrt: { ...unary, cost: 2 },
  saturate: unary,
  oneMinus: unary,
  negate: unary,
  mix: { inputs: ['a', 'b', 't'], cost: 2, type: (t) => same(t, ['a', 'b', 't']) },
  clamp: { inputs: ['x', 'lo', 'hi'], cost: 2, type: (t) => same(t, ['x', 'lo', 'hi']) },
  smoothstep: { inputs: ['e0', 'e1', 'x'], cost: 3, type: (t) => same(t, ['e0', 'e1', 'x']) },
  dot: { inputs: ['a', 'b'], cost: 2, type: (t) => (vector(t['a']) && t['a'] === t['b'] ? 'float' : undefined) },
  length: { inputs: ['a'], cost: 2, type: (t) => (vector(t['a']) ? 'float' : undefined) },
  normalize: { inputs: ['a'], cost: 3, type: (t) => (vector(t['a']) ? t['a'] : undefined) },
  // Taking vectors apart and putting them together.
  split: { inputs: ['a'], cost: 0, type: (t, w) => (vector(t['a']) && typeof w['c'] === 'string' && 'xyzw'.slice(0, WIDTH[t['a']!]).includes(w['c']) && w['c'].length === 1 ? 'float' : undefined), params: { c: (v) => v === 'x' || v === 'y' || v === 'z' || v === 'w' } },
  combine: { inputs: ['x', 'y'], optional: ['z', 'w'], cost: 0, type: (t) => (['x', 'y', 'z', 'w'].every((k) => t[k] === undefined || t[k] === 'float') ? OF_WIDTH[['x', 'y', 'z', 'w'].filter((k) => t[k]).length] : undefined) },
} as const satisfies Record<string, OpSpec>;

export type ShaderOp = keyof typeof SHADER_OPS;

/** A graph as checked: its nodes in an order where every input comes first, each with its type. */
export interface CheckedGraph {
  graph: ShaderGraph;
  order: string[];
  types: Record<string, ShaderType>;
  cost: number;
  textures: number[];
  depth: number;
}

export class ShaderGraphError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

const ID = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const literalType = (v: unknown): ShaderType | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e6 ? 'float' : undefined;
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e6)) return OF_WIDTH[v.length];
  return undefined;
};

/** Reads and checks a graph from anywhere (a creator's file, a converted avatar): every problem at
 *  once. A graph that passes compiles in the client, by construction. */
export function checkShaderGraph(value: unknown): CheckedGraph {
  const problems: string[] = [];
  const g = (typeof value === 'object' && value !== null ? value : {}) as Partial<ShaderGraph>;
  if (JSON.stringify(value ?? null).length > SHADER_LIMITS.bytes) throw new ShaderGraphError([`a shader graph is ${SHADER_LIMITS.bytes / 1024} KB at most`]);
  if (g.format !== SHADER_FORMAT) problems.push(`a shader graph is format ${SHADER_FORMAT}`);
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  if (nodes.length === 0) problems.push('a shader graph has nodes');
  if (nodes.length > SHADER_LIMITS.nodes) throw new ShaderGraphError([`a shader graph has ${SHADER_LIMITS.nodes} nodes at most`]);
  const byId = new Map<string, ShaderNode>();
  for (const [i, n] of nodes.entries()) {
    if (typeof n !== 'object' || n === null || typeof n.id !== 'string' || !ID.test(n.id)) {
      problems.push(`node ${i} needs an id of letters, digits and _`);
      continue;
    }
    if (byId.has(n.id)) problems.push(`node id ${n.id} is used twice`);
    if (!(typeof n.op === 'string' && Object.hasOwn(SHADER_OPS, n.op))) problems.push(`${n.id}: no operation named ${JSON.stringify(n.op)}`);
    byId.set(n.id, n);
  }
  if (problems.length) throw new ShaderGraphError(problems);
  // Every input known, in an order where each comes before its users (no cycles: nothing loops).
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const depthOf = new Map<string, number>();
  const visit = (id: string, from: string, level: number): number => {
    const s = state.get(id);
    if (s === 'done') return depthOf.get(id)!;
    if (s === 'visiting') throw new ShaderGraphError([`${from} feeds back into itself through ${id}: a shader graph has no cycles`]);
    if (level > SHADER_LIMITS.depth) throw new ShaderGraphError([`the graph is deeper than ${SHADER_LIMITS.depth} nodes`]);
    const n = byId.get(id);
    if (!n) throw new ShaderGraphError([`${from} reads ${id}, which is not a node`]);
    state.set(id, 'visiting');
    let deepest = 0;
    for (const v of Object.values(typeof n.in === 'object' && n.in !== null ? n.in : {})) if (typeof v === 'string') deepest = Math.max(deepest, visit(v, id, level + 1));
    state.set(id, 'done');
    depthOf.set(id, deepest + 1);
    order.push(id);
    return deepest + 1;
  };
  const outs = typeof g.out === 'object' && g.out !== null ? g.out : {};
  for (const key of Object.keys(outs)) if (key !== 'color' && key !== 'emissive' && key !== 'opacity') problems.push(`no output named ${key}: color, emissive or opacity`);
  const outIds = (['color', 'emissive', 'opacity'] as const).map((k) => outs[k]).filter((v): v is string => typeof v === 'string');
  if (outIds.length === 0) problems.push('a shader graph sets at least one of color, emissive and opacity');
  if (problems.length) throw new ShaderGraphError(problems);
  let depth = 0;
  for (const id of outIds) depth = Math.max(depth, visit(id, 'out', 1));
  // Types, parameters and the cost, in order.
  const types: Record<string, ShaderType> = {};
  let cost = 0;
  let oscillators = 0;
  const textures = new Set<number>();
  let reads = 0;
  for (const id of order) {
    const n = byId.get(id)!;
    const spec = SHADER_OPS[n.op] as OpSpec;
    const ins = (typeof n.in === 'object' && n.in !== null ? n.in : {}) as Record<string, unknown>;
    const w = (typeof n.with === 'object' && n.with !== null ? n.with : {}) as Record<string, string | number>;
    const t: Record<string, ShaderType> = {};
    for (const name of Object.keys(ins)) if (!spec.inputs.includes(name) && !(spec.optional ?? []).includes(name)) problems.push(`${id}: ${n.op} has no input ${name}`);
    for (const name of [...spec.inputs, ...(spec.optional ?? [])]) {
      const v = ins[name];
      if (v === undefined) {
        if (spec.inputs.includes(name)) problems.push(`${id}: ${n.op} needs its input ${name}`);
        continue;
      }
      const ty = typeof v === 'string' ? types[v] : literalType(v);
      if (!ty) problems.push(`${id}: input ${name} is not a node or a number (or 2 to 4 numbers) within ±1e6`);
      else t[name] = ty;
    }
    for (const [p, ok] of Object.entries(spec.params ?? {})) if (!ok(w[p])) problems.push(`${id}: ${n.op}'s ${p} ${p === 'hz' ? `is 0 to ${SHADER_LIMITS.hz}` : 'is not one it takes'}`);
    for (const p of Object.keys(w)) if (!(p in (spec.params ?? {}))) problems.push(`${id}: ${n.op} takes no ${p}`);
    const out = spec.type(t, w);
    if (!out) {
      problems.push(`${id}: ${n.op}'s inputs do not fit (${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
      continue;
    }
    types[id] = out;
    cost += spec.cost;
    if (n.op === 'oscillate') oscillators += 1;
    if (n.op === 'texture') {
      reads += 1;
      textures.add(w['texture'] as number);
    }
  }
  if (oscillators > SHADER_LIMITS.oscillators) problems.push(`${oscillators} oscillators: ${SHADER_LIMITS.oscillators} at most`);
  if (reads > SHADER_LIMITS.textures) problems.push(`${reads} texture reads: ${SHADER_LIMITS.textures} at most`);
  if (cost > SHADER_LIMITS.cost) problems.push(`the graph costs ${cost}: ${SHADER_LIMITS.cost} at most`);
  const want: Record<string, readonly ShaderType[]> = { color: ['vec3', 'vec4'], emissive: ['vec3'], opacity: ['float'] };
  for (const [key, id] of Object.entries(outs)) if (typeof id === 'string' && types[id] && !want[key]!.includes(types[id]!)) problems.push(`out ${key} is ${want[key]!.join(' or ')}, not ${types[id]}`);
  if (problems.length) throw new ShaderGraphError(problems);
  return { graph: { format: SHADER_FORMAT, nodes: nodes.filter((n) => state.get(n.id) === 'done'), out: Object.fromEntries(Object.entries(outs).filter(([, v]) => typeof v === 'string')) }, order, types, cost, textures: [...textures].sort((a, b) => a - b), depth };
}

// ---------------------------------------------------------------- the semantics, as a reference

/** Every node's value stays within ±BOUND, component by component: float32 cannot overflow into an
 *  infinity, so nothing can make a NaN of one (infinity minus infinity). */
export const SHADER_BOUND = 1e6;
/** The smallest magnitude a divisor, a root's input or a vector's length is taken to have. */
export const SHADER_EPS = 1e-6;

/** What a graph reads from the surface, for the reference evaluator. */
export interface ShaderInputs {
  uv: [number, number];
  normal: [number, number, number];
  position: [number, number, number];
  viewDir: [number, number, number];
  /** Seconds since the client started. */
  time: number;
  /** A texture read: the material's texture `index` at `uv`, as RGBA in 0..1. */
  texture: (index: number, uv: [number, number]) => [number, number, number, number];
}

const f32 = Math.fround;
const bound = (v: number): number => f32(Math.min(SHADER_BOUND, Math.max(-SHADER_BOUND, v)));
const safeDiv = (a: number, b: number): number => a / (Math.abs(b) < SHADER_EPS ? (b < 0 ? -SHADER_EPS : SHADER_EPS) : b);
const safePow = (a: number, b: number): number => Math.pow(Math.max(a, SHADER_EPS), b);
const fract = (a: number): number => a - Math.floor(a);
/** An oscillator in 0..1: its shape at `hz` (2 at most). */
export function oscillation(shape: string, hz: number, time: number): number {
  const phase = fract(time * hz);
  if (shape === 'triangle') return 1 - Math.abs(phase * 2 - 1);
  if (shape === 'saw') return phase;
  if (shape === 'square') return phase < 0.5 ? 1 : 0;
  return 0.5 + 0.5 * Math.sin(phase * 2 * Math.PI);
}

/** A smooth value noise in 0..1 (the client draws MaterialX's noise; this stands in for tests). */
function noise(p: number[]): number {
  let h = 0;
  for (const [i, v] of p.entries()) h += Math.sin(v * (12.9898 + i * 65.233)) * 43758.5453;
  return fract(h);
}

type Value = number[];
const spread = (a: Value, n: number): Value => (a.length === 1 ? Array<number>(n).fill(a[0]!) : a);
const lanes = (...vs: Value[]): number => Math.max(...vs.map((v) => v.length));
const zip = (f: (...x: number[]) => number, ...vs: Value[]): Value => {
  const n = lanes(...vs);
  const s = vs.map((v) => spread(v, n));
  return Array.from({ length: n }, (_, i) => f(...s.map((v) => v[i]!)));
};

/** Evaluates a checked graph at one point with the platform's safe semantics: what the client's
 *  compiled shader computes (up to float precision and the noise). Its outputs are clamped as the
 *  client clamps them: colour and opacity to 0..1, glow to 0..SHADER_LIMITS.emissive. */
export function evaluateShaderGraph(c: CheckedGraph, at: ShaderInputs): { color?: number[]; emissive?: number[]; opacity?: number } {
  const byId = new Map(c.graph.nodes.map((n) => [n.id, n]));
  const val = new Map<string, Value>();
  const read = (v: string | number | number[]): Value => (typeof v === 'string' ? val.get(v)! : typeof v === 'number' ? [f32(v)] : v.map(f32));
  for (const id of c.order) {
    const n = byId.get(id)!;
    const i = (k: string): Value => read(n.in[k]!);
    const w = n.with ?? {};
    let out: Value;
    switch (n.op) {
      case 'uv': out = [...at.uv]; break;
      case 'normal': out = [...at.normal]; break;
      case 'position': out = [...at.position]; break;
      case 'viewDir': out = [...at.viewDir]; break;
      case 'fresnel': {
        const ndv = Math.abs(at.normal[0] * at.viewDir[0] + at.normal[1] * at.viewDir[1] + at.normal[2] * at.viewDir[2]);
        out = [safePow(1 - Math.min(1, ndv), n.in['power'] === undefined ? 5 : i('power')[0]!)];
        break;
      }
      case 'oscillate': out = [oscillation(String(w['shape'] ?? 'sine'), Number(w['hz']), at.time)]; break;
      case 'texture': { const uv = i('uv'); out = at.texture(Number(w['texture']), [uv[0]!, uv[1]!]); break; }
      case 'noise': out = [noise(i('p'))]; break;
      case 'add': out = zip((a, b) => a + b, i('a'), i('b')); break;
      case 'sub': out = zip((a, b) => a - b, i('a'), i('b')); break;
      case 'mul': out = zip((a, b) => a * b, i('a'), i('b')); break;
      case 'div': out = zip(safeDiv, i('a'), i('b')); break;
      case 'min': out = zip(Math.min, i('a'), i('b')); break;
      case 'max': out = zip(Math.max, i('a'), i('b')); break;
      case 'pow': out = zip(safePow, i('a'), i('b')); break;
      case 'step': out = zip((e, x) => (x < e ? 0 : 1), i('a'), i('b')); break;
      case 'sin': out = i('a').map(Math.sin); break;
      case 'cos': out = i('a').map(Math.cos); break;
      case 'abs': out = i('a').map(Math.abs); break;
      case 'fract': out = i('a').map(fract); break;
      case 'floor': out = i('a').map(Math.floor); break;
      case 'sqrt': out = i('a').map((a) => Math.sqrt(Math.max(a, 0))); break;
      case 'saturate': out = i('a').map((a) => Math.min(1, Math.max(0, a))); break;
      case 'oneMinus': out = i('a').map((a) => 1 - a); break;
      case 'negate': out = i('a').map((a) => -a); break;
      case 'mix': out = zip((a, b, t) => a + (b - a) * t, i('a'), i('b'), i('t')); break;
      case 'clamp': out = zip((x, lo, hi) => Math.min(Math.max(x, lo), hi), i('x'), i('lo'), i('hi')); break;
      case 'smoothstep': out = zip((e0, e1, x) => { const t = Math.min(1, Math.max(0, safeDiv(x - e0, e1 - e0))); return t * t * (3 - 2 * t); }, i('e0'), i('e1'), i('x')); break;
      case 'dot': { const a = i('a'); const b = i('b'); out = [a.reduce((s, x, k) => s + x * b[k]!, 0)]; break; }
      case 'length': out = [Math.hypot(...i('a'))]; break;
      case 'normalize': { const a = i('a'); const l = Math.max(Math.hypot(...a), SHADER_EPS); out = a.map((x) => x / l); break; }
      case 'split': out = [i('a')['xyzw'.indexOf(String(w['c']))]!]; break;
      case 'combine': out = ['x', 'y', 'z', 'w'].filter((k) => n.in[k] !== undefined).map((k) => i(k)[0]!); break;
    }
    val.set(id, out.map(bound));
  }
  const res: { color?: number[]; emissive?: number[]; opacity?: number } = {};
  if (c.graph.out.color) res.color = val.get(c.graph.out.color)!.map((x) => Math.min(1, Math.max(0, x)));
  if (c.graph.out.emissive) res.emissive = val.get(c.graph.out.emissive)!.map((x) => Math.min(SHADER_LIMITS.emissive, Math.max(0, x)));
  if (c.graph.out.opacity) res.opacity = Math.min(1, Math.max(0, val.get(c.graph.out.opacity)![0]!));
  return res;
}
