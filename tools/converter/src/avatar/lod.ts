// SPDX-License-Identifier: MPL-2.0
// An avatar's lighter levels (S4.03, rr-013): meshoptimizer's simplifier, run per primitive with
// its normals and texture coordinates weighed in and its open borders locked (so parts of
// different materials never part), keeps skin weights and morph targets because it only drops
// vertices, never moves them.
// - LOD1, half the triangles, the face protected: every vertex an expression moves is locked.
// - LOD2, a fifth of the triangles, keeping only the mouth and blink shapes: the other morph
//   targets and expressions go, and the vertices those two move are locked.
// - The impostor: one mesh, one 512 px texture, on about 20 bones (the body's, no fingers, eyes or
//   jaw: each dropped bone's weight goes to its nearest kept ancestor), 1,000 to 2,000 triangles,
//   unlit; it keeps the humanoid, so the same animations move it.
// LOD1 and LOD2 also merge their materials, as spike S0.09 measured they must (VRoid's 15 to 17
// materials made a crowd draw 1,848 calls; merged, 85): one atlas per alpha mode, and within each
// mesh the primitives that now share a material joined into one.
import { type Document, type Material, type Mesh, type Node, type Primitive, TextureInfo } from '@gltf-transform/core';
import { compactPrimitive, joinPrimitives } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { PNG } from 'pngjs';
import { decodeImage, type Rgba } from '../textures.ts';
import { HUMAN_BONES, IMPOSTOR_BONES } from './humanoid.ts';
import type { Json, JsonObject, VRMData } from './vrm.ts';

/** The expressions LOD2 keeps: the mouth's five shapes and the blinks. */
export const LOD2_EXPRESSIONS: ReadonlySet<string> = new Set(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight']);

type Bind = { node?: { $node?: number }; index?: number };

/** The expressions of the VRM data, by name, with their JSON. */
function expressionsOf(data: VRMData): Map<string, JsonObject> {
  const e = (data.getDocument().vrm['expressions'] ?? {}) as Record<string, Record<string, JsonObject>>;
  return new Map([...Object.entries(e['preset'] ?? {}), ...Object.entries(e['custom'] ?? {})]);
}

/** Per mesh: the morph target indices the given expressions use. */
function targetsUsed(data: VRMData, names: (name: string) => boolean): Map<Mesh, Set<number>> {
  const out = new Map<Mesh, Set<number>>();
  for (const [name, e] of expressionsOf(data)) {
    if (!names(name)) continue;
    for (const b of (e['morphTargetBinds'] ?? []) as Bind[]) {
      const mesh = b.node?.$node === undefined ? undefined : data.node(b.node.$node)?.getMesh();
      if (!mesh || typeof b.index !== 'number') continue;
      out.set(mesh, (out.get(mesh) ?? new Set()).add(b.index));
    }
  }
  return out;
}

function floatsOf(prim: Primitive, semantic: string, size: number): Float32Array | undefined {
  const a = prim.getAttribute(semantic);
  if (!a) return undefined;
  const out = new Float32Array(a.getCount() * size);
  const v: number[] = [];
  for (let i = 0; i < a.getCount(); i++) {
    a.getElement(i, v);
    for (let k = 0; k < size; k++) out[i * size + k] = v[k] ?? 0;
  }
  return out;
}

function indicesOf(prim: Primitive): Uint32Array {
  const idx = prim.getIndices();
  const count = prim.getAttribute('POSITION')!.getCount();
  if (!idx) return Uint32Array.from({ length: count }, (_, i) => i);
  const out = new Uint32Array(idx.getCount());
  for (let i = 0; i < out.length; i++) out[i] = idx.getScalar(i);
  return out;
}

/** Simplifies one primitive to `ratio` of its triangles, the `locked` vertices kept. */
function simplifyPrimitive(doc: Document, prim: Primitive, ratio: number, locked: Uint8Array | null): void {
  if (prim.getMode() !== 4) return;
  const positions = floatsOf(prim, 'POSITION', 3);
  if (!positions) return;
  const indices = indicesOf(prim);
  const target = Math.floor((indices.length * ratio) / 3) * 3;
  if (target >= indices.length || indices.length < 3 * 64) return;
  const normals = floatsOf(prim, 'NORMAL', 3);
  const uvs = floatsOf(prim, 'TEXCOORD_0', 2);
  const count = positions.length / 3;
  const stride = 5;
  const attrs = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) attrs[i * stride + k] = normals ? normals[i * 3 + k]! : 0;
    for (let k = 0; k < 2; k++) attrs[i * stride + 3 + k] = uvs ? uvs[i * 2 + k]! : 0;
  }
  const [out] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attrs, stride, [0.25, 0.25, 0.25, 1, 1], locked, target, 0.05, ['LockBorder']);
  const accessor = doc.createAccessor().setType('SCALAR').setArray(count > 65535 ? Uint32Array.from(out) : Uint16Array.from(out)).setBuffer(doc.getRoot().listBuffers()[0] ?? doc.createBuffer());
  prim.setIndices(accessor);
  compactPrimitive(prim);
}

