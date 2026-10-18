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
| `kits/effects/samples/` | Five of Effekseer's CC0 samples with their textures, for the tests |

## The Rules

| Rule | Why |
|---|---|
| The runtime is EffekseerForWeb (WebGPU and WebGL builds), not EffekseerForWebGL | The client draws with three.js's WebGPU renderer; EffekseerForWebGL draws only into a WebGL context |
| Change the runtime only through `build.sh` and `flatchat.patch`, then the README's hashes | `dry-run.test.ts` checks the four files against the README; without the patch the build equals upstream's CI build byte for byte, which is what proves the sources and the toolchain (Emscripten 6.0.7) |
| The runtime asks for files synchronously (`_loadBinary`, `_loadImage`): decode images before `load` (WebGL), never fetch inside | A bundle in memory answers at once; there is no retry loop |
| Pass three.js matrices' `elements` as they are | Effekseer reads 16 floats row by row: column-major with column vectors is row-major with row vectors |
| Count the stand-in's draws by the bound program: model shaders (`mModel` in their source) are triangles, the rest quads | Instancing and index types do not tell them apart; Aura01 is 101 quads and a 16,940-triangle procedural shell |
| Judge update time by the 95th percentile, never the slowest | Three suites at once pushed the slowest past 2 ms and refused the aura and the trail |
| Bound every untrusted dry run: `DryRunner` where threads are allowed; in the core's sandbox (no threads) the in-thread deadline between frames and the core's short deadline for the whole conversion | One broken trail made a single update take 32 s; nothing interrupts a native call but ending its thread or process |
| Node built-ins stay out of `packages/*/src` (T17): the Node side of effects lives in the converter, tests may use Node | The shared packages run in the client's renderer too |
| A native failure spends the module: catch `RuntimeSpent`, make a new runtime, block the file | Emscripten aborts on a broken file and every later call throws |
| GPU particles, distortion and an avatar's effect sounds stay off | No GPU particle system is made; distortion needs a copy of the frame; Q-H1 picked no item sounds |
| Effect files are assets: `.efkefc`, `.efk`, `.efkpkg`, `.efkproj`, `.efkmodel`, `.efkmat`, `.efkcurve` need a provenance record (CC0, CC BY or the owner's own) | P.07's gate; Effekseer's repository samples are MIT and may not ship, the editor release's Sample folder is CC0 |
| Do not run Effekseer's prebuilt editor here | Running the downloaded binary was refused (2026-10-18); its CC0 samples ship as `.efkefc` already, so nothing needs converting |
| Third-party folders are outside lint (`**/third_party/` in `eslint.config.mjs`) and the layout's SPDX check | The runtime's glue is generated code |
