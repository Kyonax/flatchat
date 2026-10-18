// SPDX-License-Identifier: MPL-2.0
// Collada (DAE) into GLB (S5.08): assimp's importer, compiled to WebAssembly by assimpjs (MIT; assimp
// BSD-3-Clause), runs inside the converter's own process and sandbox: no other program, no network.
// Blender 5 removed its Collada importer, so DAE (Second Life's mesh format) comes this way. Images
// a DAE names by path stay behind: one file is uploaded, so the model arrives without them.
import { createRequire } from 'node:module';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld } from '@gltf-transform/functions';

interface AssimpResult {
  IsSuccess(): boolean;
  GetErrorCode(): string;
  FileCount(): number;
  GetFile(i: number): { GetContent(): Uint8Array };
}
interface Assimp {
  FileList: new () => { AddFile(name: string, bytes: Uint8Array): void };
  ConvertFileList(list: unknown, format: string): AssimpResult;
}

let assimp: Promise<Assimp> | undefined;

export class DaeError extends Error {}

/** What assimp writes on every material from Collada's defaults (an index of refraction of 1),
 *  which the platform's avatars and items do not carry: left out here, not warned about. */
const ASSIMP_DEFAULTS = new Set(['KHR_materials_ior', 'KHR_materials_volume']);

export async function daeToGlb(bytes: Uint8Array): Promise<Uint8Array> {
  assimp ??= (createRequire(import.meta.url)('assimpjs') as () => Promise<Assimp>)();
  const ajs = await assimp;
  const list = new ajs.FileList();
  list.AddFile('model.dae', bytes);
  const r = ajs.ConvertFileList(list, 'glb2');
  if (!r.IsSuccess() || r.FileCount() === 0) throw new DaeError(`assimp could not read the Collada file (${r.GetErrorCode()})`);
  // assimp's GLB keeps every corner of every triangle as a vertex of its own: joined again, the
  // levels of detail can be simplified like any other model's.
  // (assimp names FB_ngon_encoding, which glTF Transform does not know and leaves out unasked.)
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(r.GetFile(0).GetContent());
  for (const e of doc.getRoot().listExtensionsUsed()) if (ASSIMP_DEFAULTS.has(e.extensionName)) e.dispose();
  await doc.transform(weld());
  return io.writeBinary(doc);
}
