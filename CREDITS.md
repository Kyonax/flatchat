# Credits

Third-party code, models, textures, sounds, fonts and data in this repository, and the people who made them.

Rules for every entry:

- Name the creator: the person or group who made the work, not the platform where it was found.
- Give the source link, the licence (an SPDX identifier where one exists), the date it was retrieved and what was changed.
- Assets must be CC0 or CC BY; a CC BY asset also carries the credit line its licence asks for. Code keeps its own licence.
- Material without an entry here does not ship.

| Item | Path | Creator | Source | Licence | Retrieved | Changes |
|---|---|---|---|---|---|---|
| The libopus 1.6.1 licence text | `apps/client/third_party/opus/COPYING` | Xiph.Org Foundation and the Opus contributors | [xiph/opus, v1.6.1](https://github.com/xiph/opus/blob/v1.6.1/COPYING) | BSD-3-Clause | 2026-10-17 | None |

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
| node-datachannel | the world server | Murat Doğan and Paul-Louis Ageneau | [murat-dogan/node-datachannel](https://github.com/murat-dogan/node-datachannel) | MPL-2.0 | 0.33.4 |
| libdatachannel, inside node-datachannel | the world server | Paul-Louis Ageneau | [paullouisageneau/libdatachannel](https://github.com/paullouisageneau/libdatachannel) | MPL-2.0 | 0.24.5 |
| Fastify, with the packages it loads (find-my-way, pino, avvio and others) | the core | Matteo Collina, Tomas Della Vedova and the Fastify contributors | [fastify/fastify](https://github.com/fastify/fastify) | MIT | 5.12.7 |
| node-postgres (`pg`, with `pg-pool` and `pg-protocol`) | the core | Brian Carlson and the node-postgres contributors | [brianc/node-postgres](https://github.com/brianc/node-postgres) | MIT | 8.23.1 |
