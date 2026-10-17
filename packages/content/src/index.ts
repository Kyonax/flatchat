// SPDX-License-Identifier: Apache-2.0
// FlatChat's content formats: the world format (docs/world-format.md) and its validator.
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