/** The vertices any of the given morph targets moves. */
function movedBy(prim: Primitive, targets: Set<number> | undefined): Uint8Array | null {
  if (!targets || targets.size === 0) return null;
  const count = prim.getAttribute('POSITION')!.getCount();
  const lock = new Uint8Array(count);
  const v: number[] = [];
  prim.listTargets().forEach((t, k) => {
    if (!targets.has(k)) return;
    const a = t.getAttribute('POSITION');
    if (!a) return;
    for (let i = 0; i < count; i++) {
      a.getElement(i, v);
      if (Math.abs(v[0]!) + Math.abs(v[1]!) + Math.abs(v[2]!) > 1e-5) lock[i] = 1;
    }
  });
  return lock;
}

/** LOD1: half the triangles, every vertex an expression moves kept; materials merged (1,024 px). */
export function makeLod1(doc: Document, data: VRMData | null): void {
  const used = data ? targetsUsed(data, () => true) : new Map<Mesh, Set<number>>();
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) simplifyPrimitive(doc, prim, 0.5, movedBy(prim, used.get(mesh)));
  mergeMaterials(doc, data, 1024);
}

// ------------------------------------------------------------------------------ merging

const groupOf = (m: Material | null): string => `${m?.getAlphaMode() ?? 'OPAQUE'}${m?.getDoubleSided() ? '-double' : ''}`;

/** A texture coordinate through KHR_texture_transform (offset, rotation, scale), as glTF draws it. */
function transformUv(t: { getOffset(): number[]; getScale(): number[]; getRotation(): number } | null, u: number, v: number): [number, number] {
  if (!t) return [u, v];
  const [sx, sy] = t.getScale() as [number, number];
  const [ox, oy] = t.getOffset() as [number, number];
  const r = t.getRotation();
  const x = u * sx;
  const y = v * sy;
  return [ox + Math.cos(r) * x + Math.sin(r) * y, oy - Math.sin(r) * x + Math.cos(r) * y];
}

/** One atlas per alpha mode (and sidedness): every primitive's base colour into its slot, its
 *  coordinates moved there, its material the group's; then a mesh's primitives of one material
 *  joined. Each group keeps the MToon settings of its largest material, with the atlas as both its
 *  colour and its shade texture; other textures (normals, rims, matcaps) do not survive at this
 *  distance, nor do expressions' colour binds. */
