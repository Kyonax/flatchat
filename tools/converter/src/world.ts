// SPDX-License-Identifier: MPL-2.0
// The world converter (S2.03, DR-15): a world folder in (docs/world-format.md), a built world out
// (packages/content/src/built.ts): world.json and content files named by their SHA-256. It
// validates the folder first and refuses it on any error, reads every marker with
// packages/content (glTF-Transform drops extensions it does not know), and then:
//   - optimizes each scene's visuals (dedup, prune, weld, meshopt compression), and gives every
//     dense mesh two simpler copies, its levels of detail, as child nodes the client switches
//     between by distance;
//   - fits every texture to 2048 px and a 128 MB budget for the whole world, and encodes it to KTX2
//     (ETC1S for colour, UASTC for normal maps; Basis Universal compiled to WebAssembly);
//   - collects every solid in world space (the OMI physics markers; or, in a world that marks
//     none, every mesh as a static triangle mesh) into collision.bin;
//   - builds a navigation mesh for click-to-move (Recast) from the same solids;
//   - lists the base library's parts a scene places (S2.05): the client draws them from its own
//     library, so they add no geometry to download; their solids and seats join the scene's.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  BASE_PARTS,
  BUILT_FORMAT,
  type BuiltEmitter,
  type BuiltScene,
  type BuiltWorld,
  type Collider,
  encodeColliders,
  FILE_LIMIT,
  FOLDER_LIMIT,
  type Gltf,
  localMatrix as localMatrixOf,
  type Mat4,
  multiply,
  readGltf,
  type SceneInfo,
  transformPoint,
  validateWorld,
  type WorldReport,
} from '@flatchat/content';
import { BODY } from '@flatchat/sim';
import { type Document, Logger, type Mesh, NodeIO, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplifyPrimitive, weld } from '@gltf-transform/functions';
import jpeg from 'jpeg-js';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { PNG } from 'pngjs';
import { exportNavMesh, init as initRecast } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';

export interface ConvertOptions {
  /** Skip KTX2 (tests, quick previews): textures are only fitted to the size limits. */
  ktx2?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ConvertResult {
  world: BuiltWorld;
  /** The built files: world.json, and content/<hash> for each listed file. */
  out: Map<string, Uint8Array>;
  warnings: string[];
}

export class ConvertError extends Error {
  readonly report: WorldReport;
  constructor(report: WorldReport) {
    super(report.problems.filter((p) => p.severity === 'error').map((p) => `${p.code} ${p.file} ${p.at}: ${p.message}`).join('\n'));
    this.report = report;
  }
}

const TEXTURE_SIDE = 2048;
const TEXTURE_BUDGET = 128 * 1024 * 1024;

/** A world folder's files, by relative path with forward slashes. Symbolic links are refused. */
export function readFolder(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const path = join(d, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`${relative(dir, path)} is a symbolic link: a world folder holds its own files`);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        if (st.size > FILE_LIMIT) throw new Error(`${relative(dir, path)} is over ${FILE_LIMIT / 1048576} MB`);
        total += st.size;
        if (total > FOLDER_LIMIT) throw new Error(`the folder is over ${FOLDER_LIMIT / 1048576} MB`);
        files.set(relative(dir, path).split(sep).join('/'), new Uint8Array(readFileSync(path)));
      }
    }
  };
  walk(dir);
  return files;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// --------------------------------------------------------------------------------- textures

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

