---
title: Repository Layout, npm Workspaces, Licences by Folder and SPDX Headers
impact: CRITICAL
impactDescription: A source file without its folder's SPDX header, a new licensed folder missing from layout.json or a top-level folder outside the allowed five fails the layout check and CI, and code merged under the wrong licence cannot be relicensed afterwards.
tags: repository, layout, shipwright, secret scanner, high-entropy-assignment, publishing, THIRD_PARTY_NOTICES, notices.mjs, packages that ship, monorepo, workspaces, npm workspaces, apps, packages, tools, kits, docs, licence, license, licensing, spdx, spdx header, MPL-2.0, AGPL-3.0-or-later, Apache-2.0, GPL-3.0-or-later, CC-BY-4.0, check-layout, layout.json, LICENSING.md, CREDITS.md, third party, third_party, new folder, new package, new workspace, inbound outbound, README, provenance, kits/provenance, asset-check, assets check, licence gate, P.07, archived licence page, credit line, depicts
---

This rule governs where code lives in the repository and which licence covers it. Each folder carries a licence chosen for its role, and the choice is recorded in three places that must agree: the folder's own `LICENSE` file, the table in `LICENSING.md`, and `tools/repo/layout.json`. `npm run check:layout` reads `layout.json` and checks all three, plus an SPDX header in every source file; the harness and CI run it on every change. A contribution takes the licence of the folder it lands in (inbound = outbound); there is no contributor licence agreement.

## The Folders

| Folder | What it holds | Licence (SPDX) | Workspace |
|---|---|---|---|
| `apps/client` | The Electron desktop client: main process, preload, renderer | `MPL-2.0` | `@flatchat/client` |
| `apps/world-server` | The world server, run headless by its host | `MPL-2.0` | `@flatchat/world-server` |
| `apps/core` | The central service: accounts, registry, uploads, gallery, moderation | `AGPL-3.0-or-later` | not yet |
| `packages/protocol` | Network messages, codecs, connect tokens, version handshake | `Apache-2.0` | `@flatchat/protocol` |
| `packages/sim` | Movement rules shared by client prediction and server checks | `Apache-2.0` | not yet |
| `packages/content` | World and avatar manifests, ranks and budgets, the world validator | `Apache-2.0` | not yet |
| `packages/plugin-sdk` | The world-plugin host interface | `Apache-2.0` | not yet |
| `packages/effects` | The pinned Effekseer runtime (in its `third_party/`, MIT), its bindings, the guard layer and the dry run | `Apache-2.0` | `@flatchat/effects` |
| `tools/converter` | Turns uploaded models into the platform's format | `MPL-2.0` | not yet |
| `tools/host-tool` | The host download: world server, converter, capacity advisor | `MPL-2.0` | not yet |
| `tools/bots` | Headless protocol clients for load tests | `MPL-2.0` | not yet |
| `tools/harness` | The harness, trap linter, skill check, weak-laptop stand-in | `MPL-2.0` | `@flatchat/harness` |
| `tools/blender` | The Blender bridge script | `GPL-3.0-or-later` | — |
| `tools/repo` | The layout check (`check-layout.mjs`) and `layout.json` | `MPL-2.0` (unlisted, so the default) | — |
| `kits` | The body kits and the base library's sources | `CC-BY-4.0` | — |
| `docs` | Specs, spike reports (`docs/spikes`), help pages | `CC-BY-4.0` | — |
| Everything else: root files, `.github/`, `.claude/`, `.shipwright/` | | `MPL-2.0`, the root `LICENSE` | — |

A file's licence is that of the **longest listed folder** that contains it; a file in no listed folder gets `MPL-2.0`.

## What the Layout Check Enforces

