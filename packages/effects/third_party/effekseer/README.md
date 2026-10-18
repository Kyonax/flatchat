# The Effekseer runtime

FlatChat plays effects with one pinned runtime (S6.01, DR-12): **EffekseerForWeb** at commit `da76b5023bd7aa10fe66ee05f6fecd4b84debce3` (2026-08-19), with **Effekseer 1.80.7** inside (its submodule, `216c307192ff9bc7917472b05731bbc4fd46fa04`). It is compiled to WebAssembly by Emscripten 6.0.7 in two builds:

- **WebGPU.** The client's renderer: the runtime records its drawing into a render pass the client began.
- **WebGL.** The client's WebGL2 fallback, and Node for the converter's dry run of every uploaded effect.

EffekseerForWeb, not EffekseerForWebGL, because the client draws with three.js's WebGPU renderer: EffekseerForWebGL draws only into a WebGL context. EffekseerForWeb is the Effekseer project's newer runtime with both, and it has no release of its own yet, so it is built here from source.

## The files

```
6cea4c9e2b6341231353c875e07ed7cf82552c4b08348ac899c2c3e569e34d09  effekseer-webgl-native.js
b2fe352b134551a4a410b677b758cd152d30cda753f290500192f471746131cb  effekseer-webgl-native.wasm
345cae36a84ffe401c5bf88f499f2342b52cec1a4b9910e8913e50ba10ab188b  effekseer-webgpu-native.js
c4512a400648b1509f63c251cb8c64338ba618dd37b7dc80dea20ef8ee0694a8  effekseer-webgpu-native.wasm
```

`packages/effects/test/dry-run.test.ts` checks them against this list.

## How they are built

`bash build.sh WORKDIR` builds them from source and compares the result with the files here, byte for byte. It checks out the two commits above, installs Emscripten 6.0.7, applies `flatchat.patch` and builds both backends.

- **The patch (`flatchat.patch`).** FlatChat's changes, in two files:
  - **Five exports.** Each playing effect's particle count, the count over all of them, spawning off and on for one effect, and the GPU timer with its time per effect.
  - **Two link flags.** ES module output, so the client's bundler and Node import it alike, and a 1 GB ceiling on the module's memory.
- **Checked on 2026-10-18.** Without the patch (`--patch=no`), the build equals upstream's own CI build of that commit (run 32250773782, the `browser-native-dist` artifact), byte for byte. With it, it equals the files here.

## What the runtime does not do here

- **No GPU particles.** The runtime never makes their system, so an effect that uses them plays without those parts.
- **No distortion.** Distortion draws over a copy of the frame behind it, which the client never gives the runtime. Those parts are skipped; the rest draws.
- **Sounds only where allowed.** An avatar's effect never loads its sounds (Q-H1). A world's plays them at the "high" tier.

## Licences

Effekseer and EffekseerForWeb are MIT. The builds also contain LLGI (zlib), stb_image (public domain), Dawn's WebGPU bindings (BSD-3-Clause) and Emscripten's runtime and libraries (MIT; LLVM's under Apache-2.0 WITH LLVM-exception; musl, MIT). Every text is in [LICENSE.md](LICENSE.md), and CREDITS.md lists them.
