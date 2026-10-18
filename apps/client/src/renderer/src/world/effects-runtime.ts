// SPDX-License-Identifier: MPL-2.0
// The pinned Effekseer runtime's builds for the client (S6.01): loaded only when the first effect
// is about to play, the one for the renderer's backend. The WebAssembly comes inlined in its own
// chunk, as the default clips do, so the page's policy (no file fetches, no eval; 'wasm-unsafe-eval'
// for compiling) holds and nothing is read from disk.
import type { WebGLBuild } from '@flatchat/effects';

export async function effectsBuild(backend: 'webgpu' | 'webgl'): Promise<WebGLBuild> {
  const [module, wasm] =
    backend === 'webgpu'
      ? await Promise.all([import('@flatchat/effects/runtime/effekseer-webgpu-native.js'), import('@flatchat/effects/runtime/wasm/effekseer-webgpu-native.wasm?url&inline')])
      : await Promise.all([import('@flatchat/effects/runtime/effekseer-webgl-native.js'), import('@flatchat/effects/runtime/wasm/effekseer-webgl-native.wasm?url&inline')]);
  const bytes = new Uint8Array(await (await fetch(wasm.default)).arrayBuffer());
  return { factory: module.default as unknown as WebGLBuild['factory'], wasm: bytes };
}
