---
title: Avatars and Crowds — VRM on the WebGPU Renderer, the Converter's Stand-ins, the Crowd Bench and the S0.09 Pass Lines
impact: HIGH
impactDescription: VRM materials left as exported (15 to 17 a VRoid avatar, about 55 draw calls), textures unbudgeted (about 110 MB an avatar), texture copies three-vrm makes uploaded one by one, or a new avatar's work done in one frame make a crowd miss 30 fps even on a desktop, blow the 2 GB memory line, or stall frames past 100 ms whenever someone arrives.
tags: avatars, crowd, crowds, VRM, VRM 0.x, VRM 1.0, three-vrm, @pixiv/three-vrm, MToon, MToonNodeMaterial, MToonMaterialLoaderPlugin, VRMUtils, combineSkeletons, rotateVRM0, spring bones, springBoneManager, expressions, humanoid, normalized bones, GLTFLoader, meshoptimizer, simplify, simplifySloppy, level of detail, LOD, proxy, impostor, atlas, material merge, draw calls, texture budget, KTX2, BC7, Source, initTexture, compileAsync, crowd bench, --crowd, --avatars, flatchat-avatar, avatar-files, crowd-pass, stand-in crowd, S0.09, S-AVATAR, kill line, VRoid, 100Avatars
---

This rule governs `apps/client/src/renderer/src/crowd/` (spike S0.09's crowd bench) and what it taught about drawing many VRM avatars on three.js's WebGPU renderer. Stage 4 made those lessons real: the converter (rule `avatar-converter`) merges materials and fits textures for the lighter levels, and the world draws players' avatars with `world/avatar-layer.ts` (rule `client-app`, "Avatars in the World"); the bench still measures crowds and its loader is what `avatar-loader.ts` reuses (`shareTextures`).

## The Files

| File | Job |
|---|---|
| `crowd/layout.ts` | Where the crowd stands (pure): full avatars 2.5 to 12 m away and all in view, the lower detail 15 to 45 m, proxies 50 to 120 m all around; walking circles at most a quarter of the distance |
| `crowd/walk.ts` | A procedural walk and idle as Euler angles for VRM's normalized bones (pure) |
| `crowd/remap.ts` | Skin weights handed to the nearest kept (humanoid) joint, four per vertex (pure) |
| `crowd/avatar.ts` | Loading with three-vrm, `shareTextures`, `mergeAvatar`, `fitTextures`, `simplifyAvatar`, `buildProxy` and the `Proxy` class, `poseAvatar` |
| `crowd/crowd.ts` | The bench: the scene, the tiers, the loop, the paced swaps, the report |
| `src/main/avatar-files.ts`, `avatar-protocol.ts` | The read-only `flatchat-avatar://bench/` protocol over one folder (Electron-free listing and checks, then the scheme) |
| `src/main/crowd-pass.ts` | S0.09's pass lines, with the stand-in's headroom |

## Loading VRM on the WebGPU Renderer

| Point | Rule |
|---|---|
| MToon | `new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial })` (from `@pixiv/three-vrm/nodes`) passed to `VRMLoaderPlugin` as `mtoonMaterialPlugin`; the plain `MToonMaterial` is WebGL-only |
| After the load | `VRMUtils.removeUnnecessaryVertices`, `VRMUtils.combineSkeletons` (one skeleton per avatar), `VRMUtils.rotateVRM0` (a VRM 0.x avatar faces −z until turned) |
| Outlines | three-vrm draws MToon's outline as a second material over the same triangles; the low preset keeps only the surface material |
| Shared textures | three-vrm gives each material slot its own texture object, and three.js's WebGPU renderer uploads every texture object on its own: a VRoid avatar uploaded 68 to 72 textures from 28 images. `shareTextures` keeps one object per image and sampling |
| VRM 0.x poses | Its normalized rig was built facing −z, before `rotateVRM0`: negate the x and z rotations (three-vrm's own VRMA player does) |
| The page's policy | `connect-src 'self' blob: data: flatchat-avatar:`, `img-src 'self' data: blob:`, `worker-src 'self' blob:`: GLTFLoader fetches embedded images as blob URLs (see `client-electron`) |
| The trap linter | T11 warns on `three/addons/loaders/*` in the client; `avatar.ts` carries `trap-lint: allow T11` because the converter does not exist yet. A shipping client loads only the converter's output |

## What the Converter Must Do (Measured on the Bench)

| Finding (2026-10-17, the desktop) | Consequence |
|---|---|
| VRoid avatars as exported: 15 to 17 materials, about 55 draw calls each; the plan's crowd (12 full, 20 lower detail, 55 present) drew 1,848 calls and ran at 25 fps, p95 42.9 ms, on a GTX 1660 SUPER | Merging materials is load-bearing: `mergeAvatar` (parts grouped by alpha mode, one atlas each) brought the same crowd to 85 draw calls and 87 fps (p95 12.3 ms) |
| As exported, about 110 MB of RGBA textures an avatar (28 images) | `fitTextures` scales an avatar's images by one factor to a budget: 16 MB for a full avatar (the plan's 3-material test avatar as three 2,048 px KTX2 textures with mipmaps), a quarter at the lower detail |
| The render call's CPU time, not the GPU, sets the frame: about 9 ms of `render()` for about 110 skinned objects (roughly 80 µs each), against 0.5 ms of GPU time (2.3 ms at p95, from timestamp queries: `trackTimestamp: true`, `resolveTimestampsAsync('render')` returns the last frame's time, not a sum) | Fewer objects per avatar (merged meshes, proxies) is the lever; refreshing transforms less often did not help. A stand-in that only slows the GPU barely changes the frame |
| Spring bones on six VRoid avatars: about 1.6 ms a frame | Keep springs to the nearest few |

