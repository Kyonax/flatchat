// SPDX-License-Identifier: MPL-2.0
// Writes out/THIRD_PARTY_NOTICES.txt: the licence of each third-party package bundled into the
// client, which their licences (MIT, BSD) ask to travel with every copy. `npm run build` runs it
// and electron-builder.yml puts the file next to the executable. Electron's and Chromium's own
// notices come from electron-builder (LICENSE.electron.txt, LICENSES.chromium.html). A package
// added to the bundle needs a row here and in CREDITS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = dirname(dirname(fileURLToPath(import.meta.url)));

/** Packages bundled into out/: their own LICENSE, or a licence text kept in third_party/. */
const BUNDLED = [
  { package: 'three', note: 'the 3D renderer' },
  { package: 'vue', note: 'the interface, with its @vue/* runtime packages under the same licence' },
  { package: 'libopus-wasm', note: 'the voice codec wrapper' },
  { package: '@pixiv/three-vrm', note: 'VRM avatars, with its @pixiv/three-vrm-* packages under the same licence (spike S0.09)' },
  { package: 'meshoptimizer', note: 'mesh simplification for levels of detail (spike S0.09)' },
  { package: 'vue-i18n', note: 'the English and Spanish interface' },
  { package: '@intlify/core-base', note: 'inside vue-i18n' },
  { package: '@intlify/message-compiler', note: 'inside vue-i18n: compiles messages without eval' },
  { package: '@intlify/shared', note: 'inside vue-i18n' },
  { name: 'libopus', version: '1.6.1', licence: 'BSD-3-Clause', text: 'third_party/opus/COPYING', note: 'compiled to WebAssembly inside libopus-wasm' },
  { package: '@dimforge/rapier3d-compat', note: 'the physics the player moves with (S2.06)' },
  { package: 'recast-navigation', note: 'paths for click to move (S2.06), with @recast-navigation/core and @recast-navigation/wasm under the same licence' },
  { name: 'Recast & Detour', version: 'inside @recast-navigation/wasm 0.43.1', licence: 'Zlib', text: 'third_party/recast/License.txt', note: 'compiled to WebAssembly inside recast-navigation, by Mikko Mononen' },
  { package: '@flatchat/content', note: 'FlatChat’s own content formats, Apache-2.0' },
  { package: 'smol-toml', note: 'world.toml, inside @flatchat/content' },
  { name: 'Basis Universal transcoder', version: 'three.js r186', licence: 'Apache-2.0', text: 'third_party/basis/LICENSE', note: 'KTX2 textures of downloaded worlds (shipped with three.js, by Binomial LLC)' },
  // Offline mode (S2.13): the world server and the host tool's converter run in the main process.
  { package: '@flatchat/world-server', note: 'FlatChat’s world server, MPL-2.0: offline worlds run in the client (S2.13)' },
  { package: '@flatchat/converter', note: 'FlatChat’s converter, MPL-2.0: world folders opened offline' },
  { package: '@gltf-transform/core', note: 'inside the converter, with @gltf-transform/extensions and @gltf-transform/functions under the same licence' },
  { package: 'property-graph', note: 'inside glTF Transform' },
  { package: 'ndarray-pixels', note: 'inside glTF Transform’s functions (never asked to resize here)' },
  { package: 'ndarray-lanczos', note: 'inside glTF Transform’s functions' },
  { package: 'ndarray', note: 'inside ndarray-pixels' },
  { package: 'ndarray-ops', note: 'inside ndarray-pixels' },
  { package: 'cwise-compiler', note: 'inside ndarray-ops' },
  { package: 'iota-array', note: 'inside ndarray' },
  { package: 'is-buffer', note: 'inside ndarray' },
  { package: 'uniq', note: 'inside cwise-compiler' },
  { package: 'ktx2-encoder', note: 'inside the converter (offline worlds skip KTX2)' },
  { package: 'ktx-parse', note: 'inside ktx2-encoder' },
  { name: 'Basis Universal encoder', version: 'inside ktx2-encoder 0.6.0', licence: 'Apache-2.0', text: 'third_party/basis/LICENSE', note: 'compiled to WebAssembly inside ktx2-encoder, by Binomial LLC' },
  { package: 'pngjs', note: 'PNG textures of world folders opened offline' },
  { package: 'jpeg-js', note: 'JPEG textures of world folders opened offline' },
];

function packageDir(name) {
  for (let dir = client; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`notices: ${name} is not installed`);
  }
}

const own = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8'));
const parts = [`Third-party notices for FlatChat ${own.version}\n\nThe FlatChat client bundles the following third-party code. Each keeps its own licence, given in full below.`];
for (const item of BUNDLED) {
  let heading;
  let text;
  if (item.package) {
    const dir = packageDir(item.package);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) throw new Error(`notices: ${item.package} has no LICENSE file`);
    heading = `${item.package} ${meta.version} (${meta.license}): ${item.note}`;
    text = readFileSync(file, 'utf8');
  } else {
    heading = `${item.name} ${item.version} (${item.licence}): ${item.note}`;
    text = readFileSync(join(client, item.text), 'utf8');
  }
  parts.push(`${'='.repeat(72)}\n${heading}\n${'='.repeat(72)}\n\n${text.trim()}`);
}
mkdirSync(join(client, 'out'), { recursive: true });
writeFileSync(join(client, 'out', 'THIRD_PARTY_NOTICES.txt'), `${parts.join('\n\n')}\n`);
process.stdout.write(`notices: ${BUNDLED.length} entries → out/THIRD_PARTY_NOTICES.txt\n`);