| Check | Failure message starts with |
|---|---|
| Required files at the root: `README.md`, `README.es.md`, `LICENSE`, `LICENSING.md`, `CONTRIBUTING.md`, `CREDITS.md`, `package.json` | `missing file` |
| The five top-level folders `apps`, `packages`, `tools`, `kits`, `docs` exist; `tools/repo` and `docs/spikes` exist | `missing folder` |
| No other top-level folder (dot-folders and the git-ignored outputs in `skipFolders`, such as `node_modules`, `out`, `dist`, are ignored) | `unexpected top-level folder` |
| The root `LICENSE` is the MPL-2.0 text | `LICENSE is not the MPL-2.0 text` |
| Every listed folder has a `LICENSE` with its licence's opening lines, and a `README.md` | `missing …/LICENSE`, `… is not the … text`, `missing …/README.md` |
| `LICENSING.md` has a row naming the folder and its SPDX id, both in backticks | `LICENSING.md has no row for …` |
| Every source file has `SPDX-License-Identifier: <ID>` in its first 5 lines (6 after a `#!` line), with its folder's ID | `no SPDX header`, `wrong SPDX header` |

Source extensions checked: `.ts .tsx .mts .cts .js .jsx .mjs .cjs .vue .py .sh .css .scss .html .glsl .wgsl .cs .gd`. Folders skipped: `.git node_modules dist build out release coverage .cache third_party .godot bin obj`. Markdown, JSON and YAML need no header.

## The Header for Each File Type

The check only looks for the text `SPDX-License-Identifier: <ID>`; write it in the file's own comment syntax, as the first line (after a shebang or `<!doctype html>`, if any).

| Files | Header line |
|---|---|
| `.ts .tsx .mts .cts .js .jsx .mjs .cjs .cs .glsl .wgsl` | `// SPDX-License-Identifier: MPL-2.0` |
| `.vue`, `.html` | `<!-- SPDX-License-Identifier: MPL-2.0 -->` (in `.html`, on line 2 after `<!doctype html>`) |
| `.css`, `.scss` | `/* SPDX-License-Identifier: MPL-2.0 */` |
| `.py`, `.sh`, `.gd` | `# SPDX-License-Identifier: GPL-3.0-or-later` (line 2 after the `#!` line) |

Each licence text is recognised by its opening lines:

| SPDX id | Opening lines the check looks for |
|---|---|
| `MPL-2.0` | `Mozilla Public License Version 2.0` |
| `AGPL-3.0-or-later` | `GNU AFFERO GENERAL PUBLIC LICENSE` and `Version 3, 19 November 2007` |
| `GPL-3.0-or-later` | `GNU GENERAL PUBLIC LICENSE` and `Version 3, 29 June 2007` |
| `Apache-2.0` | `Apache License` and `Version 2.0, January 2004` |
| `CC-BY-4.0` | `Attribution 4.0 International` |

Copy a `LICENSE` from a folder with the same licence (for example `tools/bots/LICENSE` for MPL-2.0); never retype or shorten one.

## Adding a Folder or a Workspace

1. Put it under one of the five top-level folders (a new top-level folder fails the check).
2. If its licence differs from MPL-2.0, or it should be listed anyway: add a `LICENSE` (the full text) and a `README.md`, a `"folder": "ID"` entry in `tools/repo/layout.json`'s `folders`, and a `LICENSING.md` row like ``| `tools/x` | Mozilla Public License 2.0 | `MPL-2.0` |``.
3. Add it to the parts table in both `README.md` and `README.es.md` (and the licence table when it is listed).
4. For a workspace: a `package.json` with `"name": "@flatchat/<name>"`, `"private": true`, `"license": "<ID>"`, `"type": "module"`, `"engines": { "node": ">=24" }`, and `test` and `typecheck` scripts when it has tests and TypeScript; the root `workspaces` globs (`apps/*`, `packages/*`, `tools/*`) pick it up, and the root `npm test` and `npm run typecheck` run it through `--workspaces --if-present`.
5. Run `npm install` once so `package-lock.json` records it, then `npm run harness`.

## Third-Party Material