function decode(bytes: Uint8Array, mime: string): Rgba | undefined {
  try {
    if (mime === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (mime === 'image/jpeg') {
      const j = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
      return { width: j.width, height: j.height, data: new Uint8Array(j.data) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Halves an image by averaging 2×2 blocks (an odd last row or column is dropped). */
export function halve(img: Rgba): Rgba {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const at = (yy: number, xx: number): number => img.data[(Math.min(img.height - 1, yy) * img.width + Math.min(img.width - 1, xx)) * 4 + c]!;
        out[(y * w + x) * 4 + c] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1) + 2) >> 2;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** The GPU memory a texture takes once compressed with mipmaps (BC7 or ASTC: 1 byte a pixel). */
const gpuBytes = (w: number, h: number): number => Math.ceil(w * h * 1.34);

async function textures(docs: Document[], ktx2: boolean, warn: (w: string) => void): Promise<void> {
  // Every decodable texture of every scene, fitted first to the side limit, then together to the budget.
  const all: Array<{ doc: Document; texture: Texture; img: Rgba; normal: boolean }> = [];
  for (const doc of docs) {
    const normals = new Set(doc.getRoot().listMaterials().map((m) => m.getNormalTexture()).filter((t): t is Texture => !!t));
    for (const texture of doc.getRoot().listTextures()) {
      const image = texture.getImage();
      const mime = texture.getMimeType();
      if (!image) continue;
      let img = decode(image, mime);
      if (!img) {
        warn(`a texture of type ${mime || 'unknown'} is kept as it is (only PNG and JPEG are converted)`);
        continue;
      }
      while (Math.max(img.width, img.height) > TEXTURE_SIDE) img = halve(img);
      all.push({ doc, texture, img, normal: normals.has(texture) });
    }
  }
  let total = all.reduce((n, t) => n + gpuBytes(t.img.width, t.img.height), 0);
  while (total > TEXTURE_BUDGET) {
    const biggest = all.reduce((a, b) => (b.img.width * b.img.height > a.img.width * a.img.height ? b : a));
    if (biggest.img.width <= 64) break;
    total -= gpuBytes(biggest.img.width, biggest.img.height);
    biggest.img = halve(biggest.img);
    total += gpuBytes(biggest.img.width, biggest.img.height);
  }
  for (const t of all) {
    if (ktx2) {
      const { img } = t;
      const out = await encodeToKTX2(new Uint8Array(1), {
        isUASTC: t.normal,
        isNormalMap: t.normal,
        isPerceptual: !t.normal,
        generateMipmap: true,
        qualityLevel: 128,
        compressionLevel: 2,
        imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
      });
      t.texture.setImage(out).setMimeType('image/ktx2');
      t.doc.createExtension(KHRTextureBasisu).setRequired(true);
    } else {
      const png = new PNG({ width: t.img.width, height: t.img.height });
      png.data = Buffer.from(t.img.data);
      t.texture.setImage(new Uint8Array(PNG.sync.write(png))).setMimeType('image/png');
    }
  }
}

// --------------------------------------------------------------------------------- solids

/** Position, rotation (a unit quaternion) and scale from a world matrix. */
export function decompose(m: Mat4): { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] } {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const r = [m[0]! / sx, m[1]! / sx, m[2]! / sx, m[4]! / sy, m[5]! / sy, m[6]! / sy, m[8]! / sz, m[9]! / sz, m[10]! / sz];
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r as [number, number, number, number, number, number, number, number, number];
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const len = Math.hypot(...q);
  return { position: [m[12]!, m[13]!, m[14]!], rotation: q.map((v) => v / len) as [number, number, number, number], scale: [sx, sy, sz] };
}

/** A mesh's triangles in world space, from the original glTF (accessors read through glTF-Transform). */
function meshTriangles(doc: Document, meshIndex: number, matrix: Mat4): { positions: Float32Array; indices: Uint32Array } | undefined {
  const mesh = doc.getRoot().listMeshes()[meshIndex];
  if (!mesh) return undefined;
  const positions: number[] = [];
  const indices: number[] = [];
  const p: number[] = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const base = positions.length / 3;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      positions.push(...transformPoint(matrix, [p[0]!, p[1]!, p[2]!]));
    }
    const idx = prim.getIndices();
    if (idx) for (let i = 0; i < idx.getCount(); i++) indices.push(base + idx.getScalar(i));
    else for (let i = 0; i < pos.getCount(); i++) indices.push(base + i);
  }
  return positions.length > 0 ? { positions: new Float32Array(positions), indices: new Uint32Array(indices) } : undefined;
}

function sceneColliders(doc: Document, json: Gltf, info: SceneInfo, warn: (w: string) => void): Collider[] {
  const out: Collider[] = [];
  for (const body of info.bodies) {
    if (body.collider === undefined) continue;
    const shape = info.shapes[body.collider]!;
    const { position, rotation, scale } = decompose(body.matrix);
    const uniform = (scale[0] + scale[1] + scale[2]) / 3;
    if (shape.type === 'box') out.push({ type: 'box', position, rotation, half: [(shape.size![0] * scale[0]) / 2, (shape.size![1] * scale[1]) / 2, (shape.size![2] * scale[2]) / 2] });
    else if (shape.type === 'sphere') out.push({ type: 'sphere', position, rotation, radius: shape.radius! * uniform });
    else if (shape.type === 'capsule' || shape.type === 'cylinder') out.push({ type: shape.type, position, rotation, radius: shape.radius! * uniform, halfHeight: (shape.height! * scale[1]) / 2 });
    else {
      const tri = meshTriangles(doc, shape.mesh!, body.matrix);
      if (tri) out.push({ type: 'trimesh', ...tri });
    }
  }
  if (info.bodies.length === 0 && (json.meshes?.length ?? 0) > 0) {
    // Nothing marked solid: every mesh is, as a static triangle mesh (a Blender scene exported as is).
    warn(`${info.file} marks no solids (OMI_physics_body): every mesh becomes one`);
    const nodes = json.nodes ?? [];
    const world = new Map<number, Mat4>();
    const visit = (i: number, parent: Mat4): void => {
      const node = nodes[i];
      if (!node || world.has(i)) return;
      const m = multiply(parent, localMatrixOf(node));
      world.set(i, m);
      for (const c of Array.isArray(node['children']) ? (node['children'] as number[]) : []) visit(c, m);
    };
    for (const r of (json.scenes?.[typeof json.scene === 'number' ? json.scene : 0]?.nodes as number[] | undefined) ?? []) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const [i, m] of world) {
      const mesh = nodes[i]!['mesh'];
      if (typeof mesh !== 'number') continue;
      const tri = meshTriangles(doc, mesh, m);
      if (tri) out.push({ type: 'trimesh', ...tri });
    }
  }
  return out;
}


