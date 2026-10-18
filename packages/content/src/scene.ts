// SPDX-License-Identifier: Apache-2.0
// A world's glTF scene, read without an engine: the JSON (from a .gltf, or a GLB's first chunk),
// every node's world transform, and the markers of docs/world-format.md (spawn points, seats,
// solids, sounds, portals, zones, base library parts, effects), with the limits that keep a world
// drawable on a weak laptop.
// Web APIs only (DataView, TextDecoder), so it runs in the world server, the client and the tools.
import type { Problem, Severity } from './manifest.ts';
import { plainText, safePath } from './manifest.ts';
import { isPart, MAX_PARTS } from './parts.ts';

export type Vec3 = [number, number, number];
export type Mat4 = number[];

export interface Pose {
  position: Vec3;
  /** Facing around y, radians: 0 faces -z (the node's -z axis projected on the ground). */
  yaw: number;
}

export interface SpawnPoint extends Pose {
  node: number;
  title: string;
  group: string;
}

export interface Seat {
  node: number;
  matrix: Mat4;
  back: Vec3;
  foot: Vec3;
  knee: Vec3;
  angle: number;
}

export type ShapeType = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'convex' | 'trimesh';

export interface Shape {
  type: ShapeType;
  size?: Vec3;
  radius?: number;
  height?: number;
  mesh?: number;
}

export interface Body {
  node: number;
  matrix: Mat4;
  motion: 'static' | 'kinematic' | 'dynamic';
  collider?: number;
  trigger?: number;
}

export interface Emitter {
  node: number;
  matrix: Mat4;
  emitter: number;
}

export interface Portal {
  node: number;
  matrix: Mat4;
  world: string;
  spawn: string;
  size: Vec3;
}

export type ZoneKind = 'voice' | 'quiet' | 'private';

export interface Zone {
  node: number;
  matrix: Mat4;
  kind: ZoneKind;
  size: Vec3;
  range?: number;
  gain?: number;
}

/** A base library part placed by a node (S2.05). */
export interface PartPlacement {
  node: number;
  matrix: Mat4;
  id: string;
}

/** An effect placed in a world (S6.01): an Effekseer file in the world folder, played where the
 *  node is, looping. */
export interface EffectPlacement {
  node: number;
  matrix: Mat4;
  /** The effect file, relative to the folder. */
  path: string;
  scale: number;
}

export interface SceneInfo {
  file: string;
  spawns: SpawnPoint[];
  seats: Seat[];
  shapes: Shape[];
  bodies: Body[];
  emitters: Emitter[];
  portals: Portal[];
  zones: Zone[];
  parts: PartPlacement[];
  effects: EffectPlacement[];
  triangles: number;
  textures: number;
  /** Files the scene needs from the world folder (buffers and images), relative to the folder. */
  needs: string[];
}

export const LIMITS = {
  triangles: 2_000_000,
  trianglesWarning: 1_000_000,
  textureSide: 4096,
  textureSideWarning: 2048,
  nodes: 65_536,
  spawns: 1000,
  seats: 1000,
  portals: 256,
  zones: 256,
  emitters: 256,
  parts: MAX_PARTS,
  effects: 64,
  name: 128,
  dataUri: 1024 * 1024,
} as const;

/** Extensions a scene may use; an unknown one in extensionsRequired refuses the world. */
export const KNOWN_EXTENSIONS = new Set([
  'OMI_spawn_point',
  'OMI_seat',
  'OMI_physics_shape',
  'OMI_physics_body',
  'KHR_audio_emitter',
  'FLATCHAT_world',
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_volume',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'EXT_meshopt_compression',
  'EXT_texture_webp',
]);

