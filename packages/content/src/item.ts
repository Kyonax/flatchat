// SPDX-License-Identifier: Apache-2.0
// Items for the three standard bodies (Stage 5: S5.02, dp-001, dp-002, ad-008): clothes, hair, hats
// and glasses. An item declares the bodies it fits and carries one fitted mesh per body (made on
// the kits in kits/bodies/, refitted between them at authoring time, never at runtime: cl-004),
// fills one fixed slot, and names the body's regions it hides. Shared by the converter, the core
// and the client, so all three agree on what an item is and what it may weigh.
import { ATTACH_POINTS, type AttachPoint } from './attach.ts';

/** The manifest's format: the converter's output for this version of the platform. */
export const ITEM_FORMAT = 1;
/** The largest item file the platform takes for conversion. */
export const ITEM_SOURCE_LIMIT = 32 * 1024 * 1024;

/** The three standard bodies (kits/bodies/; OQ-28's default), by the names their fits use. */
export const BODY_KITS = ['feminine', 'masculine', 'neutral'] as const;
export type BodyKit = (typeof BODY_KITS)[number];

/** The kits' rig (MPFB's game_engine): every fit is skinned to these bones, by name. */
export const KIT_BONES: readonly string[] = [
  'Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  ...['l', 'r'].flatMap((s) => [
    `clavicle_${s}`, `upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`,
    ...['thumb', 'index', 'middle', 'ring', 'pinky'].flatMap((f) => [`${f}_01_${s}`, `${f}_02_${s}`, `${f}_03_${s}`]),
    `thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`,
  ]),
];

/** The body's regions an item may hide: each is the vertices the named bones move most, the rule
 *  the kits' mask_* vertex groups were made with (tools/blender/bodykit/generate.py). Hiding is by
 *  whole region, so they are cut where garments end: a tee ends at the waist (chest and belly),
 *  trousers start at the hips. */
export const REGIONS = {
  head: ['head', 'neck_01'],
  chest: ['spine_02', 'spine_03', 'clavicle_l', 'clavicle_r'],
  belly: ['spine_01'],
  hips: ['pelvis'],
  upper_arm_l: ['upperarm_l'],
  upper_arm_r: ['upperarm_r'],
  lower_arm_l: ['lowerarm_l'],
  lower_arm_r: ['lowerarm_r'],
  hand_l: ['hand_l', 'thumb_01_l', 'thumb_02_l', 'thumb_03_l', 'index_01_l', 'index_02_l', 'index_03_l', 'middle_01_l', 'middle_02_l', 'middle_03_l', 'ring_01_l', 'ring_02_l', 'ring_03_l', 'pinky_01_l', 'pinky_02_l', 'pinky_03_l'],
  hand_r: ['hand_r', 'thumb_01_r', 'thumb_02_r', 'thumb_03_r', 'index_01_r', 'index_02_r', 'index_03_r', 'middle_01_r', 'middle_02_r', 'middle_03_r', 'ring_01_r', 'ring_02_r', 'ring_03_r', 'pinky_01_r', 'pinky_02_r', 'pinky_03_r'],
  upper_leg_l: ['thigh_l'],
  upper_leg_r: ['thigh_r'],
  lower_leg_l: ['calf_l'],
  lower_leg_r: ['calf_r'],
  foot_l: ['foot_l', 'ball_l'],
  foot_r: ['foot_r', 'ball_r'],
} as const satisfies Record<string, readonly string[]>;
export type Region = keyof typeof REGIONS;
const BONE_REGION = new Map<string, Region>(Object.entries(REGIONS).flatMap(([r, bones]) => bones.map((b) => [b, r as Region] as const)));

/** The region a bone's vertices belong to, if any (Root moves none). */
export function regionOfBone(bone: string): Region | undefined {
  return BONE_REGION.get(bone);
}

/** The fixed slots, one item each, and what an item may weigh in each, per fit (G-18's budgets,
 *  to tune on the reference laptop like the avatars' ranks). */
export const SLOTS = {
  hair: { triangles: 12_000, materials: 2, textureSide: 1024 },
  hat: { triangles: 3_000, materials: 1, textureSide: 1024 },
  glasses: { triangles: 1_500, materials: 1, textureSide: 512 },
  top: { triangles: 8_000, materials: 2, textureSide: 1024 },
  outer: { triangles: 10_000, materials: 2, textureSide: 1024 },
  bottom: { triangles: 6_000, materials: 2, textureSide: 1024 },
  full: { triangles: 14_000, materials: 2, textureSide: 1024 },
  gloves: { triangles: 3_000, materials: 1, textureSide: 512 },
  legwear: { triangles: 3_000, materials: 1, textureSide: 1024 },
  shoes: { triangles: 4_000, materials: 1, textureSide: 1024 },
  /** A prop at an attachment point (S5.04): one rigid mesh, worn on any avatar, free shapes too. */
  attachment: { triangles: 3_000, materials: 1, textureSide: 512 },
} as const satisfies Record<string, { triangles: number; materials: number; textureSide: number }>;
export type Slot = keyof typeof SLOTS;
/** Slots worn instead of others: a full outfit (a dress, a jumpsuit) takes the top and the bottom. */
export const SLOT_REPLACES: Partial<Record<Slot, readonly Slot[]>> = { full: ['top', 'bottom'] };

