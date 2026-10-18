// SPDX-License-Identifier: MPL-2.0
// The test garment fitted on all three bodies (S5.01's verify, S5.02's checks): the test tee, made
// by src/item/samples.ts's makeGarment (each kit's own chest, belly and upper arms, 8 mm out along
// the body's normals, skinned with the body's own weights), declaring itself as creators' items do.
//
//   node tools/converter/scripts/make-test-item.ts [OUT]    (default kits/items/test-tee/test-tee.glb)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGarment, TEST_TEE } from '../src/item/samples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = process.argv[2] ?? join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, await makeGarment(TEST_TEE));
process.stdout.write(`${JSON.stringify({ event: 'test-item', out: OUT })}\n`);
