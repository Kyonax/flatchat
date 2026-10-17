---
title: Toolchain and Versions — Node.js 24 from .tool-versions, npm Workspaces, Pinned Packages and Why
impact: HIGH
impactDescription: Upgrading a pinned package past its reason (TypeScript past 6.0, Electron without its download step, Node outside 24), running Node from the wrong install, or trusting an install-script prompt blindly breaks lint, builds or CI in ways that look unrelated to the change.
tags: toolchain, versions, node, node 24, nodejs, npm, npm 11, npm ci, npm install, workspaces, mise, asdf, .tool-versions, typescript, typescript 6, typescript 7, typescript-eslint, eslint 10, flat config, vitest, vite 8, rolldown, electron 44, electron download, install-electron, electron-vite, electron-builder, vue 3.5, vue-tsc, three r186, @types/three, @webgpu/types, yaml, upgrade, pin, lockfile, package-lock, install scripts, allowScripts, preserve-caught-error
---

This rule records the toolchain the repository runs on, the version of each part, and the reason behind every pin, so an upgrade is a decision rather than an accident. The stack is TypeScript from end to end: Node.js 24 runs the servers and tools, Electron 44 hosts the client, three.js draws, Vue renders the interface. Versions below were installed and checked on 2026-10-16.

## Node.js and npm

| Item | Value | Notes |
|---|---|---|
| Node.js | 24.22.0, pinned in `.tool-versions` (`nodejs 24.22.0`) | mise and asdf read it; CI's `actions/setup-node` reads it too (`node-version-file: .tool-versions`) |
| npm | 11.19 (ships with that Node) | |
| Engines | `"node": ">=24"` in every `package.json` | Node 24 runs TypeScript files directly (see below) |
| Workspaces | root `workspaces`: `apps/*`, `packages/*`, `tools/*` | one `node_modules` and one `package-lock.json` at the root |

Run Node from `.tool-versions`: `mise install` once, then `mise exec -- npm …`, or put mise's Node 24.22.0 first on `PATH`. A system Node of another major silently changes TypeScript stripping, test runs and lockfile output.

| Task | Command |
|---|---|
| Install everything (development) | `npm install` |
| Install exactly the lockfile (CI, clean checks) | `npm ci` |
| Run a script in one workspace | `npm run <script> -w @flatchat/client` |
| Run a script in every workspace that has it | `npm run <script> --workspaces --if-present` (the root `test` and `typecheck` do this) |
| Add a root development tool | `npm install --save-dev <pkg>` at the root |
| Add a dependency to one workspace | `npm install <pkg> -w @flatchat/<name>` |

## The Pinned and Chosen Versions

| Package | Version | Why this one |
|---|---|---|
| `typescript` | `~6.0.3` | TypeScript 7 (the native compiler) is out, but `typescript-eslint` 8.71 accepts TypeScript below 6.1 only; move both together. [Details](#typescript) |
| `typescript-eslint` | `^8.71.2` | The flat-config TypeScript rules for ESLint 10 |
| `eslint` | `^10.13.0` | Flat config in `eslint.config.mjs`; its recommended set includes `preserve-caught-error` |
| `@eslint/js`, `globals`, `eslint-plugin-vue`, `vue-eslint-parser` | `^10.0.1`, `^17.13.0`, `^10.11.1`, `^10.4.1` | JavaScript, browser and Node globals, and Vue rules |
| `vitest` | `^5.0.5` | Unit and process tests in every workspace |
| `yaml` | `^2.9.1` | Reads CI workflows and skill frontmatter in the harness (ISC, no dependencies) |
| `electron` | `44.8.0` (exact) | Chromium 152 and Node 24; exact because `electron-builder.yml` repeats it as `electronVersion` |
| `electron-vite` | `^6.0.0` | Builds main, preload and renderer with Vite 8 |
| `vite` | `^8.3.4` | Rolldown-based; its native bindings (`@rolldown/binding-*`, `lightningcss-*`) for Linux and Windows are both in the lockfile |
| `electron-builder` | `^26.15.3` | Linux folder and Windows zip targets |
| `vue` | `^3.5.44` | The client's interface |
| `vue-tsc` | `^3.3.13` | Type checks `.vue` files (`npm run typecheck -w @flatchat/client`) |
| `three` | `^0.186.1` (r186) | `three/webgpu` for the WebGPURenderer with its WebGL2 fallback |
| `@types/three`, `@webgpu/types` | `^0.186.0`, `^0.1.74` | Types for three and for `navigator.gpu` |
| `@types/node` | `^24.19.2` | Node 24's APIs, including `import.meta.main` |
| `node-datachannel` | `0.33.4` (exact, `apps/world-server`) | WebRTC data channels on the server and the bots (libdatachannel 0.24.5); its native binaries come as per-platform optional packages (`@node-datachannel/linux-x64-gnu`, `win32-x64-msvc`, …), so no install script runs and the lockfile lists them all |
| `libopus-wasm` | `0.4.1` (exact, `apps/client`) | Opus 1.6.1 as WebAssembly for the voice chain: encode, decode, FEC rebuilds and loss concealment (`voice-chain`); WebCodecs cannot rebuild from FEC |
| `@pixiv/three-vrm` | `3.5.5` (exact, `apps/client`) | VRM avatars on the WebGPU renderer: MToon as node materials through `MToonMaterialLoaderPlugin` with `materialType: MToonNodeMaterial` from `@pixiv/three-vrm/nodes` (three r167 or later); `VRMUtils.combineSkeletons`, `removeUnnecessaryVertices`, `rotateVRM0` (spike S0.09, `avatars-and-crowds`) |
| `meshoptimizer` | `1.3.0` (exact, `apps/client`) | Mesh simplification for the levels of detail and the proxies (`meshoptimizer/simplifier`: `simplify` keeps skinning attributes, as it only rewrites indices; `simplifySloppy` when hair cards stop it early). Its WebAssembly is inside its JavaScript, compiled under the page's `'wasm-unsafe-eval'` |

#### TypeScript
Every workspace extends `tsconfig.base.json`: target ES2024, `module`/`moduleResolution` `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`, `verbatimModuleSyntax`, `resolveJsonModule`, `erasableSyntaxOnly`, `noEmit`. Node-run workspaces add `allowImportingTsExtensions` and `types: ["node"]`; the client overrides to `module: ESNext`, `moduleResolution: Bundler` with DOM libraries, because Vite bundles it, and adds `allowImportingTsExtensions` because it type-checks the protocol package's `.ts` imports. `packages/protocol` has two configs, `tsconfig.json` (Node) and `tsconfig.web.json` (the DOM library without Node's types), and its `typecheck` runs both. Upgrading TypeScript to 7 waits for a `typescript-eslint` release that accepts it; check its peer range first (`npm view typescript-eslint peerDependencies`).