## Paced Swaps (No Frame over 100 ms While Someone Arrives)

A new avatar's work spreads over frames: load and parse (async; its main-thread pieces stay under 50 ms), merge (one atlas image per frame) and fit the textures (one image per frame, `pace`), upload one texture per frame (`renderer.initTexture`, under 1 ms each), `renderer.compileAsync(holder, camera, scene)`, then show its meshes one per frame. Each measured frame records which step was under way (`byPhase`), so a long frame names its cause. Unpaced, a swap stalled frames for up to 184 ms; paced, the worst in the plan's crowd on the desktop were 46.5 ms (load), 48.8 (fit), 31.1 (upload), 44.6 (compile) and 69.6 ms (show; 87.7 with 200 present): a mesh's first draw costs three.js tens of milliseconds even after `compileAsync`. Garbage collection is not the cause (V8's longest pause in a traced run, `--js-flags=--trace-gc`: 5.8 ms).

## The Bench

| Run | Command |
|---|---|
| The plan's crowd, 5 minutes | `apps/client/release/linux-unpacked/flatchat --crowd=300 --avatars=DIR --crowd-out=FILE --crowd-shot=FILE.png` (12 full with springs on the nearest 6, 20 lower detail at 15 Hz, 55 present, a swap every 15 s, 16 MB textures, merged) |
| 200 present | add `--crowd-present=200` |
| As exported | `--crowd-merge=0` |
| On the stand-in (the owner's sudo) | `npm run standin -- run --target iris-xe --seconds 300 --crowd DIR` (and `--target 680m`): the frame lines tighten by the profile's headroom (1.5); converted avatars with `--converted [--in-view 55] [--tier low\|medium\|high]` (S4.12) |
| Converted avatars, the world's own layer (S4.05, S4.12) | `node tools/bots/src/avatar-bench.ts --from DIR --out CONVERTED --client CLIENT --seconds 60 --present 200 --in-view 55 [--tier low\|medium\|high] [--headroom 1.5]`: converts each file once into a folder (`manifest.json` and its levels as `<sha256>.vrm`), then `--crowd-converted=1` (`crowd/converted.ts`) draws them with `AvatarLayer`. The policy: a tier's as it ships (`--crowd-tier`, `TIER_POLICY`), or `--crowd-full`/`--crowd-lod`/`--crowd-springs` (12/20/6) with every rank in full. The worst case the policy allows: the full quota within 8 m (the heaviest avatars it draws in full), the lower quota at 9 to 13 m (the heaviest of all: LOD1 has no rank gate), the rest of the 55 in view at 21 to 34 m, the others out of view (beyond 75° either side). The report adds `policy`, `inView`, `cpuMs` (the layer's update and the render call, medians) and `fullExpected` (the full line's count). `--crowd-proportions=1` puts everyone at the proportion sliders' ends (S4.10's look check) and `--crowd-shot=FILE.png` takes the picture a second into the measured run. Measured 2026-10-17 on the desktop, 68 real avatars (converter 1.2.0), 60 s, p95 / worst frame / draw calls / MB: low 13.4 / 55.4 / 111 / 1,161; medium 15.8 / 52.0 / 119 / 1,225; high 17.7 / 26.0 / 163 / 1,350; every rank in full 25.5 / 33.6 / 669 / 1,589 (docs/avatars.md) |

The report: frame times (warm-up 5 s excluded), `framesOver100`, `duringLoads`, `byPhase`, `cpuMs` (update and render per frame), draw calls and triangles, each tier's triangles, materials and texture MB, every swap's steps, and every process's resident memory sampled each second by the main process. The pass lines (`crowd-pass.ts`): p95 ≤ 33.3 ms, the worst frame ≤ 100 ms, at least 8 full avatars, all processes together ≤ 2,048 MB.

## Sources of Test Avatars

| Set | Facts | Where |
|---|---|---|
| VRoid Studio samples (VRoid Project, pixiv) | 8 VRM 0.x avatars, 26.7k to 39.5k triangles (on the plan's 20–30k), 15 to 17 materials, 134 to 498 joints, springs; CC0 on OpenGameArt, VRoid Hub's free-use terms in six files | `~/.cache/flatchat/avatars/vroid-cc0` (manifest, SOURCE.md); never in the repository |
| 100Avatars R1 (Polygonal Mind) | 60 VRM 0.x avatars, about 3.9k triangles, 1 material, CC0 | `~/.cache/flatchat/avatars/100avatars` (manifest) |

## Outfits on Avatars (S5.05)

The avatar layer also dresses players (rule `client-app`, Standard Bodies, Items and Outfits): clothes only on the three standard bodies (an avatar whose delivery says `kit`), each fit bound to the body's own bones with the fit's inverse bind matrices, the regions it hides taken off the body's triangles; props on any avatar at their points. Only LOD0 to LOD2 wear them; impostors show the body alone, so a crowd's cost past LOD2 is unchanged. A fit shares its parsed geometry and material with every wearer, which adds a skinned mesh (a draw call or two) per item per dressed avatar: the bench (S4.12) has not been run with outfits yet.
