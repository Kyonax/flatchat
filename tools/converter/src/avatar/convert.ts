// SPDX-License-Identifier: MPL-2.0
// The avatar converter (S4.02, S4.03, DR-15): a VRM 0.x, VRM 1.0 or plain GLB file in, the
// platform's avatar out: four GLB levels in VRM 1.0 (the full avatar, LOD1, LOD2 and the impostor),
// a thumbnail and a manifest (packages/content/src/avatar.ts), each named by its SHA-256. Every
// level is the platform's own format, made here: the client never parses an upload as it came
// (R-18).
//
// In order: the file is checked by Khronos's glTF-Validator and, for a VRM, by vrm-validator (an
// error refuses it, but for the few the converter repairs), then by the platform's rules (its data
// inside the GLB, the extensions it may require, hard limits); a VRM 0.x is migrated to 1.0 and a
// plain GLB's skeleton found by its bone names; the humanoid's required bones must be there; the
// avatar is turned to face +Z if it does not; animations, cameras and lights go; duplicates are
// merged and what is unused pruned (every node the VRM data points at stays); then it is measured
// and ranked, and its levels built and their textures fitted and encoded.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  AVATAR_FORMAT,
  AVATAR_LIMITS,
  AVATAR_SOURCE_LIMIT,
  type AvatarLevel,
  type AvatarManifest,
  type AvatarSourceKind,
  type AvatarStats,
  checkAvatarLevel,
  type Gltf,
  LEVEL_EXTENSIONS,
  type Level,
  rankOf,
  readGltf,
} from '@flatchat/content';
import { type Document, GLB_BUFFER, type JSONDocument, Logger, NodeIO, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, type EmissiveStrength, KHRLightsPunctual } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { PNG } from 'pngjs';
import { type UploadSource, UploadError, uploadGlb } from '../source/upload.ts';
import { decodeImage, fitTextures, halve } from '../textures.ts';
import { completeFreeShape, facesPlusZ, mapByNames, REQUIRED_BONES, restBox, turnAround, turnVrmAround } from './humanoid.ts';
import { makeImpostor, makeLod1, makeLod2 } from './lod.ts';
import { type Json, type JsonObject, VRMC_VRM, VRMData, type VRMDocument, VRMExtension } from './vrm.ts';
import { migrateVrm0, type SourceMeta } from './vrm0.ts';

export const AVATAR_CONVERTER_VERSION = '1.3.0';

export class AvatarError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