/** What stops a set of items being worn together (S5.05): one item to a slot, one prop to an
 *  attachment point, and a full outfit with no top or bottom beside it (SLOT_REPLACES). The client
 *  keeps an outfit within these when a toggle puts an item on (it takes the place of the one it
 *  conflicts with); the core refuses a saved outfit that breaks them. Empty when they can be worn. */
export function outfitProblems(worn: ReadonlyArray<{ slot: Slot; attach?: AttachPoint | undefined }>): string[] {
  const problems: string[] = [];
  const taken = new Map<string, number>();
  for (const w of worn) {
    const key = w.slot === 'attachment' ? `attachment at ${w.attach ?? '?'}` : w.slot;
    taken.set(key, (taken.get(key) ?? 0) + 1);
  }
  for (const [key, n] of taken) if (n > 1) problems.push(`${n} items in one ${key.startsWith('attachment') ? key : `${key} slot`}`);
  for (const [slot, replaced] of Object.entries(SLOT_REPLACES)) {
    if (!taken.has(slot)) continue;
    for (const r of replaced) if (taken.has(r)) problems.push(`a ${slot} item takes the ${r} slot too`);
  }
  return problems;
}

/** An outfit made wearable (S5.05): where items conflict (outfitProblems), the one worn later wins,
 *  as a toggle that puts an item on takes the place of the one it conflicts with. Keeps the order. */
export function resolveOutfit<T extends { slot: Slot; attach?: AttachPoint | undefined }>(worn: readonly T[]): T[] {
  const kept: T[] = [];
  const taken = new Set<string>();
  const replacedBy = (slot: Slot): Slot[] => Object.entries(SLOT_REPLACES).flatMap(([s, rs]) => ((rs as readonly Slot[]).includes(slot) ? [s as Slot] : []));
  for (let i = worn.length - 1; i >= 0; i--) {
    const w = worn[i]!;
    const key = w.slot === 'attachment' ? `attachment at ${w.attach ?? '?'}` : w.slot;
    if (taken.has(key)) continue;
    // A later top or bottom displaces an earlier full item; a later full item, an earlier top or bottom.
    if ((SLOT_REPLACES[w.slot] ?? []).some((r) => taken.has(r)) || replacedBy(w.slot).some((s) => taken.has(s))) continue;
    taken.add(key);
    kept.push(w);
  }
  return kept.reverse();
}

/** What a creator's file declares: `extras.flatchat_item` on its scene (a Blender scene's custom
 *  property) or on the file itself. */
export interface ItemDeclaration {
  name: string;
  slot: Slot;
  hides: Region[];
  authors: string[];
  /** For the attachment slot: the point it is worn at. */
  attach?: AttachPoint;
}

export class ItemFormatError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/** Reads and checks a declaration (refusing with every problem at once). */
export function readItemDeclaration(value: unknown): ItemDeclaration {
  const problems: string[] = [];
  const d = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const name = typeof d['name'] === 'string' ? d['name'].trim() : '';
  if (name.length < 1 || name.length > 80) problems.push('an item needs a name of 1 to 80 characters');
  const slot = d['slot'];
  if (typeof slot !== 'string' || !(slot in SLOTS)) problems.push(`slot ${JSON.stringify(slot)} is not one of ${Object.keys(SLOTS).join(', ')}`);
  const hides = Array.isArray(d['hides']) ? d['hides'] : [];
  for (const h of hides) if (typeof h !== 'string' || !(h in REGIONS)) problems.push(`"${String(h)}" is not a region an item can hide (${Object.keys(REGIONS).join(', ')})`);
  const authors = Array.isArray(d['authors']) ? d['authors'].filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()) : [];
  const attach = d['attach'];
  if (slot === 'attachment') {
    if (typeof attach !== 'string' || !(attach in ATTACH_POINTS)) problems.push(`an attachment names the point it is worn at: one of ${Object.keys(ATTACH_POINTS).join(', ')}`);
    if (hides.length) problems.push('an attachment hides nothing of the body');
  } else if (attach !== undefined) problems.push('only the attachment slot is worn at a point');
  if (problems.length) throw new ItemFormatError(problems);
  return { name, slot: slot as Slot, hides: [...new Set(hides as Region[])].sort(), authors, ...(slot === 'attachment' ? { attach: attach as AttachPoint } : {}) };
}

