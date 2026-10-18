// SPDX-License-Identifier: MPL-2.0
// Effekseer's sample effects (kits/effects/samples, CC0), each bundled with the files it names, as
// an upload's effect is: for the converter's tests and the fuzzed corpus.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EffectBundle, effectFiles, readEffectFile } from '@flatchat/content';

export const EFFECT_SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'kits', 'effects', 'samples');

/** A sample by its path under kits/effects/samples, e.g. "00_Basic/Laser01.efkefc". */
export function sampleBundle(rel: string): EffectBundle {
  const main = new Uint8Array(readFileSync(join(EFFECT_SAMPLES, rel)));
  const dir = dirname(join(EFFECT_SAMPLES, rel));
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const files = new Map<string, Uint8Array>([[name, main]]);
  for (const f of effectFiles(readEffectFile(main))) files.set(f.path, new Uint8Array(readFileSync(join(dir, f.path))));
  return { main: name, files };
}