export function mergeMaterials(doc: Document, data: VRMData | null, side: number): void {
  const root = doc.getRoot();
  const groups = new Map<string, { materials: Material[]; area: Map<Material, number>; prims: Primitive[] }>();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (!m || !prim.getAttribute('TEXCOORD_0')) continue;
      const key = groupOf(m);
      const g = groups.get(key) ?? { materials: [] as Material[], area: new Map<Material, number>(), prims: [] as Primitive[] };
      if (!g.materials.includes(m)) g.materials.push(m);
      g.area.set(m, (g.area.get(m) ?? 0) + (prim.getIndices()?.getCount() ?? 0));
      g.prims.push(prim);
      groups.set(key, g);
    }
  }
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const vdoc = data?.getDocument();
  for (const [key, g] of groups) {
    if (g.materials.length < 2) continue;
    const n = Math.ceil(Math.sqrt(g.materials.length));
    const cell = Math.floor(side / n);
    const atlas = new Uint8Array(side * side * 4).fill(255);
    g.materials.forEach((m, k) => {
      const tex = m.getBaseColorTexture();
      const img = tex?.getImage() ? decodeImage(tex.getImage()!, tex.getMimeType()) : undefined;
      const factor = m.getBaseColorFactor();
      const ox = (k % n) * cell;
      const oy = Math.floor(k / n) * cell;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((oy + y) * side + ox + x) * 4;
          let px = [255, 255, 255, 255];
          if (img) {
            const at = (Math.min(img.height - 1, Math.floor(((y + 0.5) / cell) * img.height)) * img.width + Math.min(img.width - 1, Math.floor(((x + 0.5) / cell) * img.width))) * 4;
            px = [img.data[at]!, img.data[at + 1]!, img.data[at + 2]!, img.data[at + 3]!];
          }
          for (let c = 0; c < 4; c++) atlas[o + c] = Math.round(px[c]! * Math.min(1, Math.max(0, factor[c] ?? 1)));
        }
      }
    });
    const png = new PNG({ width: side, height: side });
    png.data = Buffer.from(atlas);
    const texture = doc.createTexture(`atlas-${key}`).setMimeType('image/png').setImage(new Uint8Array(PNG.sync.write(png)));
    const largest = [...g.area.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const merged = doc
      .createMaterial(`merged-${key}`)
      .setBaseColorTexture(texture)
      .setAlphaMode(largest.getAlphaMode())
      .setAlphaCutoff(largest.getAlphaCutoff())
      .setDoubleSided(largest.getDoubleSided())
      .setMetallicFactor(0)
      .setRoughnessFactor(1);
    if (data && vdoc) {
      const from = vdoc.materials[String(data.addMaterial(largest))]?.['VRMC_materials_mtoon'] as JsonObject | undefined;
      if (from) {
        const kept: JsonObject = {};
        for (const [k, v] of Object.entries(from)) if (!/Texture$/.test(k)) kept[k] = v;
        kept['shadeMultiplyTexture'] = { $texture: data.addTexture(texture, new TextureInfo(doc.getGraph())) };
        vdoc.materials[String(data.addMaterial(merged))] = { VRMC_materials_mtoon: kept };
      }
    }
    const pad = 0.5 / side;
    for (const prim of g.prims) {
      const m = prim.getMaterial()!;
      const k = g.materials.indexOf(m);
      const info = m.getBaseColorTextureInfo();
      const transform = (info?.getExtension('KHR_texture_transform') ?? null) as { getOffset(): number[]; getScale(): number[]; getRotation(): number } | null;
      const uv = prim.getAttribute('TEXCOORD_0')!.clone();
      const v: number[] = [];
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, v);
        const [tu, tv] = transformUv(transform, v[0]!, v[1]!);
        const fu = tu - Math.floor(tu);
        const fv = tv - Math.floor(tv);
        uv.setElement(i, [((k % n) * cell) / side + pad + fu * (cell / side - 2 * pad), (Math.floor(k / n) * cell) / side + pad + fv * (cell / side - 2 * pad)]);
      }
      prim.setAttribute('TEXCOORD_0', uv.setBuffer(buffer)).setMaterial(merged);
    }
  }
  if (data && vdoc) data.setDocument(vdoc);
  // A mesh's primitives that share a material become one (when their layouts allow it).
  for (const mesh of root.listMeshes()) {
    const byMaterial = new Map<Material | null, Primitive[]>();
    for (const prim of mesh.listPrimitives()) byMaterial.set(prim.getMaterial(), [...(byMaterial.get(prim.getMaterial()) ?? []), prim]);
    for (const prims of byMaterial.values()) {
      if (prims.length < 2) continue;
      let joined: Primitive | undefined;
      try {
        joined = prims.some((p) => p.listTargets().length > 0) ? joinWithTargets(doc, prims) : joinPrimitives(prims);
      } catch {
        joined = undefined;
      }
      if (!joined) continue;
      for (const p of prims) p.dispose();
      mesh.addPrimitive(joined);
    }
  }
}

