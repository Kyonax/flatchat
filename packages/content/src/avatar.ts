// SPDX-License-Identifier: Apache-2.0
// Avatars as the platform keeps them (Stage 4): the manifest the converter writes beside an
// avatar's files, and the performance ranks (G-18, Q-M3). The ranks start from VRChat's published
// PC limits (rr-002) and are to be tuned on the reference laptop (S0.09's stand-in runs); an avatar
// takes the worst rank of any of its numbers. Everything here is shared by the converter, the core
// and the client, so all three agree on what an avatar is and how heavy it counts.

/** The manifest's format: the converter's output for this version of the platform. */
export const AVATAR_FORMAT = 1;
/** The largest file the platform takes for conversion. */
export const AVATAR_SOURCE_LIMIT = 64 * 1024 * 1024;

export const RANKS = ['excellent', 'good', 'medium', 'poor', 'veryPoor'] as const;
export type Rank = (typeof RANKS)[number];

/** What an avatar's rank is measured on. */
export interface AvatarStats {
  triangles: number;
  vertices: number;
  /** Texture memory on the GPU once compressed, with mipmaps, in bytes. */
  textureBytes: number;
  skinnedMeshes: number;
  basicMeshes: number;
  /** Primitives: one material slot (and one draw call) each. */
  materialSlots: number;
  /** The bones the skins use. */
  bones: number;
  morphTargets: number;
  /** Spring bone chains, the joints they move, their colliders, and joint-collider pairs checked. */
  springs: number;
  springJoints: number;
  colliders: number;
  collisionChecks: number;
}

type Limits = Omit<AvatarStats, 'vertices' | 'morphTargets'>;
const MB = 1024 * 1024;

/** The highest number each rank allows (VRChat's PC table; above `poor` is `veryPoor`). */
export const RANK_LIMITS: Record<Exclude<Rank, 'veryPoor'>, Limits> = {
  excellent: { triangles: 32_000, textureBytes: 40 * MB, skinnedMeshes: 1, basicMeshes: 4, materialSlots: 4, bones: 75, springs: 4, springJoints: 16, colliders: 4, collisionChecks: 32 },
  good: { triangles: 70_000, textureBytes: 75 * MB, skinnedMeshes: 2, basicMeshes: 8, materialSlots: 8, bones: 150, springs: 8, springJoints: 64, colliders: 8, collisionChecks: 128 },
  medium: { triangles: 70_000, textureBytes: 110 * MB, skinnedMeshes: 8, basicMeshes: 16, materialSlots: 16, bones: 256, springs: 16, springJoints: 128, colliders: 16, collisionChecks: 256 },
  poor: { triangles: 70_000, textureBytes: 150 * MB, skinnedMeshes: 16, basicMeshes: 24, materialSlots: 32, bones: 400, springs: 32, springJoints: 256, colliders: 32, collisionChecks: 512 },
};

/** Hard limits: an avatar over any of these is refused, not ranked. */
export const AVATAR_LIMITS = {
  triangles: 1_000_000,
  vertices: 2_000_000,
  nodes: 4096,
  meshes: 256,
  materials: 64,
  textures: 64,
  textureSide: 8192,
  skins: 32,
  jointsPerSkin: 1024,
  morphTargets: 512,
  springJoints: 2048,
  colliders: 256,
} as const;

/** The rank of an avatar, and the numbers that set it (those past the next better rank). */
export function rankOf(stats: AvatarStats): { rank: Rank; limitedBy: Array<keyof Limits> } {
  const keys = Object.keys(RANK_LIMITS.excellent) as Array<keyof Limits>;
  for (const rank of ['excellent', 'good', 'medium', 'poor'] as const) {
    const over = keys.filter((k) => stats[k] > RANK_LIMITS[rank][k]);
    if (over.length === 0) {
      const better = RANKS[RANKS.indexOf(rank) - 1] as Exclude<Rank, 'veryPoor'> | undefined;
      return { rank, limitedBy: better ? keys.filter((k) => stats[k] > RANK_LIMITS[better][k]) : [] };
    }
  }
  return { rank: 'veryPoor', limitedBy: keys.filter((k) => stats[k] > RANK_LIMITS.poor[k]) };
}

/** Ranks ordered from best (0) to worst (4), for a viewer's minimum. */
export function rankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

export type AvatarSourceKind = 'vrm0' | 'vrm1' | 'glb';
export const LEVELS = ['lod0', 'lod1', 'lod2', 'impostor'] as const;
export type Level = (typeof LEVELS)[number];