## Install-Time Behaviour Worth Knowing

| What happens | Why | What to do |
|---|---|---|
| `npm install` prints that `electron-winstaller` has install scripts "not yet covered by allowScripts" | npm 11.19 holds back install scripts nobody approved | Nothing: that script is for Squirrel installers, which this project does not build. Review with `npm install-scripts ls`; approve only with a reason |
| The first `electron` run after any `npm install` or `npm ci` prints "Downloading Electron binary..." | Electron 44 fetches its binary into `node_modules/electron/dist` on first use, not at install; a reinstall removes it | Let it run (about 110 MB, cached in `~/.cache/electron`); if it fails, delete `node_modules/electron` and run `npx install-electron --no` |
| Packaging downloads an Electron zip | `electron-builder` fetches the exact `electronVersion` for the target platform | Needs network on the first build per platform |
| `npm ci` on Windows with a lockfile written on Linux | The lockfile lists every platform's optional native package | Works; CI's Windows job proves it on every push |
| `node -v` says 25 outside the repository | mise's global Node on this desktop is newer; `.tool-versions` applies only inside the repository | Run from the repository, or `mise exec -- node …`; child processes inherit `process.execPath`, so a tool started with Node 24 stays on it |
| CI's `npm ci` fails with `Missing: @flatchat/<name>@0.0.0 from lock file` (all three jobs, before any check) | A workspace or dependency was added without running `npm install` afterwards, so `package-lock.json` does not list it; local runs still pass because `node_modules` and the workspace globs do not need the lock | `npm install`, commit `package-lock.json`; the harness's `lock` check finds this before a push (it happened on 2026-10-16) |

## Rules for Upgrades

1. One tool family per change (for example `typescript` with `typescript-eslint`), then `npm run harness`.
2. Read the new major's breaking changes before bumping; ESLint, Vite, Vitest and Electron majors have each changed defaults.
3. Electron: change `electron` in `apps/client/package.json` and `electronVersion` in `electron-builder.yml` together, then run the client's smoke and bench locally and let CI's Linux and Windows jobs pass.
4. Node: change `.tool-versions` only; CI follows it. Keep the major at 24 until a deliberate move.
5. Commit the updated `package-lock.json` with the change; the harness's `lock` check fails until the lock matches every `package.json`.

## Correct vs. Incorrect

**Incorrect:** bumping TypeScript alone.
```json
"typescript": "^7.0.0"
```
**Correct:** keep `"typescript": "~6.0.3"` until `typescript-eslint` accepts 7, then move both in one change.
**Why:** `typescript-eslint` 8.71 declares TypeScript `<6.1`; ESLint fails to start or misparses with a newer compiler.

**Incorrect:** wrapping and rethrowing without the cause.
```ts
} catch (err) {
  throw new Error(`profile is not valid JSON: ${(err as Error).message}`);
}
```
**Correct:**
```ts
} catch (err) {
  throw new Error(`profile is not valid JSON: ${(err as Error).message}`, { cause: err });
}
```
**Why:** ESLint 10's recommended `preserve-caught-error` rule fails the lint step on the first form.

**Incorrect:** running checks with whatever `node` is first on `PATH` (for example a system Node 22).
**Correct:** `mise exec -- npm run harness`, or Node 24.22.0 first on `PATH`.
**Why:** the world server and the harness are TypeScript files that Node 24 runs directly; older majors need a flag for that or differ in the details, so they fail to start or behave differently from CI.
