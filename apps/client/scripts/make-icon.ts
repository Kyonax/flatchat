// SPDX-License-Identifier: MPL-2.0
// Writes out/icon.png (512 px) for the window and the Linux package (electron-builder.yml); `npm run
// build` runs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconPng } from './icon.ts';

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'out');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.png'), iconPng(512));
