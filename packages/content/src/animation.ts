// SPDX-License-Identifier: Apache-2.0
// Emotes and dances (S5.07, ad-009, Q-M5): every imported animation becomes VRMA (VRM Animation
// 1.0, VRMC_vrm_animation), the platform's own animation format: a humanoid skeleton standing in a
// T-pose and its bones' rotations (the hips' position too) over time, which three-vrm-animation
// retargets onto any VRM avatar. Shared by the converter, the core and the client, so all three
// agree on what an animation is, what it may weigh and how the client checks the file before
// three.js reads it.

/** The manifest's format: the converter's output for this version of the platform. */
export const ANIMATION_FORMAT = 1;
/** The largest animation file the platform takes for conversion (a long FBX dance with its mesh). */
export const ANIMATION_SOURCE_LIMIT = 64 * 1024 * 1024;
/** The longest animation, in seconds, and the frames a second it is sampled at. */
export const ANIMATION_MAX_SECONDS = 120;
export const ANIMATION_FPS = 30;
/** The source formats: VRMA, a glTF or GLB clip on a humanoid rig, BVH motion capture, FBX
 *  (through headless Blender, DR-15). */
export const ANIMATION_SOURCES = ['vrma', 'gltf', 'bvh', 'fbx'] as const;
export type AnimationSource = (typeof ANIMATION_SOURCES)[number];
/** What it is for: an emote plays once (or until the player moves), a dance loops. */
export const ANIMATION_USES = ['emote', 'dance'] as const;
export type AnimationUse = (typeof ANIMATION_USES)[number];

/** A dance's or an emote's sound (S5.07): WAV (PCM) or Ogg (Vorbis or Opus), 8 MB at most, no
 *  longer than an animation may be. Its mouth track is baked offline by Rhubarb Lip Sync (MIT). */
export const ANIMATION_AUDIO_LIMIT = 8 * 1024 * 1024;
export const ANIMATION_AUDIO_TYPES = ['audio/wav', 'audio/ogg'] as const;
export type AnimationAudioType = (typeof ANIMATION_AUDIO_TYPES)[number];
/** The mouth shapes VRM expressions carry, which a sound's mouth track moves. */
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];
/** Rhubarb's mouth shapes (A to F, the extended G, H and X) as VRM visemes: A closed (P, B, M), B
 *  slightly open (most consonants, EE), C open (EH, AE), D wide (AA), E rounded (AO, ER), F
 *  puckered (UW, OW, W), G teeth on the lip (F, V), H the tongue up (L), X at rest. */
export const RHUBARB_SHAPES: Record<string, Partial<Record<Viseme, number>>> = {
  A: {},
  B: { ih: 0.5 },
  C: { ee: 0.6, aa: 0.2 },
  D: { aa: 1 },
  E: { oh: 0.8 },
  F: { ou: 1 },
  G: { ih: 0.3 },
  H: { aa: 0.4 },
  X: {},
};

export const VRMC_VRM_ANIMATION = 'VRMC_vrm_animation';
/** The extensions a converted animation may carry. */
export const ANIMATION_EXTENSIONS: ReadonlySet<string> = new Set([VRMC_VRM_ANIMATION]);

export interface AnimationManifest {
  format: typeof ANIMATION_FORMAT;
  kind: 'animation';
  converter: string;
  source: { sha256: string; bytes: number; format: AnimationSource };
  name: string;
  use: AnimationUse;
  /** Its first and last poses meet (within 2°): it can repeat without a jump. */
  loop: boolean;
  /** Seconds. */
  duration: number;
  /** The humanoid bones it moves. */
  bones: string[];
  /** The VRMA file, by its SHA-256, and its size. */
  file: string;
  bytes: number;
  /** Its sound, played with it at the player (S5.07), when it has one. */
  audio?: { file: string; bytes: number; type: AnimationAudioType; duration: number };
  /** The VRMA moves the mouth with the sound (a Rhubarb track baked into its expressions). */
  mouth: boolean;
  warnings: string[];
}

