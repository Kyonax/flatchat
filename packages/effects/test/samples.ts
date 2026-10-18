// SPDX-License-Identifier: Apache-2.0
// Effekseer's sample effects (kits/effects/samples, CC0) bundled as the converter would, for the
// tests.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EffectBundle, effectFiles, readEffectFile } from '@flatchat/content';

export const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'effects', 'samples');

/** A sample effect and the files it names, as the converter would bundle them. */
export function sampleBundle(rel: string): EffectBundle {
  const main = new Uint8Array(readFileSync(join(SAMPLES, rel)));
  const dir = dirname(join(SAMPLES, rel));
  const files = new Map<string, Uint8Array>([[rel.slice(rel.lastIndexOf('/') + 1), main]]);
  for (const f of effectFiles(readEffectFile(main))) files.set(f.path, new Uint8Array(readFileSync(join(dir, f.path))));
  return { main: rel.slice(rel.lastIndexOf('/') + 1), files };
}