/** LOD2: a fifth of the triangles; only the mouth and blink shapes stay; materials merged (512 px). */
export function makeLod2(doc: Document, data: VRMData | null): void {
  const kept = data ? targetsUsed(data, (n) => LOD2_EXPRESSIONS.has(n)) : new Map<Mesh, Set<number>>();
  // Drop the other morph targets, renumbering what the kept expressions point at.
  const renumber = new Map<Mesh, Map<number, number>>();
  for (const mesh of doc.getRoot().listMeshes()) {
    const keep = kept.get(mesh) ?? new Set<number>();
    const map = new Map<number, number>();
    const weights = mesh.getWeights();
    const names = ((mesh.getExtras() as { targetNames?: string[] })?.targetNames ?? []) as string[];
    let next = 0;
    const count = Math.max(weights.length, names.length, ...mesh.listPrimitives().map((p) => p.listTargets().length));
    for (const prim of mesh.listPrimitives()) {
      prim.listTargets().forEach((t, k) => {
        if (!keep.has(k)) prim.removeTarget(t);
      });
    }
    for (let k = 0; k < count; k++) if (keep.has(k)) map.set(k, next++);
    mesh.setWeights(weights.filter((_, k) => keep.has(k)));
    if (names.length) mesh.setExtras({ ...(mesh.getExtras() as object), targetNames: names.filter((_, k) => keep.has(k)) });
    renumber.set(mesh, map);
  }
  if (data) {
    const doc2 = data.getDocument();
      const e = (doc2.vrm['expressions'] ?? {}) as Record<string, Record<string, JsonObject>>;
    for (const group of ['preset', 'custom'] as const) {
      for (const [name, expr] of Object.entries(e[group] ?? {})) {
        if (!LOD2_EXPRESSIONS.has(name)) {
          delete e[group]![name];
          continue;
        }
        expr['morphTargetBinds'] = ((expr['morphTargetBinds'] ?? []) as Bind[]).flatMap((b) => {
          const mesh = b.node?.$node === undefined ? undefined : data.node(b.node.$node)?.getMesh();
          const to = mesh && typeof b.index === 'number' ? renumber.get(mesh)?.get(b.index) : undefined;
          return to === undefined ? [] : [{ ...(b as JsonObject), index: to } as Json];
        });
      }
    }
    data.setDocument(doc2);
  }
  const locks = data ? targetsUsed(data, (n) => LOD2_EXPRESSIONS.has(n)) : new Map<Mesh, Set<number>>();
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) simplifyPrimitive(doc, prim, 0.2, movedBy(prim, locks.get(mesh)));
  mergeMaterials(doc, data, 512);
}

/** Joins a mesh's primitives, morph targets included (glTF-Transform joins attributes only).
 *  Within one mesh every primitive has the same targets, so their deltas line up; the attributes
 *  must match too, or nothing is joined. */
function joinWithTargets(doc: Document, prims: Primitive[]): Primitive | undefined {
  const first = prims[0]!;
  const semantics = first.listSemantics().sort();
  const targets = first.listTargets().length;
  const same = prims.every((p) => p.getMode() === 4 && p.listSemantics().sort().join() === semantics.join() && p.listTargets().length === targets);
  if (!same) return undefined;
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const concat = (accessors: Array<ReturnType<Primitive['getAttribute']>>): ReturnType<typeof doc.createAccessor> | undefined => {
    const a0 = accessors[0];
    if (!a0 || accessors.some((a) => !a || a.getType() !== a0.getType())) return undefined;
    const size = a0.getElementSize();
    const count = accessors.reduce((n, a) => n + a!.getCount(), 0);
    const sameType = accessors.every((a) => a!.getComponentType() === a0.getComponentType() && a!.getNormalized() === a0.getNormalized());
    const Ctor = (sameType ? a0.getArray()!.constructor : Float32Array) as Float32ArrayConstructor;
    const out = new Ctor(count * size);
    let at = 0;
    const v: number[] = [];
    for (const a of accessors) {
      if (sameType) out.set(a!.getArray()! as Float32Array, at);
      else for (let i = 0; i < a!.getCount(); i++) out.set(a!.getElement(i, v), at + i * size);
      at += a!.getCount() * size;
    }
    return doc.createAccessor().setType(a0.getType()).setArray(out).setNormalized(sameType && a0.getNormalized()).setBuffer(buffer);
  };
  const joined = doc.createPrimitive().setMaterial(first.getMaterial()).setMode(4);
  for (const semantic of semantics) {
    const a = concat(prims.map((p) => p.getAttribute(semantic)));
    if (!a) return undefined;
    joined.setAttribute(semantic, a);
  }
  const indices: number[] = [];
  let base = 0;
  for (const p of prims) {
    const n = p.getAttribute('POSITION')!.getCount();
    const idx = p.getIndices();
    if (idx) for (let i = 0; i < idx.getCount(); i++) indices.push(base + idx.getScalar(i));
    else for (let i = 0; i < n; i++) indices.push(base + i);
    base += n;
  }
  joined.setIndices(doc.createAccessor().setType('SCALAR').setArray(base > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices)).setBuffer(buffer));
  for (let t = 0; t < targets; t++) {
    const target = doc.createPrimitiveTarget(first.listTargets()[t]!.getName());
    for (const semantic of first.listTargets()[t]!.listSemantics()) {
      const a = concat(prims.map((p) => p.listTargets()[t]!.getAttribute(semantic)));
      if (!a) return undefined;
      target.setAttribute(semantic, a);
    }
    joined.addTarget(target);
  }
  return joined;
}