/** Checks a manifest from the core before the client trusts it. */
export function checkAnimationManifest(value: unknown): AnimationManifest {
  const m = value as AnimationManifest;
  if (typeof m !== 'object' || m === null || m.format !== ANIMATION_FORMAT || m.kind !== 'animation') throw new Error('not an animation manifest of this format');
  if (typeof m.file !== 'string' || !/^[0-9a-f]{64}$/.test(m.file)) throw new Error('an animation has its file');
  if (!(ANIMATION_USES as readonly unknown[]).includes(m.use)) throw new Error(`use "${String(m.use)}" is not one of ${ANIMATION_USES.join(', ')}`);
  if (typeof m.duration !== 'number' || !(m.duration > 0) || m.duration > ANIMATION_MAX_SECONDS + 1) throw new Error('a duration of up to two minutes');
  if (!Array.isArray(m.bones) || m.bones.some((b) => typeof b !== 'string')) throw new Error('the bones it moves');
  if (m.audio !== undefined) {
    const a = m.audio;
    if (typeof a?.file !== 'string' || !/^[0-9a-f]{64}$/.test(a.file) || !(ANIMATION_AUDIO_TYPES as readonly unknown[]).includes(a.type) || !(a.bytes > 0) || a.bytes > ANIMATION_AUDIO_LIMIT || !(a.duration > 0) || a.duration > ANIMATION_MAX_SECONDS + 1) throw new Error('its sound is a WAV or Ogg file of up to two minutes');
  }
  if (typeof m.mouth !== 'boolean') throw new Error('whether it moves the mouth');
  return m;
}

/** The client's check on a VRMA file's glTF JSON before three.js reads it: glTF 2.0, everything
 *  inside, only VRMC_vrm_animation, no meshes, skins, materials or images (an animation is bones
 *  and their motion), one animation, a humanoid whose bones are real nodes. */
export function checkAnimationFile(json: Record<string, unknown>): void {
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if ((json['asset'] as { version?: unknown } | undefined)?.version !== '2.0') throw new Error('not glTF 2.0');
  if (list('buffers').some((x) => x['uri'] !== undefined)) throw new Error('an animation keeps its data inside it');
  for (const e of (json['extensionsUsed'] ?? []) as unknown[]) if (typeof e !== 'string' || !ANIMATION_EXTENSIONS.has(e)) throw new Error(`an extension the converter does not write: ${String(e)}`);
  for (const k of ['meshes', 'skins', 'materials', 'images', 'textures', 'cameras']) if (list(k).length > 0) throw new Error(`an animation has no ${k}`);
  if (list('animations').length !== 1) throw new Error('an animation file holds one animation');
  const ext = (json['extensions'] as Record<string, unknown> | undefined)?.[VRMC_VRM_ANIMATION] as { humanoid?: { humanBones?: Record<string, { node?: unknown }> } } | undefined;
  const bones = ext?.humanoid?.humanBones;
  if (!bones || typeof bones !== 'object') throw new Error('no humanoid in the animation');
  const nodes = list('nodes').length;
  for (const [bone, ref] of Object.entries(bones)) {
    if (typeof ref?.node !== 'number' || !Number.isInteger(ref.node) || ref.node < 0 || ref.node >= nodes) throw new Error(`the ${bone} bone is not a node`);
  }
  if (!bones['hips']) throw new Error('an animation moves the hips');
  const expressions = (ext as { expressions?: { preset?: Record<string, { node?: unknown }> } }).expressions?.preset ?? {};
  for (const [name, ref] of Object.entries(expressions)) {
    if (!(VISEMES as readonly string[]).includes(name)) throw new Error(`an expression the converter does not write: ${name}`);
    if (typeof ref?.node !== 'number' || !Number.isInteger(ref.node) || ref.node < 0 || ref.node >= nodes) throw new Error(`the ${name} expression is not a node`);
  }
}
