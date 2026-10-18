// SPDX-License-Identifier: Apache-2.0
// FlatChat's content formats: the world format (docs/world-format.md), its validator, the built
// world, the solids' binary format and the base library's parts.
export { type Problem, parseManifest, plainText, safePath, type SceneEntry, type Severity, WORLD_FORMAT, type WorldManifest } from './manifest.ts';
export {
  type Body,
  type Emitter,
  type Gltf,
  inspectScene,
  KNOWN_EXTENSIONS,
  LIMITS,
  localMatrix,
  type Mat4,
  multiply,
  type PartPlacement,
  type Portal,
  type Pose,
  poseOf,
  readGltf,
  type SceneInfo,
  type Seat,
  type Shape,
  type ShapeType,
  type SpawnPoint,
  transformPoint,
  type Vec3,
  type Zone,
  type ZoneKind,
} from './scene.ts';
export { FILE_LIMIT, FOLDER_LIMIT, imageSize, validateWorld, type WorldReport } from './validate.ts';
export {
  BUILT_FORMAT,
  type BuiltBox,
  type BuiltEmitter,
  type BuiltFile,
  type BuiltKind,
  type BuiltPart,
  type BuiltPortal,
  type BuiltScene,
  type BuiltSeat,
  type BuiltSpawn,
  type BuiltWorld,
  type BuiltZone,
  insideBox,
  parseBuiltWorld,
  type V3,
} from './built.ts';
export { type Collider, COLLISION_LIMITS, CollisionError, decodeColliders, encodeColliders, type P3, type Quat } from './collision.ts';
export { BASE_PARTS, isPart, MAX_PARTS, PART_COLOURS, type PartBox, type PartColour, type PartDef } from './parts.ts';
export {
  AVATAR_FORMAT,
  AVATAR_LIMITS,
  AVATAR_SOURCE_LIMIT,
  type AvatarLevel,
  type AvatarManifest,
  type AvatarSourceKind,
  type AvatarStats,
  checkAvatarLevel,
  checkManifest,
  LEVEL_EXTENSIONS,
  type Level,
  LEVELS,
  RANK_LIMITS,
  type Rank,
  RANKS,
  rankIndex,
  rankOf,
} from './avatar.ts';
export { MODEL_FROM, type ModelFrom } from './avatar.ts';
export { BLENDER_FORMATS, MODEL_EXTENSIONS, MODEL_FORMAT_NAMES, type UploadFormat, uploadFormat } from './formats.ts';
export { checkFingerprint, type Fingerprint, FingerprintError, matchOf, SHAPE_MATCH, SHAPE_MIN_TOKENS, SHAPE_SLOTS, shapeSimilarity, TEXTURE_MATCH_BITS, TEXTURE_MAX, textureDistance } from './fingerprint.ts';
export {
  BODY_KITS,
  type BodyKit,
  checkItemFit,
  checkItemManifest,
  checkItemProp,
  fileDeclaration,
  ITEM_EXTENSIONS,
  ITEM_FORMAT,
  ITEM_SOURCE_LIMIT,
  type ItemClipping,
  type ItemDeclaration,
  type ItemFit,
  ItemFormatError,
  type ItemManifest,
  KIT_BONES,
  outfitProblems,
  readItemDeclaration,
  type Region,
  REGIONS,
  regionOfBone,
  resolveOutfit,
  type Slot,
  SLOT_REPLACES,
  SLOTS,
} from './item.ts';
export { compositeSkin, LAYER_KINDS, LayerError, type LayerKind, type RgbaImage, type SkinComposite, type SkinLayer } from './layers.ts';
export { ADJUST_LIMITS, type AttachAdjustment, attachBone, attachMatrix, type AttachPoint, ATTACH_POINTS, fitAdjustment, fitWornAdjust, type Matrix4, NO_ADJUSTMENT, type WornAdjust, wornAdjustment, WORN_LIMITS } from './attach.ts';
export { AVATAR_PERMISSIONS, COMMERCIAL_USAGES, CREDIT_NOTATIONS, galleryProblems, type Licence, LicenceError, licenceOfFile, looserThan, MODIFICATIONS, readLicence, STRICT_LICENCE, USAGE_FLAGS } from './licence.ts';
export { ANIMATION_AUDIO_LIMIT, ANIMATION_AUDIO_TYPES, ANIMATION_EXTENSIONS, ANIMATION_FORMAT, type AnimationAudioType, RHUBARB_SHAPES, type Viseme, VISEMES, ANIMATION_FPS, ANIMATION_MAX_SECONDS, ANIMATION_SOURCE_LIMIT, ANIMATION_SOURCES, ANIMATION_USES, type AnimationManifest, type AnimationSource, type AnimationUse, checkAnimationFile, checkAnimationManifest, VRMC_VRM_ANIMATION } from './animation.ts';