/** The base library parts' solids (S2.05): each solid box of each part, placed by its node. */
export function partColliders(info: SceneInfo): Collider[] {
  const out: Collider[] = [];
  for (const placed of info.parts) {
    const { rotation, scale } = decompose(placed.matrix);
    for (const b of BASE_PARTS[placed.id]!.boxes) {
      if (b.solid === false) continue;
      const centre = transformPoint(placed.matrix, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]);
      out.push({ type: 'box', position: centre, rotation, half: [((b.max[0] - b.min[0]) * scale[0]) / 2, ((b.max[1] - b.min[1]) * scale[1]) / 2, ((b.max[2] - b.min[2]) * scale[2]) / 2] });
    }
  }
  return out;
}

/** Every collider as triangles, for the navigation mesh (primitives as their boxes). */
function trianglesOf(colliders: readonly Collider[]): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const quatRotate = (q: [number, number, number, number], v: [number, number, number]): [number, number, number] => {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1];
    const iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0];
    const iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  for (const c of colliders) {
    const base = positions.length / 3;
    if (c.type === 'trimesh') {
      positions.push(...c.positions);
      for (const i of c.indices) indices.push(base + i);
      continue;
    }
    const h: [number, number, number] = c.type === 'box' ? c.half : c.type === 'sphere' ? [c.radius, c.radius, c.radius] : [c.radius, c.halfHeight + (c.type === 'capsule' ? c.radius : 0), c.radius];
    for (let k = 0; k < 8; k++) {
      const v = quatRotate(c.rotation, [k & 1 ? h[0] : -h[0], k & 2 ? h[1] : -h[1], k & 4 ? h[2] : -h[2]]);
      positions.push(v[0] + c.position[0], v[1] + c.position[1], v[2] + c.position[2]);
    }
    for (const [a, b, cc, d] of [
      [0, 1, 3, 2],
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 5, 7, 3],
    ] as const) {
      indices.push(base + a, base + b, base + cc, base + a, base + cc, base + d);
    }
  }
  return { positions, indices };
}

async function navmesh(colliders: readonly Collider[], warn: (w: string) => void): Promise<Uint8Array | undefined> {
  await initRecast();
  const { positions, indices } = trianglesOf(colliders);
  if (indices.length === 0) return undefined;
  // 20 cm cells: Recast's WebAssembly build runs out of memory building the detail mesh of a 128 m
  // world at 15 cm (measured 2026-10-17).
  const cs = 0.2;
  const ch = 0.1;
  const r = generateSoloNavMesh(new Float32Array(positions), new Uint32Array(indices), {
    cs,
    ch,
    walkableSlopeAngle: 45,
    walkableHeight: Math.ceil(BODY.height / ch),
    walkableClimb: Math.floor(BODY.step / ch),
    walkableRadius: Math.ceil(BODY.radius / cs),
    maxEdgeLen: 12 / cs,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6 * cs,
    detailSampleMaxError: ch,
  });
  if (!r.success) {
    warn(`no navigation mesh: ${r.error}`);
    return undefined;
  }
  const bytes = exportNavMesh(r.navMesh);
  r.navMesh.destroy();
  return bytes;
}

// ---------------------------------------------------------------------------- the pipeline

/** Levels of detail (S2.03): a mesh of at least LOD_MIN_TRIANGLES triangles gets these simpler
 *  copies (the share of its triangles to keep, and the error allowed as a share of its radius). */
export const LODS = [
  { ratio: 0.35, error: 0.01 },
  { ratio: 0.1, error: 0.05 },
] as const;
export const LOD_MIN_TRIANGLES = 2000;

