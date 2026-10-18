// SPDX-License-Identifier: MPL-2.0
// The client's own dry run of a world's effect (S6.01), in a worker: a world comes from its host,
// and a host is not trusted, so the numbers its tool measured are not taken. The pinned runtime's
// WebGL build plays the effect here over a context that draws nothing (packages/effects' measure),
// and the page ends this worker if it runs past its deadline.
import { readBundle } from '@flatchat/content';
import { measure, type WebGLBuild } from '@flatchat/effects';
import factory from '@flatchat/effects/runtime/effekseer-webgl-native.js';
import wasm from '@flatchat/effects/runtime/wasm/effekseer-webgl-native.wasm?url&inline';

let build: Promise<WebGLBuild> | undefined;
const effectsBuild = async (): Promise<WebGLBuild> => ({ factory: factory as unknown as WebGLBuild['factory'], wasm: new Uint8Array(await (await fetch(wasm)).arrayBuffer()) });

self.onmessage = (ev: MessageEvent<{ id: number; bytes: Uint8Array; scale: number }>) => {
  const { id, bytes, scale } = ev.data;
  void (async () => {
    try {
      build ??= effectsBuild();
      const result = await measure(await build, readBundle(bytes), { scale });
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  })();
};
