// SPDX-License-Identifier: MPL-2.0
// A creator shader (S6.03) made into a three.js node material: each node of a checked graph
// (packages/content's shader-graph.ts) becomes TSL, with the platform's safe semantics, the same as
// evaluateShaderGraph's: a division by nearly zero, a root or a power of a negative number,
// normalising nothing, a smoothstep with equal edges, all defined; every node's value bounded to
// ±SHADER_BOUND so float32 never overflows; the outputs clamped. Each node is held in a variable, so
// the code three writes grows with the graph, never faster. three compiles it for WebGPU or WebGL2.
import { type CheckedGraph, SHADER_BOUND, SHADER_EPS, SHADER_LIMITS, type ShaderType } from '@flatchat/content';
import * as T from 'three/tsl';
import * as THREE from 'three/webgpu';

// TSL's TypeScript types follow each node's GLSL type as a generic; a graph's types are data, so
// the compiler holds every node as one loose kind and calls TSL through it.
interface N {
  mul(x: unknown): N;
  add(x: unknown): N;
  sub(x: unknown): N;
  toVar(): N;
  readonly rgb: N;
  readonly a: N;
}
type Fn = (...a: unknown[]) => N;
const t = T as unknown as Record<string, Fn> & { normalView: N; positionLocal: N; positionViewDirection: N; time: N };

const ofType = (n: N, from: ShaderType, to: ShaderType): N => (from === to || to === 'float' ? n : t[to]!(n));
const literal = (v: number | number[]): N => (typeof v === 'number' ? t['float']!(v) : t[['', '', 'vec2', 'vec3', 'vec4'][v.length]!]!(...v));
const typeOfLiteral = (v: number | number[]): ShaderType => (typeof v === 'number' ? 'float' : (['', '', 'vec2', 'vec3', 'vec4'][v.length] as ShaderType));

/** A divisor kept away from zero, keeping its sign (zero counts as positive). */
const safeDivisor = (b: N): N => t['max']!(t['abs']!(b), SHADER_EPS).mul(t['step']!(0, b).mul(2).sub(1));
const safeDiv = (a: N, b: N): N => t['div']!(a, safeDivisor(b));
const safePow = (a: N, b: N): N => t['pow']!(t['max']!(a, SHADER_EPS), b);

/** An oscillator in 0..1 at `hz`, the shapes evaluateShaderGraph's `oscillation` draws. */
function oscillator(shape: string, hz: number): N {
  // The clock wraps after an hour, so float32 keeps its precision.
  const phase = t['fract']!(t['mod']!(t.time, 3600).mul(Math.min(hz, SHADER_LIMITS.hz)));
  if (shape === 'triangle') return t['oneMinus']!(t['abs']!(phase.mul(2).sub(1)));
  if (shape === 'saw') return phase;
  if (shape === 'square') return t['step']!(phase, 0.5);
  return t['sin']!(phase.mul(2 * Math.PI)).mul(0.5).add(0.5);
}

