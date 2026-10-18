// SPDX-License-Identifier: MPL-2.0
// FlatChat's converter: world folders into built worlds (S2.03); uploads come in Stage 4.
export { addBox, type MeshSpec, type NodeSpec, writeGlb } from './glb-writer.ts';
export { decodeImage, fitTextures, gpuBytes, halve, type Rgba, type TextureLimits } from './textures.ts';
export { addLevelsOfDetail, type ConvertOptions, type ConvertResult, ConvertError, convertWorld, decompose, LOD_MIN_TRIANGLES, LODS, readFolder, writeBuilt } from './world.ts';
export { AVATAR_CONVERTER_VERSION, AvatarError, type AvatarResult, convertAvatar } from './avatar/convert.ts';
export { type KitBody, kitBody, REFERENCE_POSES } from './item/clipping.ts';
export { convertItem, ITEM_CONVERTER_VERSION, ItemError, type ItemOptions, type ItemResult } from './item/convert.ts';