Every asset, the project's own included, has a provenance record in `kits/provenance/` (one JSON per asset or per set made together; the fields are listed at the top of `tools/harness/src/asset-check.ts`): `files` (patterns with `*` and `**`), `title`, `creator`, `licence` (`CC0-1.0`, `CC-BY-4.0`, `CC-BY-3.0`, `LicenseRef-Owner`; `OFL-1.1` for fonts only, S6.07's Space Mono), then `made` for our own work or `source` (an https URL) with `retrieved`, `changes`, `licencePage.{url,archived}` (a saved copy of the licence page under `kits/provenance/archive/`) and, for CC BY, `credit` (word for word in `CREDITS.md`); `ai` names an AI tool and its terms on that date, `depicts` the others' works an image shows. The harness's `assets` check enforces it (P.07, rr-014: Quaternius' licence changed under its CC0 labels in 2026, so the page as it was is kept).

Third-party code, models, textures, sounds and fonts keep their own licences. Each gets a row in `CREDITS.md` (who made it, where it came from, its licence, what was changed) and lives in a `third_party/` folder (skipped by the header check) or keeps its own header. Assets must be CC0 or CC BY (a font may be OFL-1.1, its text archived beside its record); credit the person who made a work, not the site it was found on. Nothing from other games: no models, textures, sounds, names or logos.

npm packages that ship inside a built program (bundled into the client, or loaded by the world server) get a row in `CREDITS.md`'s "Packages that ship" table. A package bundled into the client also gets an entry in `BUNDLED` in `apps/client/scripts/notices.mjs`, which `npm run build` runs to write `out/THIRD_PARTY_NOTICES.txt` from each package's `LICENSE` (a licence the package does not carry, like libopus's inside libopus-wasm, is kept in `apps/client/third_party/`); `electron-builder.yml` puts that file beside the executable. The bundle keeps `@license` comments but drops other notices, so without it a BSD notice would not travel with the package.

## Publishing Through Shipwright

The maintainer publishes with shipwright under `.shipwright/contract.toml` (AGENTS.md, rule 9). Before it commits, its secret scanner reads every added line, and one finding stops the whole publication. Besides provider key formats, it flags a high-entropy assignment: a word like `token`, `pass`, `secret`, `auth` or `key`, then `:` or `=`, then 16 or more characters of mixed text. Ordinary code matches it: a `token` property set to `flags.join.token`, a `pass` property set to `Object.fromEntries(...)` and a `token` property set to `fromHex(hex)` each vetoed the first publication's scan, and so did this paragraph while it quoted them as code. Write such lines with shorthand properties (`const { token } = flags.join; return { token }`) or short local names, never by allow-listing a file. Check pending files the way a run will: `git status --porcelain --untracked-files=all | sed 's/^...//' > /tmp/paths && python3 <shipwright checkout>/lib/secrets.py scan . --paths-file /tmp/paths` (exit 0 is clean).

## Correct vs. Incorrect

**Incorrect:** a new protocol file with the header copied from the client.
```ts
// SPDX-License-Identifier: MPL-2.0
export interface Hello { version: number }
```
**Correct:** `packages/protocol` is Apache-2.0.
```ts
// SPDX-License-Identifier: Apache-2.0
export interface Hello { version: number }
```
**Why:** the check fails with `wrong SPDX header`, and the shared libraries must stay Apache-2.0 so anyone can build compatible programs on them.

**Incorrect:** a new top-level folder for helper scripts: `scripts/fetch-assets.sh`.
**Correct:** `tools/<name>/fetch-assets.sh`, with `# SPDX-License-Identifier: MPL-2.0` on line 2 after `#!/usr/bin/env bash`.
**Why:** only `apps`, `packages`, `tools`, `kits` and `docs` are allowed at the top level; a sixth means changing `topLevelFolders` in `layout.json`, which is a layout decision for the maintainer, not a convenience.

**Incorrect:** a new Apache-2.0 package with a `LICENSE` file but no `layout.json` entry.
**Correct:** the `layout.json` entry, the `LICENSING.md` row, the `LICENSE`, the `README.md`, and the README tables, together.
**Why:** without the `layout.json` entry the check treats the folder as MPL-2.0, so every correct Apache-2.0 header in it fails as `wrong SPDX header`.