function trianglesIn(mesh: Mesh): number {
  return mesh.listPrimitives().reduce((n, p) => n + Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3), 0);
}

/** Gives each dense mesh its levels of detail: every node that draws it hands the mesh to a child
 *  marked `extras.flatchatLod: 0` and gets two more children with the simpler copies (1 and 2), so
 *  the levels are siblings (meshopt's quantization moves a mesh off a node that has children).
 *  Skinned or morphed nodes are left alone. Returns how many meshes got levels. Run after weld (the
 *  simplifier needs shared vertices) and before compression. */
export function addLevelsOfDetail(doc: Document): number {
  const levelsOf = new Map<Mesh, Mesh[]>();
  for (const mesh of doc.getRoot().listMeshes()) {
    // Triangles only (mode 4), and no morph targets: a simplified copy would not follow them.
    if (trianglesIn(mesh) < LOD_MIN_TRIANGLES || mesh.listPrimitives().some((p) => p.getMode() !== 4 || p.listTargets().length > 0)) continue;
    levelsOf.set(
      mesh,
      LODS.map((lod, k) => {
        const copy = doc.createMesh(`${mesh.getName()}.lod${k + 1}`);
        for (const prim of mesh.listPrimitives()) copy.addPrimitive(simplifyPrimitive(prim.clone(), { simplifier: MeshoptSimplifier, ...lod }));
        return copy;
      }),
    );
  }
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const levels = mesh ? levelsOf.get(mesh) : undefined;
    if (!mesh || !levels || node.getSkin() || node.getWeights().length > 0) continue;
    node.setMesh(null);
    [mesh, ...levels].forEach((m, k) => node.addChild(doc.createNode(`${node.getName()}.lod${k}`).setMesh(m).setExtras({ flatchatLod: k })));
  }
  return levelsOf.size;
}