// ------------------------------------------------------------------------------- impostor

type M4 = number[];
function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}
function apply(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}
function invert(m: M4): M4 {
  // A rigid transform with scale: invert the 3x3 block, then the translation.
  const [a, b, c, , d, e, f, , g, h, i] = m as [number, number, number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const s = 1 / (det || 1);
  const r = [(e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s, 0, (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s, 0, (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s, 0];
  const [tx, ty, tz] = [m[12]!, m[13]!, m[14]!];
  return [...r, -(r[0]! * tx + r[4]! * ty + r[8]! * tz), -(r[1]! * tx + r[5]! * ty + r[9]! * tz), -(r[2]! * tx + r[6]! * ty + r[10]! * tz), 1];
}

/** Builds the impostor in place of the document's meshes. `slot` is the atlas side per material. */
export function makeImpostor(doc: Document, data: VRMData): { triangles: number } {
  const root = doc.getRoot();
  const bones = data.humanBones();
  // The kept bones (about 20), and for every other node the kept bone it falls back to.
  const keptNames = HUMAN_BONES.map(([n]) => n).filter((n) => IMPOSTOR_BONES.has(n) && bones.has(n));
  const kept = keptNames.map((n) => bones.get(n)!);
  const keptSet = new Set(kept);
  const fallback = (node: Node | null): number => {
    for (let n = node; n; n = n.getParentNode()) if (keptSet.has(n)) return kept.indexOf(n);
    return kept.indexOf(bones.get('hips')!);
  };
  const world = (n: Node): M4 => n.getWorldMatrix() as unknown as M4;

  // Every triangle of every mesh at rest, in world space, with its kept-bone weights and its
  // material's colour source.
  const positions: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const sources: Array<{ img?: Rgba; factor: number[]; alpha: boolean }> = [];
  const sourceOf = new Map<unknown, number>();
  const materialIndex: number[] = [];
  const tmp: number[] = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    const skinJoints = skin?.listJoints() ?? [];
    const ibm = skin?.getInverseBindMatrices();
    const jointMats = skinJoints.map((j, k) => {
      const inv = ibm ? (ibm.getElement(k, []) as number[]) : invert(world(j));
      return mul(world(j), inv);
    });
    const rigid = world(node);
    const rigidBone = fallback(node);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const mat = prim.getMaterial();
      let src = sourceOf.get(mat);
      if (src === undefined) {
        const tex = mat?.getBaseColorTexture();
        const img = tex?.getImage() ? decodeImage(tex.getImage()!, tex.getMimeType()) : undefined;
        src = sources.length;
        sources.push({ ...(img ? { img } : {}), factor: mat?.getBaseColorFactor() ?? [1, 1, 1, 1], alpha: mat?.getAlphaMode() !== 'OPAQUE' });
        sourceOf.set(mat, src);
      }
      const j0 = prim.getAttribute('JOINTS_0');
      const w0 = prim.getAttribute('WEIGHTS_0');
      const uv = prim.getAttribute('TEXCOORD_0');
      const base = positions.length / 3;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, tmp);
        const [x, y, z] = [tmp[0]!, tmp[1]!, tmp[2]!];
        const acc = new Map<number, number>();
        if (skin && j0 && w0) {
          const js = j0.getElement(i, []) as number[];
          const ws = w0.getElement(i, []) as number[];
          let wx = 0;
          let wy = 0;
          let wz = 0;
          let total = 0;
          for (let k = 0; k < 4; k++) {
            const w = ws[k]!;
            if (w <= 0) continue;
            const m = jointMats[js[k]!];
            if (!m) continue;
            const p = apply(m, x, y, z);
            wx += p[0] * w;
            wy += p[1] * w;
            wz += p[2] * w;
            total += w;
            const b = fallback(skinJoints[js[k]!] ?? null);
            acc.set(b, (acc.get(b) ?? 0) + w);
          }
          const t = total || 1;
          positions.push(wx / t, wy / t, wz / t);
        } else {
          positions.push(...apply(rigid, x, y, z));
          acc.set(rigidBone, 1);
        }
        const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
        for (let k = 0; k < 4; k++) {
          joints.push(top[k]?.[0] ?? 0);
          weights.push(top[k] ? top[k]![1] / sum : 0);
        }
        if (uv) {
          uv.getElement(i, tmp);
          uvs.push(tmp[0]!, tmp[1]!);
        } else uvs.push(0.5, 0.5);
        materialIndex.push(src);
      }
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      for (let i = 0; i < n; i++) indices.push(base + (idx ? idx.getScalar(i) : i));
    }
  }

  // The atlas: a grid of slots, one per material, 512 px in all.
  const side = 512;
  const grid = Math.max(1, Math.ceil(Math.sqrt(sources.length)));
  const cell = Math.floor(side / grid);
  const atlas = new Uint8Array(side * side * 4);
  sources.forEach((s, k) => {
    const ox = (k % grid) * cell;
    const oy = Math.floor(k / grid) * cell;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        let rgba = [255, 255, 255, 255];
        if (s.img) {
          const sx = Math.min(s.img.width - 1, Math.floor(((x + 0.5) / cell) * s.img.width));
          const sy = Math.min(s.img.height - 1, Math.floor(((y + 0.5) / cell) * s.img.height));
          const at = (sy * s.img.width + sx) * 4;
          rgba = [s.img.data[at]!, s.img.data[at + 1]!, s.img.data[at + 2]!, s.img.data[at + 3]!];
        }
        const o = ((oy + y) * side + ox + x) * 4;
        // The factor is linear and the texture sRGB: multiplying in sRGB is near enough at this size.
        for (let c = 0; c < 4; c++) atlas[o + c] = Math.round(rgba[c]! * Math.min(1, Math.max(0, s.factor[c] ?? 1)));
      }
    }
  });
  // UVs into each vertex's slot (a texture's repeat folded back into it, half a pixel in).
  const pad = 0.5 / side;
  for (let v = 0; v < materialIndex.length; v++) {
    const k = materialIndex[v]!;
    const fu = uvs[v * 2]! - Math.floor(uvs[v * 2]!);
    const fv = uvs[v * 2 + 1]! - Math.floor(uvs[v * 2 + 1]!);
    const u0 = ((k % grid) * cell) / side;
    const v0 = (Math.floor(k / grid) * cell) / side;
    const w = cell / side;
    uvs[v * 2] = u0 + pad + fu * (w - 2 * pad);
    uvs[v * 2 + 1] = v0 + pad + fv * (w - 2 * pad);
  }

  // 1,000 to 2,000 triangles: the attribute-aware simplifier first, the sloppy one if it stalls.
  let idx = Uint32Array.from(indices);
  const posArr = Float32Array.from(positions);
  const target = 1500 * 3;
  if (idx.length > target) {
    idx = Uint32Array.from(MeshoptSimplifier.simplify(idx, posArr, 3, target, 0.08, [])[0]);
    if (idx.length > 2000 * 3) idx = Uint32Array.from(MeshoptSimplifier.simplifySloppy(idx, posArr, 3, null, target, 0.2)[0]);
  }

  // Replace everything with the one mesh and its one skin.
  for (const node of root.listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const png = new PNG({ width: side, height: side });
  png.data = Buffer.from(atlas);
  const texture = doc.createTexture('impostor').setMimeType('image/png').setImage(new Uint8Array(PNG.sync.write(png)));
  const alpha = sources.some((s) => s.alpha);
  const material = doc.createMaterial('impostor').setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(1).setAlphaMode(alpha ? 'MASK' : 'OPAQUE');
  if (alpha) material.setAlphaCutoff(0.5);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(posArr).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(Float32Array.from(uvs)).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(Uint8Array.from(joints)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(Float32Array.from(weights)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(posArr.length / 3 > 65535 ? idx : new Uint16Array(idx)).setBuffer(buffer));
  compactPrimitive(prim);
  const mesh = doc.createMesh('impostor').addPrimitive(prim);
  const ibms: number[] = [];
  for (const b of kept) ibms.push(...invert(world(b)));
  const skin = doc.createSkin('impostor').setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(Float32Array.from(ibms)).setBuffer(buffer));
  for (const b of kept) skin.addJoint(b);
  const holder = doc.createNode('impostor').setMesh(mesh).setSkin(skin);
  root.listScenes()[0]?.addChild(holder);
  // Only the kept bones and what holds them stay: 200 impostors are 200 copies of this tree.
  const needed = new Set<Node>([holder]);
  for (const b of kept) for (let n: Node | null = b; n; n = n.getParentNode()) needed.add(n);
  for (const node of root.listNodes()) if (!needed.has(node)) node.dispose();
  return { triangles: idx.length / 3 };
}