export interface AvatarOptions {
  /** Skip KTX2 (tests): textures are fitted and kept as PNG. */
  ktx2?: boolean;
  /** The upload itself when the bytes are the GLB the core's Blender made from it (S5.08). */
  source?: UploadSource;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface AvatarResult {
  manifest: AvatarManifest;
  /** The manifest as written (manifest.json); its SHA-256 names the avatar. */
  manifestBytes: Uint8Array;
  id: string;
  /** Every file by its SHA-256: the levels and the thumbnail. */
  files: Map<string, Uint8Array>;
}

/** Validator errors the converter repairs instead of refusing the file: on 68 real avatars from
 *  VRoid Studio (UniVRM) and Blender's VRM exporter (2026-10-17) these were the only ones. */
const REPAIRED = new Set([
  // UniVRM writes a skin's `skeleton` that is not the joints' common root; three.js ignores it, so it goes.
  'SKIN_SKELETON_INVALID',
  // Normals a little off unit length: normalised (repairAccessors).
  'ACCESSOR_VECTOR3_NON_UNIT',
  // A joint named twice for one vertex, and weights that do not add up to one: merged, normalised.
  'ACCESSOR_JOINTS_INDEX_DUPLICATE',
  'ACCESSOR_WEIGHTS_NON_NORMALIZED',
]);
/** Extensions a file may require: anything else is refused (the client could not show it). */
const REQUIRED_OK = new Set(['KHR_texture_transform', 'KHR_materials_unlit', 'KHR_mesh_quantization', 'EXT_meshopt_compression', 'KHR_texture_basisu']);
/** Each level's texture limits. */
const LEVEL_TEXTURES: Record<Level, { side: number; budget: number }> = {
  lod0: { side: 2048, budget: 64 * 1024 * 1024 },
  lod1: { side: 1024, budget: 24 * 1024 * 1024 },
  lod2: { side: 512, budget: 8 * 1024 * 1024 },
  impostor: { side: 512, budget: 1024 * 1024 },
};

const require = createRequire(import.meta.url);
type Validator = { validateBytes(data: Uint8Array, options: Record<string, unknown>): Promise<{ issues: { numErrors: number; messages: Array<{ code: string; message: string; severity: number; pointer?: string }> } }> };
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Khronos glTF-Validator (and vrm-validator for a VRM) on a file: its errors, and the repairable ones. */
export async function validateGltf(bytes: Uint8Array, vrm: boolean): Promise<{ problems: string[]; repaired: string[] }> {
  return validate(bytes, vrm);
}

async function validate(bytes: Uint8Array, vrm: boolean): Promise<{ problems: string[]; repaired: string[] }> {
  const validators: Validator[] = [require('gltf-validator') as Validator, ...(vrm ? [require('vrm-validator') as Validator] : [])];
  const problems = new Set<string>();
  const repaired = new Set<string>();
  for (const v of validators) {
    const report = await v.validateBytes(bytes, { maxIssues: 200, externalResourceFunction: () => Promise.reject(new Error('an avatar carries every resource inside its file')) });
    for (const m of report.issues.messages) {
      if (m.severity !== 0) continue;
      if (REPAIRED.has(m.code)) repaired.add(m.code);
      else problems.add(`${m.code}: ${m.message}${m.pointer ? ` (${m.pointer})` : ''}`);
    }
  }
  return { problems: [...problems].slice(0, 8), repaired: [...repaired] };
}

/** The platform's own rules, on the JSON before anything else reads it. */
function rules(json: Gltf, hasBin: boolean): string[] {
  const p: string[] = [];
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if (!hasBin && list('buffers').length > 0) p.push('the file must carry its data inside it: upload a .vrm or a .glb');
  if (list('buffers').some((b) => b['uri'] !== undefined)) p.push('the file points at outside data: upload a .vrm or a .glb with everything inside');
  if (list('images').some((i) => i['uri'] !== undefined)) p.push('the file points at outside images: upload a .vrm or a .glb with its textures inside');
  for (const e of (json['extensionsRequired'] as string[] | undefined) ?? []) if (!REQUIRED_OK.has(e)) p.push(`the file requires the extension ${e}, which FlatChat cannot show`);
  const over = (what: string, n: number, max: number): void => {
    if (n > max) p.push(`${n} ${what}, more than the ${max} an avatar may have`);
  };
  over('nodes', list('nodes').length, AVATAR_LIMITS.nodes);
  over('meshes', list('meshes').length, AVATAR_LIMITS.meshes);
  over('materials', list('materials').length, AVATAR_LIMITS.materials);
  over('textures', list('images').length, AVATAR_LIMITS.textures);
  over('skins', list('skins').length, AVATAR_LIMITS.skins);
  for (const s of list('skins')) over('joints in a skin', ((s['joints'] as unknown[]) ?? []).length, AVATAR_LIMITS.jointsPerSkin);
  const accessors = list('accessors');
  let triangles = 0;
  let vertices = 0;
  const uses = new Map<number, number>();
  for (const n of list('nodes')) if (typeof n['mesh'] === 'number') uses.set(n['mesh'], (uses.get(n['mesh']) ?? 0) + 1);
  list('meshes').forEach((m, mi) => {
    for (const prim of (m['primitives'] as Array<Record<string, unknown>>) ?? []) {
      const pos = accessors[((prim['attributes'] as Record<string, number>) ?? {})['POSITION'] ?? -1];
      const idx = typeof prim['indices'] === 'number' ? accessors[prim['indices']] : undefined;
      const count = Number(pos?.['count'] ?? 0);
      const times = uses.get(mi) ?? 0;
      vertices += count * times;
      if ((prim['mode'] ?? 4) === 4) triangles += Math.floor(Number(idx?.['count'] ?? count) / 3) * times;
      over('morph targets on a primitive', ((prim['targets'] as unknown[]) ?? []).length, AVATAR_LIMITS.morphTargets);
    }
  });
  over('triangles', triangles, AVATAR_LIMITS.triangles);
  over('vertices', vertices, AVATAR_LIMITS.vertices);
  return p;
}

/** The repairs REPAIRED promises: unit normals and tangents; per vertex, each joint once, the
 *  weights adding up to one (the four largest kept). */
function repairAccessors(doc: Document): void {
  const done = new Set<unknown>();
  const v: number[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of ['NORMAL', 'TANGENT'] as const) {
        const a = prim.getAttribute(semantic);
        if (!a || done.has(a)) continue;
        done.add(a);
        for (let i = 0; i < a.getCount(); i++) {
          a.getElement(i, v);
          const len = Math.hypot(v[0]!, v[1]!, v[2]!);
          if (Math.abs(len - 1) < 1e-4) continue;
          if (len < 1e-8) [v[0], v[1], v[2]] = semantic === 'NORMAL' ? [0, 1, 0] : [1, 0, 0];
          else [v[0], v[1], v[2]] = [v[0]! / len, v[1]! / len, v[2]! / len];
          a.setElement(i, v);
        }
      }
      const j = prim.getAttribute('JOINTS_0');
      const w = prim.getAttribute('WEIGHTS_0');
      if (!j || !w || done.has(w)) continue;
      done.add(w);
      const js: number[] = [];
      const ws: number[] = [];
      for (let i = 0; i < w.getCount(); i++) {
        j.getElement(i, js);
        w.getElement(i, ws);
        const acc = new Map<number, number>();
        let repeated = false;
        for (let k = 0; k < 4; k++) {
          if (!(ws[k]! > 0)) continue;
          if (acc.has(js[k]!)) repeated = true;
          acc.set(js[k]!, (acc.get(js[k]!) ?? 0) + ws[k]!);
        }
        const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const sum = top.reduce((n, [, x]) => n + x, 0);
        if (!repeated && Math.abs(sum - 1) < 2e-3) continue;
        const nj = [0, 0, 0, 0];
        const nw = [0, 0, 0, 0];
        if (sum <= 0) {
          nj[0] = js[0] ?? 0;
          nw[0] = 1;
        } else top.forEach(([joint, x], k) => ((nj[k] = joint), (nw[k] = x / sum)));
        j.setElement(i, nj);
        w.setElement(i, nw);
      }
    }
  }
}

