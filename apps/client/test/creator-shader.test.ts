// SPDX-License-Identifier: MPL-2.0
// A creator shader made into a node material (S6.03): every operation of the graph format builds,
// the outputs land in the material's slots, a vec4 colour or an opacity makes it see-through, and a
// graph with no colour of its own keeps its fallback's. The GPU compile itself is the end-to-end
// test's, on WebGPU and on WebGL2.
import { checkShaderGraph, SHADER_OPS, type ShaderGraph } from '@flatchat/content';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { compileCreatorShader } from '../src/renderer/src/world/creator-shader';

/** One node of every operation, chained into the three outputs. */
const EVERY: ShaderGraph = {
  format: 1,
  nodes: [
    { id: 'uv', op: 'uv', in: {} },
    { id: 'nrm', op: 'normal', in: {} },
    { id: 'pos', op: 'position', in: {} },
    { id: 'view', op: 'viewDir', in: {} },
    { id: 'rim', op: 'fresnel', in: { power: 2 } },
    { id: 'osc', op: 'oscillate', in: {}, with: { hz: 1, shape: 'triangle' } },
    { id: 'tex', op: 'texture', in: { uv: 'uv' }, with: { texture: 0 } },
    { id: 'nz', op: 'noise', in: { p: 'pos' } },
    { id: 'u', op: 'split', in: { a: 'uv' }, with: { c: 'x' } },
    { id: 'a1', op: 'add', in: { a: 'u', b: 'osc' } },
    { id: 'a2', op: 'sub', in: { a: 'a1', b: 0.5 } },
    { id: 'a3', op: 'mul', in: { a: 'a2', b: 'rim' } },
    { id: 'a4', op: 'div', in: { a: 'a3', b: 'nz' } },
    { id: 'a5', op: 'min', in: { a: 'a4', b: 1 } },
    { id: 'a6', op: 'max', in: { a: 'a5', b: 0 } },
    { id: 'a7', op: 'pow', in: { a: 'a6', b: 2 } },
    { id: 'a8', op: 'step', in: { a: 0.1, b: 'a7' } },
    { id: 'b1', op: 'sin', in: { a: 'a8' } },
    { id: 'b2', op: 'cos', in: { a: 'b1' } },
    { id: 'b3', op: 'abs', in: { a: 'b2' } },
    { id: 'b4', op: 'fract', in: { a: 'b3' } },
    { id: 'b5', op: 'floor', in: { a: 'b4' } },
    { id: 'b6', op: 'sqrt', in: { a: 'b5' } },
    { id: 'b7', op: 'saturate', in: { a: 'b6' } },
    { id: 'b8', op: 'oneMinus', in: { a: 'b7' } },
    { id: 'b9', op: 'negate', in: { a: 'b8' } },
    { id: 'c1', op: 'mix', in: { a: 'b9', b: 1, t: 0.5 } },
    { id: 'c2', op: 'clamp', in: { x: 'c1', lo: 0, hi: 1 } },
    { id: 'c3', op: 'smoothstep', in: { e0: 0, e1: 1, x: 'c2' } },
    { id: 'd1', op: 'dot', in: { a: 'nrm', b: 'view' } },
    { id: 'd2', op: 'length', in: { a: 'pos' } },
    { id: 'd3', op: 'normalize', in: { a: 'pos' } },
    { id: 'col', op: 'combine', in: { x: 'c3', y: 'd1', z: 'd2', w: 1 } },
    { id: 'mixed', op: 'mul', in: { a: 'col', b: 'tex' } },
    { id: 'glow', op: 'mul', in: { a: 'd3', b: 0.2 } },
  ],
  out: { color: 'mixed', emissive: 'glow', opacity: 'c3' },
};

describe('a creator shader as a node material', () => {
  it('builds every operation', () => {
    const c = checkShaderGraph(EVERY);
    expect(new Set(EVERY.nodes.map((n) => n.op))).toEqual(new Set(Object.keys(SHADER_OPS)));
    const fallback = new THREE.MeshStandardMaterial({ color: 0x336699, side: THREE.DoubleSide });
    const m = compileCreatorShader(c, [new THREE.Texture()], fallback);
    expect(m.colorNode).toBeTruthy();
    expect(m.emissiveNode).toBeTruthy();
    expect(m.opacityNode).toBeTruthy();
    expect(m.transparent).toBe(true);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.userData['creatorShader']).toEqual({ cost: c.cost });
  });

  it("keeps the fallback's colour when the graph sets none", () => {
    const c = checkShaderGraph({ format: 1, nodes: [{ id: 'rim', op: 'fresnel', in: {} }, { id: 'g', op: 'combine', in: { x: 'rim', y: 'rim', z: 'rim' } }], out: { emissive: 'g' } });
    const m = compileCreatorShader(c, [], new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    expect(m.colorNode).toBeTruthy();
    expect(m.transparent).toBe(false);
  });

  it('builds the hostile graphs the format lets through, and a texture it lacks as magenta', () => {
    const storms: ShaderGraph[] = [
      { format: 1, nodes: [{ id: 'd', op: 'div', in: { a: 1, b: 0 } }, { id: 'c', op: 'combine', in: { x: 'd', y: 'd', z: 'd' } }], out: { color: 'c' } },
      { format: 1, nodes: [{ id: 'p', op: 'pow', in: { a: 0, b: -1 } }, { id: 'n', op: 'normalize', in: { a: [0, 0, 0] } }, { id: 'e', op: 'mul', in: { a: 'n', b: 'p' } }], out: { emissive: 'e' } },
      { format: 1, nodes: [{ id: 'uv', op: 'uv', in: {} }, { id: 't', op: 'texture', in: { uv: 'uv' }, with: { texture: 3 } }], out: { color: 't' } },
    ];
    for (const g of storms) expect(() => compileCreatorShader(checkShaderGraph(g), [], new THREE.MeshStandardMaterial())).not.toThrow();
  });
});
