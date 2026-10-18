// SPDX-License-Identifier: MPL-2.0
// The standard bodies' fingerprints (S5.09): what each kit's VRM measures as an upload, written to
// kits/bodies/fingerprints.json for the core, which sets aside whatever a kit explains before it
// compares an upload with what was taken down (anyone may make an avatar of a kit). The converter's
// tests check the file against the kits as they are.
//
//   node tools/converter/scripts/kit-fingerprints.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS } from '@flatchat/content';
import { convertAvatar } from '../src/avatar/convert.ts';

const KITS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'bodies');

/** Each body's fingerprint, by name, as the file holds them. */
export async function kitFingerprints(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const body of BODY_KITS) out[body] = (await convertAvatar(new Uint8Array(readFileSync(join(KITS, body, `${body}.vrm`))), { ktx2: false })).fingerprint;
  return `${JSON.stringify(out, null, 1)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(KITS, 'fingerprints.json'), await kitFingerprints());
  process.stdout.write(`${join(KITS, 'fingerprints.json')}\n`);
}