function kindOf(json: Gltf): AvatarSourceKind {
  const ext = (json['extensions'] ?? {}) as Record<string, unknown>;
  if (ext['VRMC_vrm']) return 'vrm1';
  if (ext['VRM']) return 'vrm0';
  return 'glb';
}

/** Only what the client draws: any other extension (Blender writes KHR_materials_clearcoat,
 *  _specular, _ior and _emissive_strength) goes, or the client would refuse every level (S5.01).
 *  An emissive strength is folded into the emissive colour first: Blender writes a white emission
 *  at strength 0, which without its strength would light the whole avatar white. */
export function dropForeignExtensions(doc: Document, warn: (w: string) => void = () => undefined): void {
  for (const material of doc.getRoot().listMaterials()) {
    const strength = material.getExtension<EmissiveStrength>('KHR_materials_emissive_strength');
    if (!strength) continue;
    const s = strength.getEmissiveStrength();
    if (s > 1) warn(`an emissive strength of ${s} is cut to 1: the platform's avatars glow at most that much`);
    material.setEmissiveFactor(material.getEmissiveFactor().map((c) => Math.min(1, c * s)) as [number, number, number]);
  }
  for (const e of doc.getRoot().listExtensionsUsed()) {
    if (LEVEL_EXTENSIONS.has(e.extensionName)) continue;
    warn(`the ${e.extensionName} extension is left out: the platform's avatars do not carry it`);
    e.dispose();
  }
}

/** glTF Transform's reader and writer with VRM 1.0 and every extension the converter knows. */
export function avatarIO(): NodeIO {
  return io();
}

/** A converted level read back, with its VRM data (tests and audits). */
export async function readAvatarLevel(bytes: Uint8Array): Promise<{ doc: Document; data: VRMData }> {
  const doc = await io().readBinary(bytes);
  return { doc, data: doc.getRoot().getExtension<VRMData>(VRMC_VRM)! };
}

