// SPDX-License-Identifier: MPL-2.0
// Items for the three standard bodies (S5.02, dp-001, dp-002): a creator's GLB becomes one clean
// file per fit and a manifest. The file holds one skinned mesh per body it fits (its node's
// extras.flatchat_fit names the body: feminine, masculine or neutral), each skinned to the kits'
// bones by name (made on kits/bodies/), and declares itself in extras.flatchat_item on its scene
// or on the file: { name, slot, hides, authors }. Khronos glTF-Validator first; then the
// declaration, the fits and the slot's caps; then each fit alone, cleaned, its textures fitted (and
// KTX2), checked with the client's own check; and, when the kits are at hand, each fit worn on its
// body in the reference poses (clipping.ts). Every file is named by its SHA-256.
import { createHash } from 'node:crypto';
import type { Document, Node } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { BODY_KITS, type BodyKit, checkItemFit, checkItemProp, ITEM_EXTENSIONS, ITEM_FORMAT, ITEM_SOURCE_LIMIT, type ItemClipping, type ItemDeclaration, type ItemFit, ItemFormatError, type ItemManifest, KIT_BONES, readGltf, readItemDeclaration, SLOTS } from '@flatchat/content';
import { avatarIO, validateGltf } from '../avatar/convert.ts';
import { fitTextures } from '../textures.ts';
import { CLIP_TOLERANCE, clippingOf, type KitBody, skeletonOffset } from './clipping.ts';

export const ITEM_CONVERTER_VERSION = '1.0.0';

export class ItemError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

export interface ItemResult {
  manifest: ItemManifest;
  manifestBytes: Uint8Array;
  id: string;
  files: Map<string, Uint8Array>;
}

export interface ItemOptions {
  ktx2?: boolean;
  /** The standard bodies, for the clipping check (kits/bodies/, read with kitBody). */
  kits?: Partial<Record<BodyKit, KitBody>>;
}

/** What refuses an item in the reference poses: more than CLIP_REFUSE_POINTS body points out
 *  through a fit and over CLIP_REFUSE_SHARE of those within reach (skin showing through in
 *  ordinary poses), or any point out by CLIP_REFUSE_DEPTH (a limb through the cloth). Fewer and
 *  shallower is a warning: a deep seat brings the thighs against a tee's front. */
export const CLIP_REFUSE_POINTS = 10;
export const CLIP_REFUSE_SHARE = 0.05;
export const CLIP_REFUSE_DEPTH_MM = 25;
/** How far a fit's skeleton may sit from its kit's at the trunk and legs. */
export const SKELETON_TOLERANCE = 0.01;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The declaration on the scene (a Blender scene's custom property) or on the file. */
function declaration(json: Record<string, unknown>): unknown {
  const scenes = Array.isArray(json['scenes']) ? (json['scenes'] as Array<Record<string, unknown>>) : [];
  const scene = scenes[typeof json['scene'] === 'number' ? json['scene'] : 0];
  const fromScene = (scene?.['extras'] as Record<string, unknown> | undefined)?.['flatchat_item'];
  const raw = fromScene ?? (json['extras'] as Record<string, unknown> | undefined)?.['flatchat_item'];
  // Blender writes a custom property that holds JSON as a string.
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  return raw;
}

/** The fit nodes, by body: a skinned mesh whose extras.flatchat_fit names a body. */
function fitNodes(doc: Document): { fits: Map<BodyKit, Node>; problems: string[] } {
  const fits = new Map<BodyKit, Node>();
  const problems: string[] = [];
  const bones = new Set(KIT_BONES);
  for (const node of doc.getRoot().listNodes()) {
    const body = (node.getExtras() as Record<string, unknown>)['flatchat_fit'];
    if (body === undefined) continue;
    if (typeof body !== 'string' || !(BODY_KITS as readonly string[]).includes(body)) {
      problems.push(`${node.getName() || 'a node'}: flatchat_fit ${JSON.stringify(body)} is not one of ${BODY_KITS.join(', ')}`);
      continue;
    }
    if (!node.getMesh() || !node.getSkin()) {
      problems.push(`the ${body} fit (${node.getName()}) is not a skinned mesh`);
      continue;
    }
    if (fits.has(body as BodyKit)) problems.push(`two fits for the ${body} body`);
    const foreign = node.getSkin()!.listJoints().map((j) => j.getName()).filter((n) => !bones.has(n));
    if (foreign.length) problems.push(`the ${body} fit is skinned to bones the kits do not have (${foreign.slice(0, 4).join(', ')}): make it on kits/bodies/${body}`);
    fits.set(body as BodyKit, node);
  }
  if (fits.size === 0 && problems.length === 0) problems.push('no fit: mark each fitted mesh with the custom property flatchat_fit (feminine, masculine or neutral)');
  return { fits, problems };
}

function countTriangles(node: Node): number {
  return node.getMesh()!.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3, 0);
}

