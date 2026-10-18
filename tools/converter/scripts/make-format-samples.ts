// SPDX-License-Identifier: MPL-2.0
// The upload-format fixtures (S5.08): the converter's sample humanoid, the test tee's feminine fit
// and the sample cube, written by Blender as FBX, OBJ and .blend and read back by
// tools/blender/convert/to-glb.py as the core reads an upload (src/source/samples.ts). The GLBs
// Blender gives back go in test/fixtures/formats/, where CI converts them; where Blender is,
// test/formats.test.ts takes the whole road again and compares.
//
//   node tools/converter/scripts/make-format-samples.ts [BLENDER]
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderSamples } from '../src/source/samples.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'formats');
const blender = process.argv[2] ?? process.env['FLATCHAT_BLENDER'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender', 'blender-5.2.2-linux-x64', 'blender');
const dir = mkdtempSync(join(tmpdir(), 'fcformats-'));
try {
  mkdirSync(OUT, { recursive: true });
  for (const [name, { glb }] of Object.entries(await blenderSamples(blender, dir))) {
    const to = join(OUT, `${name.replace('.', '-')}.glb`);
    copyFileSync(glb, to);
    process.stdout.write(`${to}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
