// SPDX-License-Identifier: MPL-2.0
// Creator shaders through the avatar converter (S6.03): a graph on a material is checked, kept on
// the full avatar with the texture it reads, left off the lower levels (they keep the fallback), and
// counted into the rank; a broken graph, one too costly, and one with no fallback are refused.
import { type AvatarManifest, checkShaderGraph, readGltf, SHADER_EXTENSION, type ShaderGraph } from '@flatchat/content';
import { type Document, NodeIO, TextureInfo } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';
import { AvatarError, convertAvatar } from '../src/avatar/convert.ts';
import { sampleAvatar, type SampleKind } from '../src/avatar/samples.ts';
import { ShaderExtension } from '../src/avatar/shader.ts';
import { VRMExtension } from '../src/avatar/vrm.ts';

const io = (): NodeIO => new NodeIO().registerExtensions([...ALL_EXTENSIONS, VRMExtension, ShaderExtension]);

/** A rim glow that pulses, reading the material's own texture when it has one. */
const glow = (textured: boolean): ShaderGraph => ({
  format: 1,
  nodes: [
    ...(textured ? [{ id: 'uv', op: 'uv' as const, in: {} }, { id: 'tex', op: 'texture' as const, in: { uv: 'uv' }, with: { texture: 0 } }, { id: 'rgb', op: 'combine' as const, in: { x: 'r', y: 'g', z: 'b' } }, ...(['r', 'g', 'b'] as const).map((c, k) => ({ id: c, op: 'split' as const, in: { a: 'tex' }, with: { c: 'xyz'[k]! } }))] : []),
    { id: 'rim', op: 'fresnel', in: { power: 3 } },
    { id: 'pulse', op: 'oscillate', in: {}, with: { hz: 0.5 } },
    { id: 'amount', op: 'mul', in: { a: 'rim', b: 'pulse' } },
    { id: 'glow', op: 'mul', in: { a: [0.2, 0.8, 1], b: 'amount' } },
  ],
  out: { ...(textured ? { color: 'rgb' } : {}), emissive: 'glow' },
});

/** A sample avatar with `graph` on its first material; `edit` changes the document first. */
async function withShader(kind: SampleKind, graph: unknown, edit?: (doc: Document) => void): Promise<{ bytes: Uint8Array; textured: boolean }> {
  const doc = await io().readBinary(await sampleAvatar(kind));
  edit?.(doc);
  const material = doc.getRoot().listMaterials()[0]!;
  const data = doc.createExtension(ShaderExtension).createData().setShader(graph);
  const texture = material.getBaseColorTexture();
  if (texture) data.addTexture(texture, new TextureInfo(doc.getGraph()));
  material.setExtension(SHADER_EXTENSION, data);
  return { bytes: await io().writeBinary(doc), textured: texture !== null };
}

const levelJson = (r: { files: Map<string, Uint8Array> }, m: AvatarManifest, level: keyof AvatarManifest['levels']): Record<string, unknown> => readGltf(r.files.get(m.levels[level].file)!, `${level}.glb`).json as unknown as Record<string, unknown>;

describe('creator shaders on an avatar', () => {
  it('keeps a checked graph on the full avatar, with its texture, and counts its cost', async () => {
    // Without a texture, and reading the material's own texture (the first sample that has one).
    const cases = [{ bytes: (await withShader('vrm1', glow(false))).bytes, graph: glow(false), t: false }];
    for (const kind of ['vrm1', 'glb', 'vrm0'] as const) {
      const probe = await withShader(kind, glow(true));
      if (!probe.textured) continue;
      cases.push({ bytes: probe.bytes, graph: glow(true), t: true });
      break;
    }
    expect(cases).toHaveLength(2);
    for (const { bytes, graph, t } of cases) {
      const r = await convertAvatar(bytes, { ktx2: false });
      expect(r.manifest.shaders).toBe(1);
      expect(r.manifest.stats.shaderCost).toBe(checkShaderGraph(graph).cost);
      const lod0 = levelJson(r, r.manifest, 'lod0') as { materials: Array<{ extensions?: Record<string, { graph: ShaderGraph; textures: Array<{ index: number } | null> }> }>; textures?: unknown[]; extensionsUsed: string[] };
      const ext = lod0.materials.map((m) => m.extensions?.[SHADER_EXTENSION]).find(Boolean)!;
      expect(checkShaderGraph(ext.graph).cost).toBe(checkShaderGraph(graph).cost);
      expect(lod0.extensionsUsed).toContain(SHADER_EXTENSION);
      if (t) expect(ext.textures[0]!.index).toBeLessThan(lod0.textures!.length);
      for (const level of ['lod1', 'lod2', 'impostor'] as const) expect(JSON.stringify(levelJson(r, r.manifest, level))).not.toContain(SHADER_EXTENSION);
    }
  }, 120_000);

  it('refuses a graph that loops, and one that reads a texture it does not list', async () => {
    const loop = { format: 1, nodes: [{ id: 'a', op: 'sin', in: { a: 'b' } }, { id: 'b', op: 'sin', in: { a: 'a' } }], out: { opacity: 'a' } };
    await expect(convertAvatar((await withShader('vrm1', loop)).bytes, { ktx2: false })).rejects.toThrow(/no cycles/);
    const reads = { format: 1, nodes: [{ id: 'uv', op: 'uv', in: {} }, { id: 't', op: 'texture', in: { uv: 'uv' }, with: { texture: 5 } }], out: { color: 't' } };
    const err = await convertAvatar((await withShader('vrm1', reads)).bytes, { ktx2: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AvatarError);
    expect((err as AvatarError).problems).toEqual(expect.arrayContaining([expect.stringMatching(/reads texture 5, which it does not list/)]));
  }, 120_000);

  it('refuses a creator shader with no look of its own to fall back to', async () => {
    const plain = await withShader('glb', glow(false), (doc) => {
      const m = doc.getRoot().listMaterials()[0]!;
      m.setBaseColorTexture(null);
      m.setBaseColorFactor([1, 1, 1, 1]);
    });
    await expect(convertAvatar(plain.bytes, { ktx2: false })).rejects.toThrow(/no look of its own to fall back to/);
  }, 120_000);
});
