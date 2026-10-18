---
title: Effects — the Pinned Effekseer Runtime, Effect Files and Bundles, the Dry Run, the Limits and the Guard
impact: HIGH
impactDescription: A runtime file that is not the pinned build ships an unchecked binary; an effect admitted on its slowest update alone is refused on a busy machine; a dry run without a deadline hangs on a broken file; an effect judged by triangles over quads is refused when it is only a heavy mesh; an asset gate that skips effect files lets unlicensed ones ship.
tags: effects, Effekseer, EffekseerForWeb, efkefc, efk, efkpkg, efkmat, FCFX, bundle, packages/effects, third_party/effekseer, build.sh, flatchat.patch, Emscripten, emsdk 6.0.7, WebGPU render pass, drawPass, drawGl, stub GL, dry run, measure, DryRunner, worker deadline, EFFECT_LIMITS, EFFECT_RUNTIME, EffectBudget, InstanceTrim, TimeWatch, RuntimeSpent, fuzzing, kits/effects, S6.01, DR-12, rr-013, Q-M8, Q-M9
---

Stage 6's S6.01 (DR-12): every effect plays in one pinned Effekseer runtime, behind the guard layer of rr-013. The picture is `docs/effects.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/effect.ts` | `EFFECT_RUNTIME`, `EFFECT_LIMITS`; `readEffectFile` (the EFKE container's BIN_ body, or an `.efk` body: version and resources in the loader's order); the FCFX bundle (`writeBundle`, `readBundle`, `bundleFile`, `bundlePathOf`); `EffectFit`, `effectFitProblems`, `checkEffectFit` |
| `packages/effects/third_party/effekseer/` | The four runtime files (WebGL and WebGPU builds), `build.sh`, `flatchat.patch`, `LICENSE.md` (every licence inside), `README.md` (hashes, commits) |
| `packages/effects/src/native.ts`, `runtime.ts` | The C interface bound by name; `EffectsRuntime` (load from a bundle with images decoded first, play, `setMatrix`, `drawGl`, `drawPass`, `updateTimed`, counts) |
| `packages/effects/src/stub-gl.ts`, `measure.ts` | A WebGL2 context that draws nothing and counts; the measurement (web APIs only) |
| `tools/converter/src/effect/dry-run.ts`, `dry-run-worker.ts`, `samples.ts` | The dry run's Node side: the WebGL build read through `@flatchat/effects/runtime/*`, `dryRun` (this thread), `DryRunner` (a worker thread with a deadline); the samples bundled |
| `packages/effects/src/guard.ts` | `EffectBudget`, `InstanceTrim`, `TimeWatch` |
| `tools/converter/src/effect/convert.ts`, `item.ts` | `effectUpload` (an Effekseer file, an `.efkpkg`, a zip with one effect at any depth, or an FCFX bundle with its declaration), `convertEffect` (version, no `.efkmat`, every named file present, PNG textures, the bundle of exactly those files, the dry run, `effectFitProblems`), `convertEffectItem` (slot `effect`, no fingerprint); `item-cli.ts` branches on `uploadFormat(...) === 'effect'` before reading the bodies |
| `apps/client/src/renderer/src/world/effects.ts`, `effects-draw.ts`, `effects-runtime.ts` | The client's effects layer (worn effects at markers, the policy, the guard, respawn), the drawing after three's frame (WebGPU depth copy and pass, WebGL2 depth quad, timestamp probes), the lazy inlined builds |
| `apps/client/src/renderer/src/world/effects-measure.ts`, `effects-measure-worker.ts` | A world's effects checked (`checkEffectBundle`) and measured again in the client: one inlined worker (`?worker&inline`, the WebGL build and its wasm inlined), one effect at a time, terminated and replaced past `EFFECT_LIMITS.dryRunMs`; it answers the run and what it read (version, textures, pixels, models, sounds, distortion) |
| `packages/content/src/effect-check.ts` | `checkEffectBundle(bundle, where)`: the upload rules without the runtime (version, no material files, every named file present, PNG textures within `textureSide`, counts), the exact bundle the runtime will ask for, problems and warnings; the converter's `convertEffect` and the client's measuring worker both use it |
| `tools/converter/src/effect/fuzz.ts`, `scripts/hostile-effects.ts` | The seeded fuzz corpus (`fuzzCorpus`, `broken`, `effectBody`); a hostile host: six broken effects put into a built world past the converter (fuzz cases 270, 12, 0 and 1, a newer editor's laser, an effect naming a material file) |
| `packages/content/src/scene.ts`, `validate.ts`, `built.ts`; `tools/converter/src/world.ts` | World effects (rules/world-format.md): the marker, the validator's reading, `BuiltEffect`, the converter's dry runs and the world budget |
| `kits/effects/samples/`, `kits/effects/starters.json` | Five of Effekseer's CC0 samples with their textures; the starter effects (aura at the hips, shield at the chest), bundled by the core at start |

## The Rules

| Rule | Why |
|---|---|
| The runtime is EffekseerForWeb (WebGPU and WebGL builds), not EffekseerForWebGL | The client draws with three.js's WebGPU renderer; EffekseerForWebGL draws only into a WebGL context |
| Change the runtime only through `build.sh` and `flatchat.patch`, then the README's hashes | `dry-run.test.ts` checks the four files against the README; without the patch the build equals upstream's CI build byte for byte, which is what proves the sources and the toolchain (Emscripten 6.0.7) |
| The runtime asks for files synchronously (`_loadBinary`, `_loadImage`): decode images before `load` (WebGL), never fetch inside | A bundle in memory answers at once; there is no retry loop |
| Pass three.js matrices' `elements` as they are | Effekseer reads 16 floats row by row: column-major with column vectors is row-major with row vectors |
| Count the stand-in's draws by the bound program: model shaders (`mModel` in their source) are triangles, the rest quads | Instancing and index types do not tell them apart; Aura01 is 101 quads and a 16,940-triangle procedural shell |
| Judge update time by the 95th percentile, never the slowest | Three suites at once pushed the slowest past 2 ms and refused the aura and the trail |
| Unit tests that pass through the update limit use light samples (the trail, the laser, the aura), never the tornado | The harness runs every suite at once: the tornado's 95th percentile went from 0.29 ms to 2.1 ms there and refused it; the trail's is 0.06 ms |
| Bound every untrusted dry run: `DryRunner` where threads are allowed; in the core's sandbox (no threads) the in-thread deadline between frames and the core's short deadline for the whole conversion | One broken trail made a single update take 32 s; nothing interrupts a native call but ending its thread or process |
| Node built-ins stay out of `packages/*/src` (T17): the Node side of effects lives in the converter, tests may use Node | The shared packages run in the client's renderer too |
| A native failure spends the module: catch `RuntimeSpent`, make a new runtime, block the file | Emscripten aborts on a broken file and every later call throws |
| GPU particles, distortion and an avatar's effect sounds stay off | No GPU particle system is made; distortion needs a copy of the frame; Q-H1 picked no item sounds |
| Effect files are assets: `.efkefc`, `.efk`, `.efkpkg`, `.efkproj`, `.efkmodel`, `.efkmat`, `.efkcurve` need a provenance record (CC0, CC BY or the owner's own) | P.07's gate; Effekseer's repository samples are MIT and may not ship, the editor release's Sample folder is CC0 |
| Do not run Effekseer's prebuilt editor here | Running the downloaded binary was refused (2026-10-18); its CC0 samples ship as `.efkefc` already, so nothing needs converting |
| Third-party folders are outside lint (`**/third_party/` in `eslint.config.mjs`) and the layout's SPDX check | The runtime's glue is generated code |
| An effect is an item in the slot `effect` at a point (`POINT_SLOTS`), never a model slot: forms list `MODEL_SLOTS` | Its rules are the dry run's, not a mesh's caps |
| Bundle exactly the files the effect names (a sound only for a world); keep the bundle without the upload's declaration | What a client loads is what was checked, and nothing more |
| No fingerprint for effects | Their textures are generic dots and streaks: a texture match would strike the innocent |
| Pack every workspace the converter needs with the host tool, `third_party` included (`tools/host-tool/scripts/pack.ts`) | CI's host-tool job failed on 2026-10-18 when `@flatchat/effects` was fetched from the registry |
| Hand the runtime its WebAssembly through `instantiateWasm` (compiled once per build), never `wasmBinary` | Emscripten 6 reads no `wasmBinary` unless built to: the glue silently read the file beside it, which the move to `wasm/` exposed |
| Keep the `.wasm` in `third_party/effekseer/wasm/`, away from the glue | The glue's `new URL(…, import.meta.url)` made Vite copy it a second time (3.6 MB) |
| Draw effects after three's frame, over the canvas, with three's depth copied single-sampled; the world's renderer is `alpha: false` | Effekseer's sRGB blends want the finished image; its pipelines are single-sampled; effect alpha would show the page through |
| Leave an effect's first frames out of the watches (`WARM_UP`) | Aura01 makes its procedural shell on its first update; the 16 ms stall rule stopped it at once |
| In the end-to-end test, pick items by their row's text, never `first()` | The list is newest first: the starter aura took the tee's place |
| The starters play at 0.12 (`kits/effects/starters.json`) | Effekseer's samples are authored roughly ten times a person's size |
| The client measures a world's effects itself and never takes `BuiltEffect.peak` | A world comes from its host, who is not trusted; the client's own numbers decide admission |
| In the client, judge a world effect by its peaks and by a 100 ms single update (`WORLD_HITCH_US`), not by `updateMs` | `updateMs` is for the converter's machine; a weak laptop is slower, and the live watches judge time while it plays |
| The converter measures an effect once per path and scale, but counts its peaks once per marker against `EFFECT_LIMITS.world` | Every visitor plays every marker at once; two tornadoes (1,012 particles each) are over a world's 2,000 |
| Where the converter is bundled (the client's main process, offline worlds), give `convertWorld` `dryRunner: { worker, wasm }`: the worker from `@flatchat/converter/dry-run-worker?nodeWorker`, the bytes read from `@flatchat/effects/runtime/wasm/effekseer-webgl-native.wasm?asset` (`apps/client/src/main/offline.ts`, types from `electron-vite/node` in `src/main/env.d.ts`) | The bundle has no `dry-run-worker.ts` beside it and no package to resolve the wasm from: the default worker URL and `import.meta.resolve` fail there |
| A client download of a world wants its effect files too (`download.ts`) | It wanted scenes, solids, the navigation mesh and sounds only, so the world effect never had its bundle |
| Check a world's effects in the client with `checkEffectBundle` before measuring them, and fit them with what it read | A host can skip the converter: a newer editor's file, material files (creator shaders, S6.03) or a 16k texture would otherwise reach the runtime; the fit had zeros for textures and models |
| Each `DryRunner` run belongs to its worker: fail only that worker's runs on its error or exit | A worker ended at a deadline exits after its replacement started; its exit failed the new run (`effect-fuzz.test.ts`, case 270 then the laser) |
| The end-to-end test fails on any page error, and its garden carries the hostile effects | S6.01's Verify: a fuzzed corpus never crashes the client; the client must refuse all six while the tornado plays |
| Close the converter's `DryRunner` in a `finally` | A refused effect or a failing scene throws past the loop and would leave the worker running |