function io(): NodeIO {
  return new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions([...ALL_EXTENSIONS, VRMExtension])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

// ------------------------------------------------------------------------------ plain GLB

const VISEMES: Record<string, string> = { aa: 'aa', a: 'aa', ih: 'ih', i: 'ih', ou: 'ou', u: 'ou', ee: 'ee', e: 'ee', oh: 'oh', o: 'oh' };
const BLINKS: Record<string, string> = { blink: 'blink', eyesclosed: 'blink', eyeblinkleft: 'blinkLeft', blinkleft: 'blinkLeft', eyeblinkright: 'blinkRight', blinkright: 'blinkRight' };

/** A plain GLB's VRM data: its skeleton by bone names, the mouth and blink shapes by their names,
 *  and the strictest licence terms (nothing in the file says otherwise). */
function plainVrm(doc: Document, json: Gltf): VRMData {
  const data = doc.createExtension(VRMExtension).createData();
  doc.getRoot().setExtension(VRMC_VRM, data);
  const humanBones: JsonObject = {};
  for (const [bone, node] of mapByNames(doc)) humanBones[bone] = { node: { $node: data.addNode(node) } };
  const preset: JsonObject = {};
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const names = ((mesh?.getExtras() as { targetNames?: unknown } | undefined)?.targetNames ?? []) as unknown[];
    names.forEach((raw, index) => {
      const n = String(raw).toLowerCase().replace(/^(viseme_|vrc\.v_|v_|mouth_)/, '').replace(/[_.\-\s]/g, '');
      const name = VISEMES[n] ?? BLINKS[n];
      if (!name) return;
      const e = (preset[name] ?? { morphTargetBinds: [], isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' }) as JsonObject;
      (e['morphTargetBinds'] as Json[]).push({ node: { $node: data.addNode(node) }, index, weight: 1 });
      preset[name] = e;
    });
  }
  const asset = (json['asset'] ?? {}) as Record<string, unknown>;
  const doc2: VRMDocument = {
    vrm: {
      specVersion: '1.0',
      meta: {
        name: String((asset['extras'] as Record<string, unknown> | undefined)?.['title'] ?? '') || 'Untitled',
        authors: [String(asset['copyright'] ?? '') || 'Unknown'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        avatarPermission: 'onlyAuthor',
        allowExcessivelyViolentUsage: false,
        allowExcessivelySexualUsage: false,
        commercialUsage: 'personalNonProfit',
        allowPoliticalOrReligiousUsage: false,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'required',
        allowRedistribution: false,
        modification: 'prohibited',
      },
      humanoid: { humanBones },
      expressions: { preset },
      lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.06, 0] },
    },
    materials: {},
    constraints: {},
  };
  data.setDocument(doc2);
  return data;
}

// ------------------------------------------------------------------------------ measuring

function statsOf(doc: Document, data: VRMData | null, textureBytes: number): AvatarStats {
  let triangles = 0;
  let vertices = 0;
  let skinned = 0;
  let basic = 0;
  let slots = 0;
  let morphs = 0;
  const bones = new Set<unknown>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (node.getSkin()) {
      skinned += 1;
      for (const j of node.getSkin()!.listJoints()) bones.add(j);
    } else basic += 1;
    for (const prim of mesh.listPrimitives()) {
      slots += 1;
      const count = prim.getAttribute('POSITION')?.getCount() ?? 0;
      vertices += count;
      if (prim.getMode() === 4) triangles += Math.floor((prim.getIndices()?.getCount() ?? count) / 3);
      morphs = Math.max(morphs, prim.listTargets().length);
    }
  }
  const sb = (data?.getDocument().springBone ?? {}) as JsonObject;
  const springs = (sb['springs'] ?? []) as JsonObject[];
  const groups = (sb['colliderGroups'] ?? []) as JsonObject[];
  let joints = 0;
  let checks = 0;
  for (const s of springs) {
    const n = ((s['joints'] ?? []) as Json[]).length;
    joints += n;
    const cols = ((s['colliderGroups'] ?? []) as number[]).reduce((c, g) => c + (((groups[g]?.['colliders'] ?? []) as Json[]).length ?? 0), 0);
    checks += n * cols;
  }
  return {
    triangles,
    vertices,
    textureBytes,
    skinnedMeshes: skinned,
    basicMeshes: basic,
    materialSlots: slots,
    bones: bones.size,
    morphTargets: morphs,
    springs: springs.length,
    springJoints: joints,
    colliders: ((sb['colliders'] ?? []) as Json[]).length,
    collisionChecks: checks,
  };
}

/** The avatar's height: its highest vertex at rest above its lowest, in metres. */
function heightOf(doc: Document): number {
  let lo = Infinity;
  let hi = -Infinity;
  const v: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getSkin() ? null : (node.getWorldMatrix() as unknown as number[]);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const y = m ? m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]! : v[1]!;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
  }
  return Number.isFinite(hi - lo) ? Math.round((hi - lo) * 1000) / 1000 : 0;
}

