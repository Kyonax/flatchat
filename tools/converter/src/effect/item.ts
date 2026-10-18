// SPDX-License-Identifier: MPL-2.0
// An effect upload made into an item (S6.01): worn at an attachment point like a prop, its one file
// the effect's bundle, its manifest carrying what the dry run measured. The declaration comes with
// the upload (an Effekseer file keeps none), or from the bundle itself (the starter effects).
import { createHash } from 'node:crypto';
import { ITEM_FORMAT, type ItemDeclaration, ItemFormatError, type ItemManifest, readItemDeclaration } from '@flatchat/content';
import { ITEM_CONVERTER_VERSION, ItemError, type ItemResult } from '../item/convert.ts';
import { convertEffect, EffectError, effectUpload } from './convert.ts';
import type { DryRunner } from './dry-run.ts';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export async function convertEffectItem(upload: Uint8Array, o: { declaration?: unknown; runner?: DryRunner } = {}): Promise<ItemResult> {
  let given;
  try {
    given = effectUpload(upload);
  } catch (err) {
    throw new ItemError(err instanceof EffectError ? err.problems : [String(err)]);
  }
  const raw = given.declaration ?? o.declaration;
  if (raw === undefined) throw new ItemError(["an effect keeps no declaration of its own: give its name and the point it is worn at when uploading it"]);
  let declared: ItemDeclaration;
  try {
    declared = readItemDeclaration(raw);
  } catch (err) {
    throw new ItemError(err instanceof ItemFormatError ? err.problems : [String(err)]);
  }
  if (declared.slot !== 'effect') throw new ItemError([`the upload is an effect, so its slot is "effect", not "${declared.slot}"`]);
  let r;
  try {
    r = await convertEffect(given, { where: 'avatar', scale: declared.scale ?? 1, ...(o.runner ? { runner: o.runner } : {}) });
  } catch (err) {
    throw new ItemError(err instanceof EffectError ? err.problems : [String(err)]);
  }
  const manifest: ItemManifest = {
    format: ITEM_FORMAT,
    kind: 'item',
    converter: ITEM_CONVERTER_VERSION,
    source: { sha256: sha256(upload), bytes: upload.length },
    name: declared.name,
    authors: declared.authors,
    slot: 'effect',
    hides: [],
    fits: {},
    clipping: {},
    attach: declared.attach!,
    effect: r.fit,
    warnings: r.warnings,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  // No fingerprint: an effect's textures are soft dots and streaks shared by many, so a match on
  // them is no evidence of a copy (S5.09's check would strike the innocent).
  return { manifest, manifestBytes, id: sha256(manifestBytes), files: new Map([[r.fit.file, r.bundle]]), fingerprint: { shapes: [], textures: [] } };
}