export async function convertItem(bytes: Uint8Array, o: ItemOptions = {}): Promise<ItemResult> {
  const ktx2 = o.ktx2 ?? true;
  const warnings: string[] = [];
  const warn = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  if (bytes.length > ITEM_SOURCE_LIMIT) throw new ItemError([`the file is over ${ITEM_SOURCE_LIMIT / 1048576} MB`]);
  let json: Record<string, unknown>;
  try {
    json = readGltf(bytes, 'item.glb').json as unknown as Record<string, unknown>;
  } catch (err) {
    throw new ItemError([`not a GLB: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const { problems: invalid } = await validateGltf(bytes, false);
  if (invalid.length) throw new ItemError(invalid);
  const list = (k: string): Array<Record<string, unknown>> => (Array.isArray(json[k]) ? (json[k] as Array<Record<string, unknown>>) : []);
  if ([...list('buffers'), ...list('images')].some((x) => x['uri'] !== undefined)) throw new ItemError(['the file points at outside data: export a .glb with everything inside']);

  let declared: ItemDeclaration;
  try {
    declared = readItemDeclaration(declaration(json));
  } catch (err) {
    throw new ItemError(err instanceof ItemFormatError ? err.problems : [String(err)]);
  }
  const cap = SLOTS[declared.slot];

  const io = avatarIO();
  if (declared.slot === 'attachment') return convertProp(bytes, declared, warnings, warn, ktx2);
  const { fits, problems } = fitNodes(await io.readBinary(bytes));
  for (const [body, node] of fits) {
    const triangles = countTriangles(node);
    const slots = node.getMesh()!.listPrimitives().length;
    if (triangles > cap.triangles) problems.push(`the ${body} fit has ${triangles} triangles, more than a ${declared.slot} may (${cap.triangles})`);
    if (slots > cap.materials) problems.push(`the ${body} fit has ${slots} material slots, more than a ${declared.slot} may (${cap.materials})`);
  }
  if (problems.length) throw new ItemError(problems);

  const files = new Map<string, Uint8Array>();
  const out: Partial<Record<BodyKit, ItemFit>> = {};
  const clipping: Partial<Record<BodyKit, ItemClipping>> = {};
  for (const body of BODY_KITS) {
    if (!fits.has(body)) continue;
    // This fit alone: every other mesh, skin and node goes.
    const doc = await io.readBinary(bytes);
    const root = doc.getRoot();
    const { fits: here } = fitNodes(doc);
    const keep = here.get(body)!;
    for (const node of root.listNodes()) if (node !== keep && node.getMesh()) node.setMesh(null).setSkin(null);
    for (const a of root.listAnimations()) a.dispose();
    for (const node of root.listNodes()) node.setCamera(null);
    for (const c of root.listCameras()) c.dispose();
    for (const e of root.listExtensionsUsed()) {
      if (ITEM_EXTENSIONS.has(e.extensionName)) continue;
      warn(`the ${e.extensionName} extension is left out: the platform's items do not carry it`);
      e.dispose();
    }
    keep.setExtras({ flatchat_fit: body });
    for (const scene of root.listScenes()) scene.setExtras({});
    root.setExtras({});
    await doc.transform(prune({ keepLeaves: false, keepAttributes: true }));
    const textureBytes = await fitTextures([doc], { side: cap.textureSide, budget: 16 * 1024 * 1024 }, ktx2, warn);
    const file = await io.writeBinary(doc);
    try {
      checkItemFit(readGltf(file, `${body}.glb`).json as unknown as Record<string, unknown>);
    } catch (err) {
      throw new Error(`the converter made a ${body} fit the client refuses: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const hash = sha256(file);
    files.set(hash, file);
    out[body] = { file: hash, bytes: file.length, triangles: countTriangles(keep), materialSlots: keep.getMesh()!.listPrimitives().length, textureBytes, joints: keep.getSkin()!.listJoints().length };
    const kit = o.kits?.[body];
    if (kit) {
      const off = skeletonOffset(kit, keep);
      if (off > SKELETON_TOLERANCE) {
        problems.push(`the ${body} fit was not made on kits/bodies/${body}: its skeleton is ${Math.round(off * 1000)} mm off the body's`);
        continue;
      }
      const c = clippingOf(kit, keep, declared.hides);
      clipping[body] = c;
      const many = c.through > CLIP_REFUSE_POINTS && c.through / Math.max(1, c.checked) > CLIP_REFUSE_SHARE;
      if (many || c.worstMm > CLIP_REFUSE_DEPTH_MM) problems.push(`on the ${body} body, ${c.through} of ${c.checked} body points near it come out through it by more than ${CLIP_TOLERANCE * 1000} mm in the reference poses (up to ${c.worstMm} mm): loosen it, or hide the regions it covers`);
      else if (c.through > 0) warn(`on the ${body} body, ${c.through} body points come out through it in the reference poses (up to ${c.worstMm} mm)`);
    } else warn(`the ${body} fit was not checked for clipping (the kits were not at hand)`);
  }
  if (problems.length) throw new ItemError(problems);

  const manifest: ItemManifest = {
    format: ITEM_FORMAT,
    kind: 'item',
    converter: ITEM_CONVERTER_VERSION,
    source: { sha256: sha256(bytes), bytes: bytes.length },
    name: declared.name,
    authors: declared.authors,
    slot: declared.slot,
    hides: declared.hides,
    fits: out,
    clipping,
    warnings,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestBytes, id: sha256(manifestBytes), files };
}

/** An attachment (S5.04): its rigid meshes as one prop, its origin the point it is worn at. */
async function convertProp(bytes: Uint8Array, declared: ItemDeclaration, warnings: string[], warn: (w: string) => void, ktx2: boolean): Promise<ItemResult> {
  const cap = SLOTS.attachment;
  const io = avatarIO();
  const doc = await io.readBinary(bytes);
  const root = doc.getRoot();
  const problems: string[] = [];
  if (root.listSkins().length > 0) problems.push('an attachment is carried whole at its point: rigid meshes, no skin');
  const meshes = root.listNodes().filter((n) => n.getMesh());
  if (meshes.length === 0) problems.push('an attachment needs a mesh');
  const triangles = meshes.reduce((n, node) => n + countTriangles(node), 0);
  const slots = meshes.reduce((n, node) => n + node.getMesh()!.listPrimitives().length, 0);
  if (triangles > cap.triangles) problems.push(`the prop has ${triangles} triangles, more than an attachment may (${cap.triangles})`);
  if (slots > cap.materials) problems.push(`the prop has ${slots} material slots, more than an attachment may (${cap.materials})`);
  if (problems.length) throw new ItemError(problems);
  for (const a of root.listAnimations()) a.dispose();
  for (const node of root.listNodes()) node.setCamera(null);
  for (const c of root.listCameras()) c.dispose();
  for (const e of root.listExtensionsUsed()) {
    if (ITEM_EXTENSIONS.has(e.extensionName)) continue;
    warn(`the ${e.extensionName} extension is left out: the platform's items do not carry it`);
    e.dispose();
  }
  for (const scene of root.listScenes()) scene.setExtras({});
  root.setExtras({});
  await doc.transform(prune({ keepLeaves: false, keepAttributes: true }));
  const textureBytes = await fitTextures([doc], { side: cap.textureSide, budget: 4 * 1024 * 1024 }, ktx2, warn);
  const file = await io.writeBinary(doc);
  try {
    checkItemProp(readGltf(file, 'prop.glb').json as unknown as Record<string, unknown>);
  } catch (err) {
    throw new Error(`the converter made a prop the client refuses: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const hash = sha256(file);
  const manifest: ItemManifest = {
    format: ITEM_FORMAT,
    kind: 'item',
    converter: ITEM_CONVERTER_VERSION,
    source: { sha256: sha256(bytes), bytes: bytes.length },
    name: declared.name,
    authors: declared.authors,
    slot: 'attachment',
    hides: [],
    fits: {},
    clipping: {},
    attach: declared.attach!,
    prop: { file: hash, bytes: file.length, triangles, materialSlots: slots, textureBytes, joints: 0 },
    warnings,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestBytes, id: sha256(manifestBytes), files: new Map([[hash, file]]) };
}