// ------------------------------------------------------------------------------- reading

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export type Gltf = Record<string, unknown> & {
  asset?: { version?: unknown };
  nodes?: Array<Record<string, unknown>>;
  scenes?: Array<{ nodes?: unknown }>;
  scene?: unknown;
  meshes?: Array<{ primitives?: Array<Record<string, unknown>> }>;
  accessors?: Array<{ count?: unknown }>;
  images?: Array<{ uri?: unknown; mimeType?: unknown }>;
  buffers?: Array<{ uri?: unknown; byteLength?: unknown }>;
  extensions?: Record<string, unknown>;
  extensionsUsed?: unknown;
  extensionsRequired?: unknown;
};

/** The glTF JSON of a .glb or .gltf file, and a GLB's binary chunk; throws with a reason. */
export function readGltf(bytes: Uint8Array, file: string): { json: Gltf; binLength: number; bin?: Uint8Array } {
  if (/\.glb$/i.test(file)) {
    if (bytes.length < 20) throw new Error('too short for a GLB');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB (wrong magic)');
    if (v.getUint32(4, true) !== 2) throw new Error(`GLB version ${v.getUint32(4, true)}, not 2`);
    if (v.getUint32(8, true) !== bytes.length) throw new Error('the GLB header length does not match the file');
    const jsonLength = v.getUint32(12, true);
    if (v.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.length) throw new Error('the GLB has no JSON chunk');
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
    const next = 20 + jsonLength;
    if (next + 8 <= bytes.length && v.getUint32(next + 4, true) === CHUNK_BIN) {
      const binLength = v.getUint32(next, true);
      return { json, binLength, bin: bytes.subarray(next + 8, Math.min(bytes.length, next + 8 + binLength)) };
    }
    return { json, binLength: 0 };
  }
  return { json: JSON.parse(new TextDecoder().decode(bytes)) as Gltf, binLength: 0 };
}

// ------------------------------------------------------------------------------ matrices

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** A node's local matrix (column-major, as glTF stores it) from `matrix` or TRS. */
export function localMatrix(node: Record<string, unknown>): Mat4 {
  if (Array.isArray(node['matrix']) && node['matrix'].length === 16) return (node['matrix'] as unknown[]).map(Number);
  const [tx = 0, ty = 0, tz = 0] = Array.isArray(node['translation']) ? (node['translation'] as number[]) : [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = Array.isArray(node['rotation']) ? (node['rotation'] as number[]) : [];
  const [sx = 1, sy = 1, sz = 1] = Array.isArray(node['scale']) ? (node['scale'] as number[]) : [];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qz * qw) * sx,
    2 * (qx * qz - qy * qw) * sx,
    0,
    2 * (qx * qy - qz * qw) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qx * qw) * sy,
    0,
    2 * (qx * qz + qy * qw) * sz,
    2 * (qy * qz - qx * qw) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}

/** Where a node stands and which way its -z faces on the ground. */
export function poseOf(m: Mat4): Pose {
  const fx = -m[8]!;
  const fz = -m[10]!;
  return { position: [m[12]!, m[13]!, m[14]!], yaw: Math.atan2(-fx, -fz) };
}

// ------------------------------------------------------------------------------- markers