/** Takes the thumbnail out of the VRM data (it travels as its own small PNG). */
function takeThumbnail(data: VRMData): Uint8Array | undefined {
  const doc = data.getDocument();
  const meta = doc.vrm['meta'] as JsonObject | undefined;
  const slot = (meta?.['thumbnailImage'] as { $image?: number } | undefined)?.$image;
  if (!meta || slot === undefined) return undefined;
  delete meta['thumbnailImage'];
  data.setDocument(doc);
  const tex: Texture | undefined = data.image(slot);
  const img = tex?.getImage() ? decodeImage(tex.getImage()!, tex.getMimeType()) : undefined;
  if (!img) return undefined;
  let small = img;
  while (Math.max(small.width, small.height) > 256) small = halve(small);
  const png = new PNG({ width: small.width, height: small.height });
  png.data = Buffer.from(small.data);
  return new Uint8Array(PNG.sync.write(png));
}

function levelOf(doc: Document, bytes: Uint8Array, textureBytes: number): AvatarLevel {
  const s = statsOf(doc, null, textureBytes);
  return { file: sha256(bytes), bytes: bytes.length, triangles: s.triangles, bones: s.bones, materialSlots: s.materialSlots, textureBytes };
}

// ------------------------------------------------------------------------------ the pipeline