export async function convertWorld(files: ReadonlyMap<string, Uint8Array>, o: ConvertOptions = {}): Promise<ConvertResult> {
  const report = validateWorld(files);
  if (!report.ok || !report.manifest) throw new ConvertError(report);
  const warnings = report.problems.filter((p) => p.severity === 'warning').map((p) => `${p.code} ${p.file} ${p.at}: ${p.message}`);
  const warn = (w: string): void => void warnings.push(w);
  // Errors only: the OMI and FlatChat markers are read by packages/content, and glTF-Transform's
  // notes about them ("missing optional extension") are expected.
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const out = new Map<string, Uint8Array>();
  const listed: BuiltWorld['files'] = [];
  const put = (bytes: Uint8Array, kind: BuiltWorld['files'][number]['kind']): string => {
    const hash = sha256(bytes);
    if (!out.has(`content/${hash}`)) {
      out.set(`content/${hash}`, bytes);
      listed.push({ hash, size: bytes.length, kind });
    }
    return hash;
  };

  const docs: Document[] = [];
  const colliders: Collider[] = [];
  const parsed: Array<{ info: SceneInfo; json: Gltf; base: string }> = [];
  for (const [i, entry] of report.manifest.scenes.entries()) {
    const info = report.scenes[i]!;
    const data = files.get(entry.file)!;
    const base = entry.file.includes('/') ? entry.file.slice(0, entry.file.lastIndexOf('/') + 1) : '';
    const { json } = readGltf(data, entry.file);
    let doc: Document;
    if (/\.glb$/i.test(entry.file)) doc = await io.readBinary(data);
    else {
      const resources: Record<string, Uint8Array> = {};
      for (const need of info.needs) resources[need] = files.get(base + need)!;
      for (const [k, v] of files) if (k.startsWith(base)) resources[k.slice(base.length)] ??= v;
      doc = await io.readJSON({ json: json as never, resources: resources as Record<string, Uint8Array<ArrayBuffer>> });
    }
    colliders.push(...sceneColliders(doc, json, info, warn), ...partColliders(info));
    docs.push(doc);
    parsed.push({ info, json, base });
  }
  await textures(docs, o.ktx2 ?? true, warn);

  const scenes: BuiltScene[] = [];
  for (const [i, doc] of docs.entries()) {
    const { info, json, base } = parsed[i]!;
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));
    await doc.transform(dedup(), prune(), weld());
    const lods = addLevelsOfDetail(doc);
    if (lods > 0) o.log?.('levels-of-detail', { scene: info.file, meshes: lods });
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const glb = await io.writeBinary(doc);
    const emitters: BuiltEmitter[] = [];
    const audio = (json.extensions?.['KHR_audio_emitter'] ?? {}) as { audio?: Array<{ uri?: string }>; sources?: Array<{ audio?: number; gain?: number; loop?: boolean; autoPlay?: boolean }>; emitters?: Array<{ type?: string; gain?: number; sources?: number[]; positional?: { refDistance?: number; maxDistance?: number } }> };
    for (const e of info.emitters) {
      const em = audio.emitters?.[e.emitter];
      const src = audio.sources?.[em?.sources?.[0] ?? -1];
      const uri = audio.audio?.[src?.audio ?? -1]?.uri;
      const file = uri ? files.get(base + decodeURIComponent(uri)) : undefined;
      if (!em || !src || !file) {
        warn(`${info.file}: an audio emitter without a sound file beside the scene is skipped`);
        continue;
      }
      emitters.push({
        position: transformPoint(e.matrix, [0, 0, 0]),
        audio: put(file, 'audio'),
        positional: em.type !== 'global',
        gain: Math.min(4, Math.max(0, (em.gain ?? 1) * (src.gain ?? 1))),
        loop: src.loop ?? false,
        autoPlay: src.autoPlay ?? true,
        refDistance: Math.max(0.01, em.positional?.refDistance ?? 1),
        maxDistance: Math.max(0.01, em.positional?.maxDistance ?? 50),
      });
    }
    const boxOf = (m: Mat4, size: [number, number, number]): { center: [number, number, number]; half: [number, number, number]; yaw: number } => {
      const d = decompose(m);
      return { center: d.position, half: [(size[0] * d.scale[0]) / 2, (size[1] * d.scale[1]) / 2, (size[2] * d.scale[2]) / 2], yaw: Math.atan2(m[8]!, m[10]!) };
    };
    scenes.push({
      id: report.manifest.scenes[i]!.id,
      glb: put(glb, 'scene'),
      spawns: info.spawns.map((s) => ({ position: s.position, yaw: s.yaw, title: s.title, group: s.group })),
      seats: [
        ...info.seats.map((s) => ({ position: transformPoint(s.matrix, [0, 0, 0]), yaw: Math.atan2(-s.matrix[8]!, -s.matrix[10]!) })),
        ...info.parts.flatMap((p) => (BASE_PARTS[p.id]!.seats ?? []).map((seat) => ({ position: transformPoint(p.matrix, seat.position), yaw: Math.atan2(-p.matrix[8]!, -p.matrix[10]!) + seat.yaw }))),
      ],
      parts: info.parts.map((p) => {
        const d = decompose(p.matrix);
        return { id: p.id, position: d.position, rotation: d.rotation, scale: d.scale };
      }),
      portals: info.portals.map((p) => ({ ...boxOf(p.matrix, p.size), world: p.world, spawn: p.spawn })),
      zones: info.zones.map((z) => ({ ...boxOf(z.matrix, z.size), kind: z.kind, ...(z.range !== undefined ? { range: z.range } : {}), ...(z.gain !== undefined ? { gain: z.gain } : {}) })),
      emitters,
      triangles: info.triangles,
    });
  }

  const collision = put(encodeColliders(colliders), 'collision');
  const nav = await navmesh(colliders, warn);
  const navmeshHash = nav ? put(nav, 'navmesh') : undefined;
  const xs: number[] = [];
  const zs: number[] = [];
  const { positions } = trianglesOf(colliders);
  for (let k = 0; k < positions.length; k += 3) {
    xs.push(positions[k]!);
    zs.push(positions[k + 2]!);
  }
  const bounds = { min: [Math.min(0, ...xs), -100, Math.min(0, ...zs)] as [number, number, number], max: [Math.max(16, ...xs), 500, Math.max(16, ...zs)] as [number, number, number] };
  const world: BuiltWorld = { format: BUILT_FORMAT, manifest: report.manifest, scenes, collision, ...(navmeshHash ? { navmesh: navmeshHash } : {}), bounds, files: listed };
  out.set('world.json', new TextEncoder().encode(`${JSON.stringify(world)}\n`));
  o.log?.('converted', { scenes: scenes.length, files: listed.length, bytes: listed.reduce((n, f) => n + f.size, 0), colliders: colliders.length, navmesh: !!nav, warnings: warnings.length });
  return { world, out, warnings };
}

/** Writes a conversion's files under `dir` (world.json and content/). */
export function writeBuilt(dir: string, out: ReadonlyMap<string, Uint8Array>): void {
  mkdirSync(join(dir, 'content'), { recursive: true });
  for (const [path, bytes] of out) writeFileSync(join(dir, path), bytes);
}