/** One body's fit as the platform keeps it. */
export interface ItemFit {
  /** The fit's file: its SHA-256. */
  file: string;
  bytes: number;
  triangles: number;
  materialSlots: number;
  textureBytes: number;
  joints: number;
}

/** What the converter found in the reference poses (S5.02's no-clipping check). */
export interface ItemClipping {
  poses: number;
  /** Visible body vertices within reach of the garment, over every pose. */
  checked: number;
  /** Of those, the ones out through the garment by more than the tolerance. */
  through: number;
  /** The farthest any came out, in millimetres. */
  worstMm: number;
}

export interface ItemManifest {
  format: typeof ITEM_FORMAT;
  kind: 'item';
  converter: string;
  source: { sha256: string; bytes: number };
  name: string;
  authors: string[];
  slot: Slot;
  hides: Region[];
  fits: Partial<Record<BodyKit, ItemFit>>;
  clipping: Partial<Record<BodyKit, ItemClipping>>;
  /** For the attachment slot: its point, and its one rigid mesh (worn on any avatar). */
  attach?: AttachPoint;
  prop?: ItemFit;
  warnings: string[];
}

/** Checks a manifest from the core before the client trusts it. */
export function checkItemManifest(value: unknown): ItemManifest {
  const m = value as ItemManifest;
  if (typeof m !== 'object' || m === null || m.format !== ITEM_FORMAT || m.kind !== 'item') throw new Error('not an item manifest of this format');
  readItemDeclaration({ name: m.name, slot: m.slot, hides: m.hides, authors: m.authors, ...(m.attach ? { attach: m.attach } : {}) });
  if (m.slot === 'attachment') {
    if (typeof m.prop?.file !== 'string' || !/^[0-9a-f]{64}$/.test(m.prop.file)) throw new Error('an attachment has its prop');
    return m;
  }
  const fits = Object.entries(m.fits ?? {});
  if (fits.length === 0) throw new Error('an item fits at least one body');
  for (const [body, fit] of fits) {
    if (!(BODY_KITS as readonly string[]).includes(body)) throw new Error(`no body named ${body}`);
    if (typeof fit?.file !== 'string' || !/^[0-9a-f]{64}$/.test(fit.file)) throw new Error(`${body}: not a file hash`);
  }
  return m;
}

/** The extensions a converted fit may carry. */
export const ITEM_EXTENSIONS: ReadonlySet<string> = new Set(['KHR_texture_basisu', 'KHR_materials_unlit', 'KHR_texture_transform', 'VRMC_materials_mtoon']);

/** The client's check on an attachment's prop: glTF 2.0, everything inside, only the converter's
 *  extensions, meshes and no skin (it is carried whole at its point). */
export function checkItemProp(json: Record<string, unknown>): void {
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if ((json['asset'] as { version?: unknown } | undefined)?.version !== '2.0') throw new Error('not glTF 2.0');
  if ([...list('buffers'), ...list('images')].some((x) => x['uri'] !== undefined)) throw new Error('a prop keeps every buffer and image inside it');
  for (const e of (json['extensionsUsed'] ?? []) as unknown[]) if (typeof e !== 'string' || !ITEM_EXTENSIONS.has(e)) throw new Error(`an extension the converter does not write: ${String(e)}`);
  if (list('meshes').length < 1 || list('skins').length > 0) throw new Error('a prop is rigid meshes, no skin');
}

/** The client's check on a fit's glTF JSON before three.js reads it: glTF 2.0, everything inside,
 *  only the converter's extensions, one skinned mesh on the kits' bones. */
export function checkItemFit(json: Record<string, unknown>): void {
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if ((json['asset'] as { version?: unknown } | undefined)?.version !== '2.0') throw new Error('not glTF 2.0');
  if ([...list('buffers'), ...list('images')].some((x) => x['uri'] !== undefined)) throw new Error('an item keeps every buffer and image inside it');
  for (const e of (json['extensionsUsed'] ?? []) as unknown[]) if (typeof e !== 'string' || !ITEM_EXTENSIONS.has(e)) throw new Error(`an extension the converter does not write: ${String(e)}`);
  const skins = list('skins');
  if (skins.length !== 1 || list('meshes').length < 1) throw new Error('a fit is one skinned mesh');
  const nodes = list('nodes');
  const bones = new Set(KIT_BONES);
  for (const j of (skins[0]!['joints'] as number[]) ?? []) {
    const name = nodes[j]?.['name'];
    if (typeof name !== 'string' || !bones.has(name)) throw new Error(`a joint the kits do not have: ${String(name)}`);
  }
}