export async function convertAvatar(upload: Uint8Array, o: AvatarOptions = {}): Promise<AvatarResult> {
  const ktx2 = o.ktx2 ?? true;
  const warnings: string[] = [];
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  if (upload.length > AVATAR_SOURCE_LIMIT) throw new AvatarError([`the file is over ${AVATAR_SOURCE_LIMIT / 1048576} MB`]);
  // A DAE becomes a GLB here; an FBX, OBJ or .blend arrives as the GLB the core's Blender made (S5.08).
  const { glb: bytes, source } = await uploadGlb(upload, o.source).catch((err: unknown) => {
    throw new AvatarError([err instanceof UploadError ? err.message : String(err)]);
  });
  let parsed: { json: Gltf; bin?: Uint8Array };
  try {
    parsed = readGltf(bytes, 'avatar.glb');
  } catch (err) {
    throw new AvatarError([`not a GLB or VRM file: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const { json } = parsed;
  const kind = kindOf(json);
  const checked = await validate(bytes, kind !== 'glb');
  const problems = [...checked.problems, ...rules(json, parsed.bin !== undefined)];
  if (kind === 'vrm1' && ((json['extensions'] as Record<string, Record<string, unknown>>)['VRMC_vrm']!['specVersion'] ?? '') !== '1.0') problems.push('only VRM 1.0 and VRM 0.x are taken (this says another VRM version)');
  if (problems.length > 0) throw new AvatarError(problems);
  for (const r of checked.repaired) warn(`repaired: ${r}`);

  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  let sourceMeta: SourceMeta = {};
  if (kind === 'vrm0') {
    const m = migrateVrm0(json as Record<string, unknown>);
    sourceMeta = m.sourceMeta;
    for (const n of m.notes) warn(n);
  }
  const reader = io();
  const doc = await reader.readJSON({ json: json as unknown as JSONDocument['json'], resources: parsed.bin ? { [GLB_BUFFER]: new Uint8Array(parsed.bin) } : {} });
  const root = doc.getRoot();
  const data = root.getExtension<VRMData>(VRMC_VRM) ?? plainVrm(doc, json);
  repairAccessors(doc);
  if (kind === 'vrm1') sourceMeta = { ...((data.getDocument().vrm['meta'] ?? {}) as SourceMeta) };

  if (!restBox(doc)) throw new AvatarError(['the model has no mesh to show']);
  // A body the humanoid does not fit is a free shape (S4.11): its missing bones are made.
  const missing = REQUIRED_BONES.filter((b) => !data.humanBones().has(b));
  const shape: 'humanoid' | 'free' = missing.length > 0 ? 'free' : 'humanoid';
  if (shape === 'free') {
    const made = completeFreeShape(doc, data, missing);
    const none = missing.length === REQUIRED_BONES.length;
    warn(`a free shape: ${none ? 'no humanoid skeleton' : `no ${missing.join(', ')}`} was found, so the shared motions move it as a whole${none ? '' : ' and by the bones it has'} (bones made: ${made.join(', ')})`);
  }
  const bones = data.humanBones();
  if (kind === 'vrm0' || (shape === 'humanoid' && !facesPlusZ(bones))) {
    if (kind !== 'vrm0') warn('the avatar faced away (-Z): it was turned round');
    turnAround(doc);
    turnVrmAround(data);
  }

  // Clean-up: no skeleton hints, animations, cameras or lights; duplicates merged, the unused pruned.
  for (const skin of root.listSkins()) skin.setSkeleton(null);
  for (const a of root.listAnimations()) a.dispose();
  for (const node of root.listNodes()) {
    node.setCamera(null);
    node.setExtension('KHR_lights_punctual', null);
  }
  for (const c of root.listCameras()) c.dispose();
  for (const e of root.listExtensionsUsed()) if (e.extensionName === KHRLightsPunctual.EXTENSION_NAME) e.dispose();
  dropForeignExtensions(doc, warn);
  const thumbnail = takeThumbnail(data);
  await doc.transform(dedup({ keepUniqueNames: true }), prune({ keepLeaves: true, keepAttributes: true, keepExtras: true }));

  // One clean source for every level.
  const writer = io();
  const clean = await writer.writeBinary(doc);
  const read = async (): Promise<{ doc: Document; data: VRMData }> => {
    const d = await io().readBinary(clean);
    return { doc: d, data: d.getRoot().getExtension<VRMData>(VRMC_VRM)! };
  };

  const files = new Map<string, Uint8Array>();
  const levels = {} as Record<Level, AvatarLevel>;
  const build = async (level: Level, shape: (l: { doc: Document; data: VRMData }) => void): Promise<{ doc: Document; data: VRMData; textureBytes: number }> => {
    const l = await read();
    shape(l);
    await l.doc.transform(prune({ keepLeaves: true, keepAttributes: true, keepExtras: true }));
    const textureBytes = await fitTextures([l.doc], LEVEL_TEXTURES[level], ktx2, warn);
    const out = await io().writeBinary(l.doc);
    // The client's own check on every level made: a level it would refuse is the converter's fault.
    try {
      checkAvatarLevel(readGltf(out, `${level}.glb`).json as unknown as Record<string, unknown>);
    } catch (err) {
      throw new Error(`the converter made a ${level} the client refuses: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    levels[level] = levelOf(l.doc, out, textureBytes);
    files.set(levels[level].file, out);
    return { ...l, textureBytes };
  };
  const lod0 = await build('lod0', () => undefined);
  await build('lod1', (l) => makeLod1(l.doc, l.data));
  await build('lod2', (l) => makeLod2(l.doc, l.data));
  await build('impostor', (l) => {
    makeImpostor(l.doc, l.data);
    // The impostor keeps its humanoid (about 20 bones) and its meta; nothing else moves on it.
    const d = l.data.getDocument();
    const humanBones = ((d.vrm['humanoid'] as JsonObject)['humanBones'] ?? {}) as JsonObject;
    const kept = new Set(l.doc.getRoot().listSkins()[0]?.listJoints() ?? []);
    for (const [name, b] of Object.entries(humanBones)) {
      const slot = ((b as JsonObject)['node'] as { $node?: number } | undefined)?.$node;
      if (slot === undefined || !kept.has(l.data.node(slot)!)) delete humanBones[name];
    }
    l.data.setDocument({ vrm: { specVersion: '1.0', meta: d.vrm['meta']!, humanoid: { humanBones } }, materials: {}, constraints: {} });
  });

  const stats = statsOf(lod0.doc, lod0.data, lod0.textureBytes);
  const { rank, limitedBy } = rankOf(stats);
  const expressions = (() => {
    const e = (lod0.data.getDocument().vrm['expressions'] ?? {}) as Record<string, Record<string, unknown>>;
    return [...Object.keys(e['preset'] ?? {}), ...Object.keys(e['custom'] ?? {})].sort();
  })();
  if (thumbnail) files.set(sha256(thumbnail), thumbnail);
  const meta = (lod0.data.getDocument().vrm['meta'] ?? {}) as JsonObject;
  const manifest: AvatarManifest = {
    format: AVATAR_FORMAT,
    converter: AVATAR_CONVERTER_VERSION,
    source: { sha256: source.sha256, bytes: source.bytes, kind, generator: String(((json['asset'] ?? {}) as Record<string, unknown>)['generator'] ?? '').slice(0, 120), ...(source.from ? { from: source.from } : {}) },
    name: String(meta['name'] ?? 'Untitled').slice(0, 120),
    licence: Object.fromEntries(Object.entries(sourceMeta).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v])) as AvatarManifest['licence'],
    stats,
    rank,
    limitedBy,
    levels,
    ...(thumbnail ? { thumbnail: sha256(thumbnail) } : {}),
    bones: [...lod0.data.humanBones().keys()].sort(),
    shape,
    expressions,
    height: heightOf(lod0.doc),
    springs: stats.springs,
    warnings,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  o.log?.('avatar-converted', { kind, rank, triangles: stats.triangles, levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, v.triangles])) });
  return { manifest, manifestBytes, id: sha256(manifestBytes), files };
}
