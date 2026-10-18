# Credits

Third-party code, models, textures, sounds, fonts and data in this repository, and the people who made them.

Rules for every entry:

- Name the creator: the person or group who made the work, not the platform where it was found.
- Give the source link, the licence (an SPDX identifier where one exists), the date it was retrieved and what was changed.
- Assets must be CC0 or CC BY; a CC BY asset also carries the credit line its licence asks for. Code keeps its own licence.
- Material without an entry here does not ship.
- Every asset, the project's own included, also has a provenance record in [kits/provenance/](kits/provenance/) (Track P's P.07). `npm run harness` (its `assets` check, `tools/harness/src/asset-check.ts`) refuses an asset without a record, a licence other than CC0, CC BY or the owner's own, another's work without a saved copy of its licence page, and a CC BY asset whose credit line is missing here.

| Item | Path | Creator | Source | Licence | Retrieved | Changes |
|---|---|---|---|---|---|---|
| The libopus 1.6.1 licence text | `apps/client/third_party/opus/COPYING` | Xiph.Org Foundation and the Opus contributors | [xiph/opus, v1.6.1](https://github.com/xiph/opus/blob/v1.6.1/COPYING) | BSD-3-Clause | 2026-10-17 | None |
| The Recast & Detour licence text | `apps/client/third_party/recast/License.txt` | Mikko Mononen | [recastnavigation/recastnavigation](https://github.com/recastnavigation/recastnavigation/blob/main/License.txt) | Zlib | 2026-10-17 | None |

## Packages that ship

npm packages are not stored here; `package-lock.json` pins them. These are the ones that ship inside a built program. The packaged client carries their licences in `THIRD_PARTY_NOTICES.txt` beside the executable (written by `apps/client/scripts/notices.mjs`); Electron's and Chromium's come with Electron.

| Package | Ships in | Creator | Source | Licence | Version |
|---|---|---|---|---|---|
| Electron | the client | the Electron contributors (OpenJS Foundation) | [electron/electron](https://github.com/electron/electron) | MIT | 44.8.0 |
| three.js | the client | Ricardo Cabello (mrdoob) and the three.js authors | [mrdoob/three.js](https://github.com/mrdoob/three.js) | MIT | 0.186.1 |
| Vue, with its `@vue/*` runtime | the client | Evan You and the Vue contributors | [vuejs/core](https://github.com/vuejs/core) | MIT | 3.5.44 |
| libopus-wasm | the client | openclaw | [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm) | MIT | 0.4.1 |
| libopus, compiled to WebAssembly inside libopus-wasm | the client | Xiph.Org Foundation and the Opus contributors | [xiph/opus](https://github.com/xiph/opus) | BSD-3-Clause | 1.6.1 |
| three-vrm, with its `@pixiv/three-vrm-*` packages | the client | pixiv Inc. and the three-vrm contributors | [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | 3.5.5 |
| meshoptimizer | the client | Arseny Kapoulkine | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | MIT | 1.3.0 |
| vue-i18n, with its `@intlify/*` packages | the client | kazuya kawaguchi and the intlify contributors | [intlify/vue-i18n](https://github.com/intlify/vue-i18n) | MIT | 11.4.14 |
| Rapier (`@dimforge/rapier3d-compat`) | the client | Sébastien Crozet and Dimforge | [dimforge/rapier.js](https://github.com/dimforge/rapier.js) | Apache-2.0 | 0.21.0 |
| Basis Universal's transcoder, shipped with three.js | the client | Binomial LLC | [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | Apache-2.0 | three.js r186's copy |
| node-datachannel | the world server, the host tool | Murat Doğan and Paul-Louis Ageneau | [murat-dogan/node-datachannel](https://github.com/murat-dogan/node-datachannel) | MPL-2.0 | 0.33.4 |
| libdatachannel, inside node-datachannel | the world server, the host tool | Paul-Louis Ageneau | [paullouisageneau/libdatachannel](https://github.com/paullouisageneau/libdatachannel) | MPL-2.0 | 0.24.5 |
| Fastify, with the packages it loads (find-my-way, pino, avvio and others) | the core | Matteo Collina, Tomas Della Vedova and the Fastify contributors | [fastify/fastify](https://github.com/fastify/fastify) | MIT | 5.12.7 |
| node-postgres (`pg`, with `pg-pool` and `pg-protocol`) | the core | Brian Carlson and the node-postgres contributors | [brianc/node-postgres](https://github.com/brianc/node-postgres) | MIT | 8.23.1 |
| @fastify/websocket, with ws | the core | the Fastify contributors; Einar Otto Stangvik and the ws contributors | [fastify/fastify-websocket](https://github.com/fastify/fastify-websocket), [websockets/ws](https://github.com/websockets/ws) | MIT | 11.3.4, 8.22.0 |
| glTF Transform (`@gltf-transform/*`), with property-graph | the host tool (the converter), the client (offline mode) | Don McCurdy and the glTF Transform contributors | [donmccurdy/glTF-Transform](https://github.com/donmccurdy/glTF-Transform) | MIT | 4.5.1 |
| meshoptimizer | the host tool (the converter) | Arseny Kapoulkine | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | MIT | 1.3.0 |
| recast-navigation-js, with Recast and Detour inside | the client (click to move), the world server (where teleports land), the host tool (the converter) | Isaac Mason; Recast and Detour by Mikko Mononen | [isaac-mason/recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js), [recastnavigation/recastnavigation](https://github.com/recastnavigation/recastnavigation) | MIT; Recast and Detour zlib | 0.43.1 |
| ktx2-encoder, with ktx-parse and Basis Universal inside | the host tool (the converter), the client (offline mode) | gz65555; Basis Universal by Binomial LLC | [gz65555/ktx2-encoder](https://github.com/gz65555/ktx2-encoder), [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) | MIT; Basis Universal Apache-2.0 | 0.6.0 |
| pngjs | the host tool (the converter), the client (offline mode) | Luke Page and the pngjs contributors | [pngjs/pngjs](https://github.com/pngjs/pngjs) | MIT | 7.0.0 |
| jpeg-js | the host tool (the converter), the client (offline mode) | Eugene Ware and the jpeg-js contributors | [jpeg-js/jpeg-js](https://github.com/jpeg-js/jpeg-js) | BSD-3-Clause | 0.4.4 |
| ndarray-pixels and ndarray-lanczos, inside glTF Transform's functions; ndarray, ndarray-ops, cwise-compiler, iota-array and uniq inside them; is-buffer inside ndarray | the host tool (the converter), the client (offline mode) | Don McCurdy (ndarray-pixels, ndarray-lanczos); Mikola Lysenko (ndarray and its helpers); Feross Aboukhadijeh (is-buffer) | [donmccurdy/ndarray-pixels](https://github.com/donmccurdy/ndarray-pixels), [scijs/ndarray](https://github.com/scijs/ndarray) | MIT | 5.2.0, 0.3.0, 1.1.1, 1.2.2, 1.1.3, 1.0.0, 1.0.1, 1.1.6 |
| smol-toml | the world server, the host tool | squirrelchat | [squirrelchat/smol-toml](https://github.com/squirrelchat/smol-toml) | BSD-3-Clause | 1.9.1 |
| Node.js | the host tool's download (its `node/` folder) | the Node.js contributors (OpenJS Foundation) | [nodejs/node](https://github.com/nodejs/node) | MIT; the libraries it bundles keep their own licences, listed in its `node/LICENSE` | 24.22.0 |
| The `node:24.22.0-bookworm-slim` image: Debian 12 with Node.js | the host tool's container image | the Node.js Docker team; the Debian project | [nodejs/docker-node](https://github.com/nodejs/docker-node), [debian.org](https://www.debian.org/) | MIT for the image's build files; each Debian package keeps its own licence (`/usr/share/doc/*/copyright` in the image) | 24.22.0-bookworm-slim |
