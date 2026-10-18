// SPDX-License-Identifier: MPL-2.0
// KTX2 textures in the client (S4.12). The Basis transcoder runs in KTX2Loader's worker, which
// inherits the page's policy: no evaluating text as script. This builds the worker's script exactly
// as KTX2Loader does, runs it in a V8 context with code generation from strings turned off (what
// the policy does), and feeds it the textures of a reference avatar converted with KTX2, as the
// core converts every upload: the patched transcoder starts and transcodes every level of each.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// trap-lint: allow T12 because it only reproduces the page's no-eval policy around three.js's own transcoder; nothing untrusted runs in it
import { createContext, runInContext } from 'node:vm';
import { readGltf } from '@flatchat/content';
import { convertAvatar } from '@flatchat/converter/avatar';
import { sampleAvatar } from '@flatchat/converter/samples';
// trap-lint: allow T11 because the test takes the worker's source from it, as KTX2Loader builds it
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, it } from 'vitest';
import { TranscoderError, withoutEval } from '../src/renderer/src/world/basis-transcoder';

const require = createRequire(import.meta.url);
const TRANSCODER_JS = readFileSync(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'), 'utf8');
const TRANSCODER_WASM = new Uint8Array(readFileSync(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.wasm')));
/** What a desktop GPU answers (BC1 to BC7, nothing else), as detectSupport reports it. */
const DESKTOP = { astcSupported: false, astcHDRSupported: false, etc1Supported: false, etc2Supported: false, dxtSupported: true, bptcSupported: true, pvrtcSupported: false };

type Answer = { type: string; id: number; error?: string; data?: { width: number; height: number; faces: Array<{ mipmaps: Array<{ data: Uint8Array; width: number; height: number }> }> } };

/** The worker's script, put together as KTX2Loader.init puts it. */
function workerScript(transcoder: string): string {
  const k = KTX2Loader as unknown as { BasisWorker: () => void; EngineFormat: object; EngineType: object; TranscoderFormat: object; BasisFormat: object };
  const fn = k.BasisWorker.toString();
  return [
    '/* constants */',
    `let _EngineFormat = ${JSON.stringify(k.EngineFormat)}`,
    `let _EngineType = ${JSON.stringify(k.EngineType)}`,
    `let _TranscoderFormat = ${JSON.stringify(k.TranscoderFormat)}`,
    `let _BasisFormat = ${JSON.stringify(k.BasisFormat)}`,
    '/* basis_transcoder.js */',
    transcoder,
    '/* worker */',
    fn.substring(fn.indexOf('{') + 1, fn.lastIndexOf('}')),
  ].join('\n');
}

/** A context that refuses to turn text into code, like the client's page and its workers. */
function noEvalContext(extra: Record<string, unknown> = {}): ReturnType<typeof createContext> {
  return createContext({ console, setTimeout, clearTimeout, performance, ...extra }, { codeGeneration: { strings: false, wasm: true } });
}

/** The worker, started in such a context: post() is a message to it, answers what it posted back. */
function startWorker(transcoder: string): { post: (data: unknown) => void; answers: Answer[] } {
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const answers: Answer[] = [];
  const self = {
    location: { href: 'blob:flatchat/basis' },
    addEventListener: (_type: string, listener: (e: { data: unknown }) => void) => void listeners.push(listener),
    postMessage: (m: Answer) => void answers.push(m),
  };
  const importScripts = (): never => {
    throw new Error('the worker imports nothing');
  };
  runInContext(workerScript(transcoder), noEvalContext({ self, importScripts }));
  return { post: (data) => listeners.forEach((l) => l({ data })), answers };
}

/** The KTX2 images inside a GLB. */
function ktx2Images(glb: Uint8Array): Uint8Array[] {
  const { json, bin } = readGltf(glb, 'level.glb');
  const g = json as unknown as { images?: Array<{ mimeType?: string; bufferView?: number }>; bufferViews?: Array<{ byteOffset?: number; byteLength: number }> };
  return (g.images ?? [])
    .filter((i) => i.mimeType === 'image/ktx2' && i.bufferView !== undefined)
    .map((i) => {
      const v = g.bufferViews![i.bufferView!]!;
      return bin!.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    });
}

describe('the Basis transcoder under the page’s policy', () => {
  it('runs in a context that refuses code made from text, as the page’s policy does', () => {
    expect(() => runInContext('new Function("return 1")', noEvalContext())).toThrow(/disallowed/);
  });

  it('builds functions from text as three.js ships it, and not once patched', () => {
    expect(TRANSCODER_JS).toContain('newFunc(Function');
    expect(withoutEval(TRANSCODER_JS)).not.toContain('newFunc(Function');
  });

  it('refuses a transcoder it does not know', () => {
    expect(() => withoutEval('var BASIS = () => {};')).toThrow(TranscoderError);
  });

  it('patched, starts and transcodes every level of a converted avatar’s textures', async () => {
    const avatar = await convertAvatar(await sampleAvatar('vrm1'), { ktx2: true });
    const images = (['lod0', 'impostor'] as const).flatMap((level) => ktx2Images(avatar.files.get(avatar.manifest.levels[level].file)!));
    expect(images.length).toBeGreaterThanOrEqual(2);

    const worker = startWorker(withoutEval(TRANSCODER_JS));
    worker.post({ type: 'init', config: DESKTOP, transcoderBinary: TRANSCODER_WASM.slice().buffer });
    images.forEach((image, id) => worker.post({ type: 'transcode', id, buffer: image.slice().buffer, taskConfig: {} }));
    for (let i = 0; i < 200 && worker.answers.length < images.length; i++) await new Promise((r) => setTimeout(r, 25));

    expect(worker.answers.map((a) => a.type)).toEqual(images.map(() => 'transcode'));
    for (const a of worker.answers) {
      const mipmaps = a.data!.faces[0]!.mipmaps;
      expect(a.data!.width).toBeGreaterThan(0);
      expect(mipmaps.length).toBe(Math.floor(Math.log2(Math.max(a.data!.width, a.data!.height))) + 1);
      expect(mipmaps.every((m) => m.data.byteLength > 0)).toBe(true);
    }
  }, 60_000);
});
