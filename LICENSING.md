# Licensing

FlatChat is open source. Each folder has its own licence, chosen for its role. Each listed folder holds the full text in its own `LICENSE` file; the root [LICENSE](LICENSE) (MPL-2.0) covers everything not listed.

| Folder | Licence | SPDX identifier |
|---|---|---|
| `apps/core` | GNU Affero General Public License v3.0 or later | `AGPL-3.0-or-later` |
| `apps/client` | Mozilla Public License 2.0 | `MPL-2.0` |
| `apps/world-server` | Mozilla Public License 2.0 | `MPL-2.0` |
| `tools/converter` | Mozilla Public License 2.0 | `MPL-2.0` |
| `tools/host-tool` | Mozilla Public License 2.0 | `MPL-2.0` |
| `tools/bots` | Mozilla Public License 2.0 | `MPL-2.0` |
| `packages/protocol` | Apache License 2.0 | `Apache-2.0` |
| `packages/sim` | Apache License 2.0 | `Apache-2.0` |
| `packages/content` | Apache License 2.0 | `Apache-2.0` |
| `packages/plugin-sdk` | Apache License 2.0 | `Apache-2.0` |
| `tools/blender` | GNU General Public License v3.0 or later | `GPL-3.0-or-later` |
| `kits` | Creative Commons Attribution 4.0 International | `CC-BY-4.0` |
| `docs` | Creative Commons Attribution 4.0 International | `CC-BY-4.0` |
| Anything else | Mozilla Public License 2.0 | `MPL-2.0` |

## Why these

- **The central service** (`apps/core`) is AGPL: whoever runs a changed copy as a service for others shares the changes.
- **The programs players and hosts run** (the client, the world server and the host tools) are MPL-2.0: changed files stay open, and they can still be combined with other code.
- **The shared libraries** (`packages/`) are Apache-2.0, so anyone can build compatible clients, tools, bots and plugins on them.
- **The Blender bridge** is GPL-3.0-or-later, matching Blender's own licence, as the Blender Foundation asks of scripts that use its API.
- **The body kits, the base library and the docs** are CC BY 4.0: use them anywhere, with credit.

## SPDX headers

Every source file starts with the SPDX identifier of its folder's licence, within its first five lines (after a shebang, if any):

```ts
// SPDX-License-Identifier: MPL-2.0
```

```py
# SPDX-License-Identifier: GPL-3.0-or-later
```

```css
/* SPDX-License-Identifier: Apache-2.0 */
```

```html
<!-- SPDX-License-Identifier: MPL-2.0 -->
```

`npm run check:layout` checks every header and every `LICENSE` file against [tools/repo/layout.json](tools/repo/layout.json), which holds the same table as this file.

## Third-party material

Third-party code, models, textures, sounds and fonts keep their own licences. Each is listed in [CREDITS.md](CREDITS.md) with its creator, source and licence, and lives in a `third_party/` folder or keeps its own header.

## The name

FlatChat is a working name. These licences cover the code and content, not the platform's future name or logo.
