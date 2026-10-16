---
title: Rendering with three.js r186 — WebGPURenderer, the WebGL2 Fallback, Backends, Adapters and Frame Measurement
impact: HIGH
impactDescription: Reading the backend before init, mistaking a software renderer's numbers for performance, sizing a benchmark by the window, or importing the wrong three entry point produces wrong frame-rate claims, blank screens on machines without WebGPU, or measurements that change with the window manager.
tags: drawn vs shown, refresh rate, judder, memory clock switching, three.js, three, r186, webgpu, webgl2, WebGPURenderer, three/webgpu, three/tsl, renderer.init, backend, isWebGPUBackend, fallback, adapter, requestAdapter, WEBGL_debug_renderer_info, swiftshader, warp, software rendering, Microsoft Basic Render Driver, llvmpipe, frame rate, fps, frame time, percentile, 1% low, bench, drawing buffer, setSize, setPixelRatio, tiling window manager, hyprland, wayland, vulkan, greybox, scene, setAnimationLoop, vsync
---

This rule governs how the client draws: three.js r186's `WebGPURenderer`, which uses WebGPU when the GPU and driver allow it and falls back to WebGL2 by itself, and how frame rates are measured so the numbers mean something. The scene code lives in `apps/client/src/renderer/src/`: `greybox.ts` builds the scene graph (pure three objects, testable in Node), `scene.ts` owns the renderer and the loop, `frame-stats.ts` turns frame times into a summary.

## Starting the Renderer

| Step | Code | Why |
|---|---|---|
| Import | `import * as THREE from 'three/webgpu'` (TSL from `'three/tsl'`) | `three/webgpu` carries the WebGPURenderer and node materials; in r186 it shares `three.core.js` with plain `three`, so mixing the two entry points does not duplicate the core |
| Create | `new THREE.WebGPURenderer({ canvas, antialias: true })` | One renderer for both backends |
| Initialise | `await renderer.init()` | The backend is chosen here; reading it earlier gives the wrong answer |
| Which backend | `renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'` | Report it in every log and test result |
| Loop | `await renderer.setAnimationLoop((time) => …)`; stop with `setAnimationLoop(null)` | Drives rendering for both backends |
| Clean up | `setAnimationLoop(null)`, remove listeners, `renderer.dispose()` | |

Classic materials such as `MeshStandardMaterial` work on both backends; the renderer converts them to node materials.

## Naming the Adapter

| Backend | Source | Example value |
|---|---|---|
| WebGPU | `(await navigator.gpu.requestAdapter()).info`: `vendor`, `architecture`, `description` | `nvidia turing` |
| WebGL2 | `gl.getExtension('WEBGL_debug_renderer_info')` → `gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)` | `ANGLE (Microsoft, Microsoft Basic Render Driver … Direct3D11 …)` |

Wrap both in `try`; a missing name is `undefined`, never a failure.

## What the Backends Mean on Real Machines (Measured 2026-10-16)

| Machine | Backend and adapter | Blank-scene frame rate | Meaning |
|---|---|---|---|
| Desktop, NVIDIA Turing (GTX 1660 SUPER), Linux, Wayland | WebGPU, `nvidia turing` | about 140 fps (window-sized) | Real hardware; a usable number |
| Windows VM with no GPU | WebGL2 on ANGLE → Direct3D 11 on Microsoft Basic Render Driver (WARP) | about 33 fps | Software rendering: proves the fallback, not performance |
| GitHub `windows-2025` runner | WebGL2 on WARP | about 38 fps at 1008×681 | The same: a render check only |
| GitHub `ubuntu-24.04` runner under Xvfb, `--enable-unsafe-swiftshader` | WebGL2 on SwiftShader (Vulkan) | about 8 fps at 1280×720 | CPU rendering: a render check only |
| Any Linux machine without a GPU and without that flag | none: the scene cannot start | — | Chromium no longer falls back to SwiftShader for WebGL by itself |

Never quote a software renderer's frame rate as performance, and never compare frame rates across backends without naming the backend and adapter. On Wayland with NVIDIA, Chromium may log that Wayland is not compatible with Vulkan; WebGPU still works, and the warning is harmless.

## Measuring Frames (the Bench Mode)

| Rule | How the client does it |
|---|---|
| Measure a fixed pixel count | `renderer.setPixelRatio(1)` and `renderer.setSize(width, height, false)` (default 1280×720); CSS stretches the canvas to the window. Tiling window managers (Hyprland, sway, i3) resize new windows, for example to 941×479, so window-sized measurements change with the desktop |
| Remove the display's cap | Chromium's `disable-frame-rate-limit` and `disable-gpu-vsync` switches, set by the main process in bench mode |
| Skip the warm-up | Shader compilation and first uploads happen in the first frames: frames from the first 2 s are not logged |
| Log every frame | The time between animation-loop callbacks, from `performance.now()`, into `frameTimesMs` |
| Summarise | `summarizeFrames()`: frames, seconds, average fps, p50, p95, p99 and max frame time, and the 1% low (the frame rate of the slowest 1% of frames, nearest-rank percentiles) |
| Report | `window.flatchat.benchReport({ backend, adapter, width, height, warmupSeconds, summary, frameTimesMs })` |

Judge a target by the 1% low and p95 as well as the average: a 30 fps floor with a 1% low of 12 fps stutters.

## Drawn Is Not Shown

The bench counts frames **drawn**. A display shows at most its refresh rate (a 144 Hz monitor, 144 frames a second); with the cap and vsync off, the compositor shows the newest finished frame at each refresh and drops the rest, and the frames it shows come from uneven moments, so motion judders. A bench run therefore looks *less* smooth than a normal run while reporting a far larger number (measured 2026-10-16: about 1000 fps drawn on a 144 Hz screen). The bench measures what a frame costs (0.9 ms for the blank scene); judge smoothness on a normal run, which follows the display's refresh.

On NVIDIA cards a change of the memory clock (for example 405 ↔ 5000 ↔ 7000 MHz between power states) stalls the GPU briefly; a run whose memory clock kept changing showed frames of 90 ms and more that runs with a steady memory clock did not. Read the clock samples next to the frame times before blaming the code for a hitch.

## Correct vs. Incorrect

**Incorrect:** reading the backend before initialising.
```ts
const renderer = new THREE.WebGPURenderer({ canvas });
const isWebGPU = renderer.backend.isWebGPUBackend; // not decided yet
```
**Correct:**
```ts
const renderer = new THREE.WebGPURenderer({ canvas });
await renderer.init();
const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
```
**Why:** the fallback happens inside `init()`; before it the answer can be wrong on exactly the machines the fallback exists for.

**Incorrect:** a benchmark that sizes the drawing buffer from the window.
```ts
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
```
**Correct:** in bench mode, a fixed buffer.
```ts
renderer.setPixelRatio(1);
renderer.setSize(1280, 720, false);
```
**Why:** the same run on the same card measured 941×479 under a tiling window manager and 1280×720 elsewhere, so the numbers were not comparable.

**Incorrect:** "the client runs at 38 fps on Windows" from a CI log.
**Correct:** "the client draws on Windows (WebGL2, Microsoft Basic Render Driver, software); performance is measured on real hardware or the weak-laptop stand-in".
**Why:** CI runners and VMs without a GPU render on the CPU.