/** One level of an avatar: its file (by SHA-256) and its numbers. */
export interface AvatarLevel {
  file: string;
  bytes: number;
  triangles: number;
  bones: number;
  materialSlots: number;
  textureBytes: number;
}

/** What the converter writes beside an avatar's files (manifest.json, also named by its hash). */
export interface AvatarManifest {
  format: typeof AVATAR_FORMAT;
  /** The converter's version: a new one may convert the same source differently. */
  converter: string;
  source: { sha256: string; bytes: number; kind: AvatarSourceKind; generator: string };
  name: string;
  /** The licence terms as the file stated them (VRM meta), unchanged; the gallery shows them. */
  licence: Record<string, string | number | boolean | string[]>;
  stats: AvatarStats;
  rank: Rank;
  limitedBy: string[];
  levels: Record<Level, AvatarLevel>;
  /** A small picture (PNG, by SHA-256), when the file had one. */
  thumbnail?: string;
  /** The humanoid bones it has, the expressions it can make, and its height in metres. */
  bones: string[];
  /** A body on the humanoid, or a free shape (a robot, a creature, a prop) the converter
   *  completed with empty bones (S4.11); left out by earlier converters: humanoid. */
  shape?: 'humanoid' | 'free';
  expressions: string[];
  height: number;
  /** Spring bones, for the client's per-rank budgets (S4.08). */
  springs: number;
  warnings: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Checks a manifest that came from elsewhere (the core's store, a cache): its shape and its
 *  numbers, never trusting it further than that. */
export function checkManifest(value: unknown): AvatarManifest {
  const m = value as AvatarManifest;
  const ok =
    !!m &&
    typeof m === 'object' &&
    m.format === AVATAR_FORMAT &&
    typeof m.name === 'string' &&
    m.name.length <= 200 &&
    RANKS.includes(m.rank) &&
    !!m.levels &&
    LEVELS.every((l) => {
      const level = m.levels[l];
      return !!level && HEX64.test(level.file) && Number.isFinite(level.triangles) && level.triangles >= 0 && level.triangles <= AVATAR_LIMITS.triangles;
    }) &&
    (m.thumbnail === undefined || HEX64.test(m.thumbnail)) &&
    Array.isArray(m.bones) &&
    (m.shape === undefined || m.shape === 'humanoid' || m.shape === 'free') &&
    Array.isArray(m.expressions) &&
    Number.isFinite(m.height);
  if (!ok) throw new Error('not an avatar manifest of this format');
  return m;
}

/** The extensions an avatar level may use: the converter writes no others. */
export const LEVEL_EXTENSIONS: ReadonlySet<string> = new Set([
  'VRMC_vrm',
  'VRMC_springBone',
  'VRMC_materials_mtoon',
  'VRMC_node_constraint',
  'VRMC_materials_hdr_emissiveMultiplier',
  'KHR_texture_basisu',
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'EXT_meshopt_compression',
]);

/** A level the client is about to parse, checked first (it came from the core's store by its
 *  hash, so this guards the parser, not the content): one GLB, everything inside it, VRM 1.0,
 *  only the converter's extensions, within the hard limits. Throws with the reason. */
export function checkAvatarLevel(json: Record<string, unknown>): void {
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if ((json['asset'] as { version?: unknown } | undefined)?.version !== '2.0') throw new Error('not glTF 2.0');
  if ([...list('buffers'), ...list('images')].some((x) => x['uri'] !== undefined)) throw new Error('an avatar level keeps every buffer and image inside it');
  const used = (json['extensionsUsed'] ?? []) as unknown[];
  for (const e of used) if (typeof e !== 'string' || !LEVEL_EXTENSIONS.has(e)) throw new Error(`an extension the converter does not write: ${String(e)}`);
  const vrm = (json['extensions'] as Record<string, { specVersion?: unknown }> | undefined)?.['VRMC_vrm'];
  if (vrm?.specVersion !== '1.0') throw new Error('not a VRM 1.0 avatar');
  const over = (n: number, max: number, what: string): void => {
    if (n > max) throw new Error(`${n} ${what}, over ${max}`);
  };
  over(list('nodes').length, AVATAR_LIMITS.nodes, 'nodes');
  over(list('meshes').length, AVATAR_LIMITS.meshes, 'meshes');
  over(list('materials').length, AVATAR_LIMITS.materials, 'materials');
  over(list('images').length, AVATAR_LIMITS.textures, 'textures');
  over(list('skins').length, AVATAR_LIMITS.skins, 'skins');
}