const vec3 = (v: unknown): Vec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as Vec3) : undefined);
const positive = (v: Vec3 | undefined): boolean => !!v && v.every((n) => n > 0 && n <= 10_000);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads a scene's markers and checks its limits. */
export function inspectScene(json: Gltf, file: string): { scene?: SceneInfo; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (code: string, at: string, message: string, severity: Severity = 'error'): void => void problems.push({ code, severity, file, at, message });
  if (typeof json !== 'object' || json === null) {
    add('gltf-syntax', '', 'not a glTF JSON object');
    return { problems };
  }
  if (json.asset?.version !== '2.0') add('gltf-version', 'asset.version', 'only glTF 2.0 is accepted');
  const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as unknown[]) : [];
  for (const ext of required) if (typeof ext !== 'string' || !KNOWN_EXTENSIONS.has(ext)) add('extension-unsupported', 'extensionsRequired', `the scene requires ${String(ext)}, which FlatChat does not support`);
  const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as unknown[]) : [];
  for (const ext of used) if (typeof ext !== 'string' || !KNOWN_EXTENSIONS.has(ext)) add('extension-unknown', 'extensionsUsed', `${String(ext)} is not known here: it will be ignored`, 'warning');

  const needs: string[] = [];
  const uri = (u: unknown, at: string): void => {
    if (u === undefined) return;
    if (typeof u !== 'string') return add('gltf-syntax', at, 'a uri is a string');
    if (u.startsWith('data:')) {
      if (u.length > LIMITS.dataUri * 1.37) add('too-big', at, 'a data: URI over 1 MB: put the data in the GLB or a file beside it');
      return;
    }
    const path = decodeURIComponent(u);
    if (!safePath(path)) return add('uri-external', at, `${u.slice(0, 80)} is not a relative path inside the world folder`);
    needs.push(path);
  };
  json.buffers?.forEach((b, i) => uri(b.uri, `buffers[${i}].uri`));
  json.images?.forEach((im, i) => uri(im.uri, `images[${i}].uri`));

  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  if (nodes.length > LIMITS.nodes) add('too-big', 'nodes', `more than ${LIMITS.nodes} nodes`);
  // World matrices, walking down from the scene's roots (a node reached twice is refused: glTF nodes form a tree).
  const world = new Map<number, Mat4>();
  const visit = (index: unknown, parent: Mat4, path: string): void => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= nodes.length) return add('index-out-of-range', path, `node ${String(index)} does not exist`);
    if (world.has(index)) return add('gltf-syntax', path, `node ${index} has two parents`);
    const node = nodes[index]!;
    const m = multiply(parent, localMatrix(node));
    world.set(index, m);
    if (Array.isArray(node['children'])) (node['children'] as unknown[]).forEach((c, k) => visit(c, m, `nodes[${index}].children[${k}]`));
  };
  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
  const roots = json.scenes?.[sceneIndex]?.nodes;
  if (!Array.isArray(roots)) add('gltf-syntax', 'scenes', 'the scene lists no nodes');
  else roots.forEach((r, k) => visit(r, IDENTITY, `scenes[${sceneIndex}].nodes[${k}]`));

  // Triangles: each mesh's primitives, as many times as nodes use it.
  const meshUses = new Map<number, number>();
  for (const i of world.keys()) {
    const mesh = nodes[i]!['mesh'];
    if (typeof mesh === 'number') meshUses.set(mesh, (meshUses.get(mesh) ?? 0) + 1);
  }
  let triangles = 0;
  for (const [mesh, uses] of meshUses) {
    const m = json.meshes?.[mesh];
    if (!m) {
      add('index-out-of-range', 'meshes', `mesh ${mesh} does not exist`);
      continue;
    }
    for (const p of m.primitives ?? []) {
      const mode = typeof p['mode'] === 'number' ? p['mode'] : 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) continue;
      const accessor = typeof p['indices'] === 'number' ? p['indices'] : isObj(p['attributes']) ? (p['attributes'] as Record<string, unknown>)['POSITION'] : undefined;
      const count = typeof accessor === 'number' ? Number(json.accessors?.[accessor]?.count ?? 0) : 0;
      triangles += (mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2)) * uses;
    }
  }
  if (triangles > LIMITS.triangles) add('too-many-triangles', 'meshes', `${triangles} triangles: a world has at most ${LIMITS.triangles}`);
  else if (triangles > LIMITS.trianglesWarning) add('many-triangles', 'meshes', `${triangles} triangles: above ${LIMITS.trianglesWarning}, weak laptops will struggle`, 'warning');

  // Shapes, on the document.
  const shapes: Shape[] = [];
  const shapeDoc = isObj(json.extensions?.['OMI_physics_shape']) ? (json.extensions!['OMI_physics_shape'] as Record<string, unknown>) : undefined;
  (Array.isArray(shapeDoc?.['shapes']) ? (shapeDoc!['shapes'] as unknown[]) : []).forEach((s, i) => {
    const at = `extensions.OMI_physics_shape.shapes[${i}]`;
    const type = isObj(s) ? s['type'] : undefined;
    const body = isObj(s) && typeof type === 'string' && isObj(s[type]) ? (s[type] as Record<string, unknown>) : {};
    const shape: Shape = { type: type as ShapeType };
    if (type === 'box') {
      shape.size = vec3(body['size']) ?? [1, 1, 1];
      if (!positive(shape.size)) add('marker-invalid', at, 'a box has a positive size');
    } else if (type === 'sphere' || type === 'capsule' || type === 'cylinder') {
      shape.radius = typeof body['radius'] === 'number' ? body['radius'] : 0.5;
      if (type !== 'sphere') shape.height = typeof body['height'] === 'number' ? body['height'] : 2;
      if (!(shape.radius > 0) || (shape.height !== undefined && !(shape.height > 0))) add('marker-invalid', at, `a ${type} has a positive radius and height`);
    } else if (type === 'convex' || type === 'trimesh') {
      shape.mesh = typeof body['mesh'] === 'number' ? body['mesh'] : -1;
      if (shape.mesh < 0 || !json.meshes?.[shape.mesh]) add('index-out-of-range', at, `a ${type} names a mesh that does not exist`);
    } else {
      add('marker-invalid', at, `unknown shape type ${String(type)}`);
    }
    shapes.push(shape);
  });

  const info: SceneInfo = { file, spawns: [], seats: [], shapes, bodies: [], emitters: [], portals: [], zones: [], parts: [], effects: [], triangles, textures: json.images?.length ?? 0, needs };
  const emitterCount = Array.isArray((json.extensions?.['KHR_audio_emitter'] as Record<string, unknown> | undefined)?.['emitters'])
    ? ((json.extensions!['KHR_audio_emitter'] as Record<string, unknown>)['emitters'] as unknown[]).length
    : 0;

  for (const [index, matrix] of world) {
    const ext = nodes[index]!['extensions'];
    if (!isObj(ext)) continue;
    const at = (name: string): string => `nodes[${index}].extensions.${name}`;
    const text = (v: unknown, where: string): string => {
      if (v === undefined) return '';
      if (typeof v !== 'string' || v.length > LIMITS.name || !plainText(v)) {
        add('marker-invalid', where, 'names are plain text of at most 128 characters');
        return '';
      }
      return v;
    };
    if (isObj(ext['OMI_spawn_point'])) {
      const s = ext['OMI_spawn_point'];
      info.spawns.push({ node: index, ...poseOf(matrix), title: text(s['title'], at('OMI_spawn_point')), group: text(s['group'] ?? s['team'], at('OMI_spawn_point')) });
    }
    if (isObj(ext['OMI_seat'])) {
      const s = ext['OMI_seat'];
      const back = vec3(s['back']);
      const foot = vec3(s['foot']);
      const knee = vec3(s['knee']);
      if (!back || !foot || !knee) add('marker-invalid', at('OMI_seat'), 'a seat has back, foot and knee points');
      else info.seats.push({ node: index, matrix, back, foot, knee, angle: typeof s['angle'] === 'number' ? s['angle'] : Math.PI / 2 });
    }
    if (isObj(ext['OMI_physics_body'])) {
      const b = ext['OMI_physics_body'];
      const motionType = isObj(b['motion']) ? b['motion']['type'] : 'static';
      const collider = isObj(b['collider']) ? b['collider']['shape'] : undefined;
      const trigger = isObj(b['trigger']) ? b['trigger']['shape'] : undefined;
      const valid = (n: unknown): boolean => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < shapes.length);
      if (!valid(collider) || !valid(trigger)) add('index-out-of-range', at('OMI_physics_body'), 'a body names a shape that does not exist');
      else if (motionType !== 'static' && motionType !== 'kinematic' && motionType !== 'dynamic') add('marker-invalid', at('OMI_physics_body'), 'motion.type is static, kinematic or dynamic');
      else info.bodies.push({ node: index, matrix, motion: motionType, ...(collider !== undefined ? { collider: collider as number } : {}), ...(trigger !== undefined ? { trigger: trigger as number } : {}) });
    }
    if (isObj(ext['KHR_audio_emitter'])) {
      const e = ext['KHR_audio_emitter']['emitter'];
      if (typeof e !== 'number' || e < 0 || e >= emitterCount) add('index-out-of-range', at('KHR_audio_emitter'), 'a node names an emitter that does not exist');
      else info.emitters.push({ node: index, matrix, emitter: e });
    }
    if (isObj(ext['FLATCHAT_world'])) {
      const f = ext['FLATCHAT_world'];
      if (isObj(f['portal'])) {
        const p = f['portal'];
        const size = vec3(p['size']) ?? [2, 3, 0.5];
        const target = typeof p['world'] === 'string' && /^[0-9a-f-]{36}$/i.test(p['world']) ? p['world'].toLowerCase() : '';
        if (!target) add('marker-invalid', at('FLATCHAT_world.portal'), 'a portal names the world it leads to by its id');
        else if (!positive(size)) add('marker-invalid', at('FLATCHAT_world.portal'), 'a portal has a positive size');
        else info.portals.push({ node: index, matrix, world: target, spawn: text(p['spawn'], at('FLATCHAT_world.portal')), size });
      }
      if (isObj(f['part'])) {
        const id = f['part']['id'];
        if (!isPart(id)) add('marker-invalid', at('FLATCHAT_world.part'), `a part names one of the base library's ids (${String(id).slice(0, 64)} is not one)`);
        else info.parts.push({ node: index, matrix, id });
      }
      if (isObj(f['effect'])) {
        const e = f['effect'];
        const uri = e['uri'];
        const scale = e['scale'] ?? 1;
        const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
        if (typeof uri !== 'string' || !safePath(uri) || !/\.(efkefc|efk)$/i.test(uri)) add('marker-invalid', at('FLATCHAT_world.effect'), 'an effect names its Effekseer file (.efkefc or .efk), a relative path inside the world folder');
        else if (typeof scale !== 'number' || !(scale >= 0.01 && scale <= 100)) add('marker-invalid', at('FLATCHAT_world.effect'), "an effect's scale is 0.01 to 100");
        else {
          info.effects.push({ node: index, matrix, path: base + uri, scale });
          if (!needs.includes(uri)) needs.push(uri);
        }
      }
      if (isObj(f['zone'])) {
        const z = f['zone'];
        const size = vec3(z['size']);
        const kind = z['kind'];
        if (kind !== 'voice' && kind !== 'quiet' && kind !== 'private') add('marker-invalid', at('FLATCHAT_world.zone'), 'a zone is voice, quiet or private');
        else if (!positive(size)) add('marker-invalid', at('FLATCHAT_world.zone'), 'a zone has a positive size');
        else {
          const range = typeof z['range'] === 'number' && z['range'] >= 1 && z['range'] <= 200 ? z['range'] : undefined;
          const gain = typeof z['gain'] === 'number' && z['gain'] >= 0 && z['gain'] <= 4 ? z['gain'] : undefined;
          info.zones.push({ node: index, matrix, kind, size: size!, ...(range !== undefined ? { range } : {}), ...(gain !== undefined ? { gain } : {}) });
        }
      }
    }
  }
  for (const [key, limit] of [
    ['spawns', LIMITS.spawns],
    ['seats', LIMITS.seats],
    ['portals', LIMITS.portals],
    ['zones', LIMITS.zones],
    ['emitters', LIMITS.emitters],
    ['parts', LIMITS.parts],
    ['effects', LIMITS.effects],
  ] as const) {
    if (info[key].length > limit) add('too-big', key, `more than ${limit} ${key}`);
  }
  return { scene: info, problems };
}
