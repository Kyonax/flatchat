// SPDX-License-Identifier: MPL-2.0
// Builds the worlds offline mode carries (S2.13): every kit in kits/worlds, converted with the host
// tool's converter into out/offline/<kit>, which the package puts beside the app (extraResources)
// so the world server in the main process reads them as ordinary files.
//
//   node scripts/offline-worlds.ts   (npm run build runs it)
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertWorld, readFolder, writeBuilt } from '@flatchat/converter';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KITS = join(CLIENT, '..', '..', 'kits', 'worlds');
const OUT = join(CLIENT, 'out', 'offline');

rmSync(OUT, { recursive: true, force: true });
for (const kit of readdirSync(KITS).sort()) {
  const r = await convertWorld(readFolder(join(KITS, kit)));
  writeBuilt(join(OUT, kit), r.out);
  process.stdout.write(`offline: ${kit}: ${r.world.files.length} files, ${r.world.files.reduce((n, f) => n + f.size, 0)} bytes\n`);
}
