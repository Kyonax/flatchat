// SPDX-License-Identifier: Apache-2.0
// The WebGL build read from third_party/effekseer, for the tests (the package's own code takes
// its build from whoever runs it: the converter in Node, the client in the browser).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeFactory } from '../src/native.ts';
import type { WebGLBuild } from '../src/measure.ts';

export const THIRD = join(dirname(fileURLToPath(import.meta.url)), '..', 'third_party', 'effekseer');

let build: WebGLBuild | undefined;
export async function testBuild(): Promise<WebGLBuild> {
  build ??= {
    factory: ((await import(join(THIRD, 'effekseer-webgl-native.js'))) as { default: NativeFactory }).default,
    wasm: new Uint8Array(readFileSync(join(THIRD, 'effekseer-webgl-native.wasm'))),
  };
  return build;
}
