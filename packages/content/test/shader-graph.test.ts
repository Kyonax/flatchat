// SPDX-License-Identifier: Apache-2.0
// Creator shader graphs (S6.03's Verify): a graph that passes compiles, one that does not is refused
// with every reason; and 20 hostile graphs (endless loops, huge fetch counts, NaN storms, compile
// bombs, strobes) are either refused at upload or, by the safe semantics every node follows, give
// only finite values in range.
import { describe, expect, it } from 'vitest';
import { checkShaderGraph, evaluateShaderGraph, SHADER_LIMITS, type ShaderGraph, ShaderGraphError, type ShaderInputs } from '../src/shader-graph.ts';

/** A rim glow: the material's texture tinted, a fresnel rim that pulses at 0.5 Hz. */
const RIM: ShaderGraph = {
  format: 1,
  nodes: [
    { id: 'uv', op: 'uv', in: {} },
    { id: 'tex', op: 'texture', in: { uv: 'uv' }, with: { texture: 0 } },
    { id: 'rgb', op: 'combine', in: { x: 'r', y: 'g', z: 'b' } },
    { id: 'r', op: 'split', in: { a: 'tex' }, with: { c: 'x' } },
    { id: 'g', op: 'split', in: { a: 'tex' }, with: { c: 'y' } },
    { id: 'b', op: 'split', in: { a: 'tex' }, with: { c: 'z' } },
    { id: 'tint', op: 'mul', in: { a: 'rgb', b: [0.9, 0.95, 1] } },
    { id: 'rim', op: 'fresnel', in: { power: 3 } },
    { id: 'pulse', op: 'oscillate', in: {}, with: { hz: 0.5, shape: 'sine' } },
    { id: 'glowAmount', op: 'mul', in: { a: 'rim', b: 'pulse' } },
    { id: 'glow', op: 'mul', in: { a: [0.2, 0.8, 1], b: 'glowAmount' } },
  ],
  out: { color: 'tint', emissive: 'glow' },
};

const refusal = (g: unknown): string[] => {
  try {
    checkShaderGraph(g);
  } catch (err) {
    if (err instanceof ShaderGraphError) return err.problems;
    throw err;
  }
  return [];
};

/** A chain of `n` nodes, each feeding the next: x0 = uv.x, x(k) = op(x(k-1)). */
const chain = (n: number, op = 'sin'): ShaderGraph => ({
  format: 1,
  nodes: [{ id: 'uv', op: 'uv', in: {} }, { id: 'x0', op: 'split', in: { a: 'uv' }, with: { c: 'x' } }, ...Array.from({ length: n }, (_, k) => ({ id: `x${k + 1}`, op: op as 'sin', in: (op === 'noise' ? { p: 'uv' } : { a: `x${k}` }) as Record<string, string> }))],
  out: { opacity: `x${n}` },
});

/** Samples a graph's outputs over a grid of surfaces and times. */
function sweep(g: ShaderGraph): number[] {
  const c = checkShaderGraph(g);
  const values: number[] = [];
  for (const u of [-2, 0, 0.5, 1, 3]) {
    for (const time of [0, 0.25, 1.7, 1e5]) {
      const at: ShaderInputs = { uv: [u, -u], normal: [0, 0, u === 0 ? 0 : 1], position: [u * 1e3, 0, -u], viewDir: [0, 0, 1], time, texture: () => [u, 0.5, 1, 1] };
      const o = evaluateShaderGraph(c, at);
      values.push(...(o.color ?? []), ...(o.emissive ?? []), ...(o.opacity === undefined ? [] : [o.opacity]));
    }
  }
  return values;
}