/** The material a graph makes, over its fallback's look (side, transparency) and its textures. */
export function compileCreatorShader(c: CheckedGraph, textures: ReadonlyArray<THREE.Texture | undefined>, fallback: THREE.Material): THREE.MeshStandardNodeMaterial {
  const byId = new Map(c.graph.nodes.map((n) => [n.id, n]));
  const vals = new Map<string, N>();
  for (const id of c.order) {
    const n = byId.get(id)!;
    const out = c.types[id]!;
    const w = n.with ?? {};
    // An input, as the node's own type when it spreads a float over a vector.
    const raw = (k: string): { node: N; type: ShaderType } => {
      const v = n.in[k]!;
      return typeof v === 'string' ? { node: vals.get(v)!, type: c.types[v]! } : { node: literal(v), type: typeOfLiteral(v) };
    };
    const i = (k: string, to: ShaderType = out): N => {
      const r = raw(k);
      return ofType(r.node, r.type, to);
    };
    let v: N;
    switch (n.op) {
      case 'uv': v = t['uv']!(); break;
      case 'normal': v = t.normalView; break;
      case 'position': v = t.positionLocal; break;
      case 'viewDir': v = t.positionViewDirection; break;
      case 'fresnel': {
        const ndv = t['abs']!(t['dot']!(t.normalView, t.positionViewDirection));
        v = safePow(t['oneMinus']!(t['min']!(ndv, 1)), n.in['power'] === undefined ? t['float']!(5) : i('power', 'float'));
        break;
      }
      case 'oscillate': v = oscillator(String(w['shape'] ?? 'sine'), Number(w['hz'])); break;
      case 'texture': {
        const tex = textures[Number(w['texture'])];
        v = tex ? t['texture']!(tex, i('uv', 'vec2')) : t['vec4']!(1, 0, 1, 1);
        break;
      }
      case 'noise': v = t['saturate']!(t['mx_noise_float']!(raw('p').node).mul(0.5).add(0.5)); break;
      case 'div': v = safeDiv(i('a'), i('b')); break;
      case 'pow': v = safePow(i('a'), i('b')); break;
      case 'add': case 'sub': case 'mul': case 'min': case 'max': case 'step':
        v = t[n.op]!(i('a'), i('b')); break;
      case 'sin': case 'cos': case 'abs': case 'fract': case 'floor': case 'saturate': case 'oneMinus': case 'negate':
        v = t[n.op]!(i('a')); break;
      case 'sqrt': v = t['sqrt']!(t['max']!(i('a'), 0)); break;
      case 'mix': v = t['mix']!(i('a'), i('b'), i('t')); break;
      case 'clamp': v = t['min']!(t['max']!(i('x'), i('lo')), i('hi')); break;
      case 'smoothstep': {
        const s01 = t['saturate']!(safeDiv(i('x').sub(i('e0')), i('e1').sub(i('e0'))));
        v = s01.mul(s01).mul(t['float']!(3).sub(s01.mul(2)));
        break;
      }
      case 'dot': v = t['dot']!(raw('a').node, raw('b').node); break;
      case 'length': v = t['length']!(raw('a').node); break;
      case 'normalize': { const a = raw('a').node; v = t['div']!(a, t['max']!(t['length']!(a), SHADER_EPS)); break; }
      case 'split': v = (raw('a').node as unknown as Record<string, N>)[String(w['c'])]!; break;
      case 'combine': {
        const parts = (['x', 'y', 'z', 'w'] as const).filter((k) => n.in[k] !== undefined).map((k) => i(k, 'float'));
        v = t[['', '', 'vec2', 'vec3', 'vec4'][parts.length]!]!(...parts);
        break;
      }
    }
    // Bounded, and held in a variable: float32 cannot overflow, the code cannot balloon.
    vals.set(id, t['min']!(t['max']!(v, -SHADER_BOUND), SHADER_BOUND).toVar());
  }
  const f = fallback as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: f.side, transparent: f.transparent, alphaTest: f.alphaTest, opacity: f.opacity });
  m.name = `${fallback.name || 'material'} (creator shader)`;
  const out = c.graph.out;
  // The material's node slots each take three's generic node; the graph's types were checked.
  const node = (x: N): THREE.Node<'vec3'> => x as unknown as THREE.Node<'vec3'>;
  const scalar = (x: N): THREE.Node<'float'> => x as unknown as THREE.Node<'float'>;
  if (out.color) {
    const col = vals.get(out.color)!;
    m.colorNode = node(t['saturate']!(c.types[out.color] === 'vec4' ? col.rgb : col));
    if (c.types[out.color] === 'vec4' && !out.opacity) {
      m.opacityNode = scalar(t['saturate']!(col.a));
      m.transparent = true;
    }
  } else {
    // No colour of its own: the fallback's base colour and texture.
    const base = t['vec3']!(f.color?.r ?? 1, f.color?.g ?? 1, f.color?.b ?? 1);
    m.colorNode = node(f.map ? t['texture']!(f.map).rgb.mul(base) : base);
  }
  if (out.emissive) m.emissiveNode = node(t['min']!(t['max']!(vals.get(out.emissive)!, 0), SHADER_LIMITS.emissive));
  if (out.opacity) {
    m.opacityNode = scalar(t['saturate']!(vals.get(out.opacity)!));
    m.transparent = true;
  }
  m.userData['creatorShader'] = { cost: c.cost };
  return m;
}