describe('a creator shader graph', () => {
  it('checks a rim glow: its order, types, cost and textures', () => {
    const c = checkShaderGraph(RIM);
    expect(c.order.indexOf('tex')).toBeLessThan(c.order.indexOf('r'));
    expect(c.types).toMatchObject({ tex: 'vec4', rgb: 'vec3', tint: 'vec3', rim: 'float', glow: 'vec3' });
    expect(c.textures).toEqual([0]);
    expect(c.cost).toBe(1 + 4 + 0 + 0 + 0 + 0 + 1 + 4 + 2 + 1 + 1);
    const v = sweep(RIM);
    expect(v.every((x) => Number.isFinite(x) && x >= 0 && x <= SHADER_LIMITS.emissive)).toBe(true);
  });

  it('leaves out nodes that feed no output', () => {
    const c = checkShaderGraph({ ...RIM, nodes: [...RIM.nodes, { id: 'unused', op: 'noise', in: { p: 'uv' } }] });
    expect(c.graph.nodes.some((n) => n.id === 'unused')).toBe(false);
    expect(c.cost).toBe(checkShaderGraph(RIM).cost);
  });
});

describe('20 hostile graphs', () => {
  // Refused at upload: what would loop, explode, flood or strobe never reaches a client.
  it('1-2: an endless loop cannot be written: a cycle, or a node reading itself', () => {
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'sin', in: { a: 'b' } }, { id: 'b', op: 'sin', in: { a: 'a' } }], out: { opacity: 'a' } })).toEqual([expect.stringMatching(/no cycles/)]);
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'add', in: { a: 'a', b: 1 } }], out: { opacity: 'a' } })).toEqual([expect.stringMatching(/no cycles/)]);
  });

  it('3-4: a compile bomb is too big or too deep', () => {
    expect(refusal(chain(SHADER_LIMITS.nodes))).toEqual([expect.stringMatching(/128 nodes at most/)]);
    expect(refusal(chain(SHADER_LIMITS.depth + 1))).toEqual([expect.stringMatching(/deeper than 48/)]);
  });

  it('5-6: huge fetch counts and costs are refused', () => {
    const reads = Array.from({ length: 9 }, (_, k) => ({ id: `t${k}`, op: 'texture', in: { uv: 'uv' }, with: { texture: k % 8 } }));
    const sum = reads.slice(1).reduce<Array<{ id: string; op: string; in: Record<string, string> }>>((acc, r, k) => [...acc, { id: `s${k}`, op: 'add', in: { a: k === 0 ? 't0' : `s${k - 1}`, b: r.id } }], []);
    expect(refusal({ format: 1, nodes: [{ id: 'uv', op: 'uv', in: {} }, ...reads, ...sum], out: { color: `s${sum.length - 1}` } })).toEqual(expect.arrayContaining([expect.stringMatching(/9 texture reads: 8 at most/)]));
    // 41 noises summed: 41 × 10, 40 additions and the uv, 451.
    const noises = Array.from({ length: 41 }, (_, k) => ({ id: `n${k}`, op: 'noise', in: { p: 'uv' } }));
    const sums = noises.slice(1).map((n, k) => ({ id: `a${k}`, op: 'add', in: { a: k === 0 ? 'n0' : `a${k - 1}`, b: n.id } }));
    expect(refusal({ format: 1, nodes: [{ id: 'uv', op: 'uv', in: {} }, ...noises, ...sums], out: { opacity: 'a39' } })).toEqual([expect.stringMatching(/costs 451: 400 at most/)]);
  });

  it('7-8: a strobe cannot be made: three oscillators, or one over 2 Hz', () => {
    const osc = (k: number, hz = 1): { id: string; op: 'oscillate'; in: Record<string, never>; with: { hz: number } } => ({ id: `o${k}`, op: 'oscillate', in: {}, with: { hz } });
    expect(refusal({ format: 1, nodes: [osc(0), osc(1), osc(2), { id: 'm', op: 'mul', in: { a: 'o0', b: 'o1' } }, { id: 'n', op: 'mul', in: { a: 'm', b: 'o2' } }], out: { opacity: 'n' } })).toEqual([expect.stringMatching(/3 oscillators: 2 at most/)]);
    expect(refusal({ format: 1, nodes: [osc(0, 60)], out: { opacity: 'o0' } })).toEqual([expect.stringMatching(/hz is 0 to 2/)]);
  });

  it('9-11: no code, nothing undefined, no mismatched types', () => {
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'eval', in: { code: 'while(true){}' } }], out: { opacity: 'a' } })).toEqual([expect.stringMatching(/no operation named "eval"/)]);
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'sin', in: { a: 'missing' } }], out: { opacity: 'a' } })).toEqual([expect.stringMatching(/reads missing, which is not a node/)]);
    expect(refusal({ format: 1, nodes: [{ id: 'n', op: 'normal', in: {} }, { id: 'u', op: 'uv', in: {} }, { id: 'd', op: 'dot', in: { a: 'n', b: 'u' } }], out: { opacity: 'd' } })).toEqual([expect.stringMatching(/inputs do not fit/)]);
  });

  it('12-14: no out-of-range numbers, no oversized graph, no output outside the surface', () => {
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'add', in: { a: 1e300, b: 1 } }], out: { opacity: 'a' } })).toEqual(expect.arrayContaining([expect.stringMatching(/within ±1e6/)]));
    expect(refusal({ format: 1, nodes: [{ id: 'a', op: 'uv', in: {}, with: { pad: 'x'.repeat(70_000) } }], out: { color: 'a' } })).toEqual([expect.stringMatching(/64 KB at most/)]);
    expect(refusal({ format: 1, nodes: [{ id: 'p', op: 'position', in: {} }], out: { vertex: 'p' } })).toEqual(expect.arrayContaining([expect.stringMatching(/no output named vertex/)]));
  });

  // Accepted, and harmless by construction: NaN storms give finite values in range.
  const storm = (nodes: ShaderGraph['nodes'], out: ShaderGraph['out']): number[] => sweep({ format: 1, nodes: [{ id: 'uv', op: 'uv', in: {} }, { id: 'x', op: 'split', in: { a: 'uv' }, with: { c: 'x' } }, ...nodes], out });
  const sane = (v: number[]): boolean => v.length > 0 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= SHADER_LIMITS.emissive);

  it('15: dividing by zero', () => {
    expect(sane(storm([{ id: 'd', op: 'div', in: { a: 1, b: 0 } }, { id: 'e', op: 'div', in: { a: 'x', b: 'x' } }, { id: 'c', op: 'combine', in: { x: 'd', y: 'e', z: 0 } }], { color: 'c', emissive: 'c' }))).toBe(true);
  });

  it('16-17: roots and powers of negatives and of zero', () => {
    expect(sane(storm([{ id: 'r', op: 'sqrt', in: { a: -1 } }, { id: 'p', op: 'pow', in: { a: -2, b: 0.5 } }, { id: 'q', op: 'pow', in: { a: 0, b: -1 } }, { id: 'z', op: 'pow', in: { a: 0, b: 0 } }, { id: 'c', op: 'combine', in: { x: 'r', y: 'p', z: 'q' } }, { id: 'o', op: 'add', in: { a: 'z', b: 'q' } }], { color: 'c', opacity: 'o' }))).toBe(true);
  });

  it('18-19: normalising nothing, and a smoothstep with equal edges', () => {
    expect(sane(storm([{ id: 'n', op: 'normalize', in: { a: [0, 0, 0] } }, { id: 's', op: 'smoothstep', in: { e0: 0.5, e1: 0.5, x: 'x' } }], { emissive: 'n', opacity: 's' }))).toBe(true);
  });

  it('20: a chain of products that overflows float32, then subtracted from itself', () => {
    const muls = Array.from({ length: 10 }, (_, k) => ({ id: `m${k}`, op: 'mul' as const, in: { a: k === 0 ? 1e6 : `m${k - 1}`, b: 1e6 } }));
    expect(sane(storm([...muls, { id: 'd', op: 'sub', in: { a: 'm9', b: 'm9' } }, { id: 'inv', op: 'clamp', in: { x: 'x', lo: 1, hi: 0 } }, { id: 'c', op: 'combine', in: { x: 'd', y: 'inv', z: 'm9' } }], { color: 'c', opacity: 'd' }))).toBe(true);
  });
});
