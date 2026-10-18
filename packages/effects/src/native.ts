// SPDX-License-Identifier: Apache-2.0
// The pinned Effekseer runtime's C interface (third_party/effekseer: EffekseerForWeb at da76b502
// with Effekseer 1.80.7 and FlatChat's patch), bound by name, the way EffekseerForWeb's own
// TypeScript layer (MIT) binds it. Two builds share it: WebGL (the client's WebGL2 fallback, and
// Node for the converter's dry run, over a stand-in context) and WebGPU (the client's renderer).
// The runtime asks for its files by calling back into JavaScript, synchronously: the module's
// _loadBinary and _loadImage, which loadEffect sets for the length of each call.

/** The part of an Emscripten module the runtime uses. */
export interface NativeModule {
  cwrap(name: string, returnType: 'number' | null, argTypes: Array<'number'>): (...args: number[]) => number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  GL?: {
    registerContext(context: object, attrs: Record<string, unknown>): number;
    makeContextCurrent(handle: number): boolean;
  };
  _loadBinary?: (path: string, required: number) => ArrayBuffer | null;
  _loadImage?: (path: string) => unknown;
  _isPowerOfTwo?: (image: { width: number; height: number }) => boolean;
  __effekseerImportWebGPURenderPassEncoder?: (pass: unknown) => number;
}

/** The module factory either build exports (Emscripten's MODULARIZE with EXPORT_ES6). */
export type NativeFactory = (options: Record<string, unknown>) => Promise<NativeModule>;

const f = (n: number): Array<'number'> => Array<'number'>(n).fill('number');

/** Every function the runtime exports that FlatChat calls, bound once per module. */
export function bindNative(m: NativeModule) {
  const num = (name: string, args: number) => m.cwrap(`Effekseer${name}`, 'number', f(args));
  const run = (name: string, args: number) => m.cwrap(`Effekseer${name}`, null, f(args));
  return {
    initWebGL: num('InitWebGL', 4),
    initWebGPU: num('InitWebGPU', 6),
    terminate: run('Terminate', 1),
    update: run('Update', 2),
    beginUpdate: run('BeginUpdate', 1),
    updateHandle: run('UpdateHandle', 3),
    endUpdate: run('EndUpdate', 1),
    draw: run('Draw', 1),
    beginDraw: run('BeginDraw', 1),
    drawHandle: run('DrawHandle', 2),
    endDraw: run('EndDraw', 1),
    drawToPass: num('DrawToExternalWebGPURenderPass', 4),
    releasePass: run('ReleaseImportedWebGPURenderPassEncoder', 1),
    setProjection: run('SetProjectionMatrix', 2),
    setCamera: run('SetCameraMatrix', 2),
    loadEffect: num('LoadEffect', 4),
    releaseEffect: run('ReleaseEffect', 2),
    stopAll: run('StopAllEffects', 1),
    play: num('PlayEffect', 5),
    stop: run('StopEffect', 2),
    stopRoot: run('StopRoot', 2),
    exists: num('Exists', 2),
    setMatrix: run('SetMatrix', 3),
    setShown: run('SetShown', 3),
    setPaused: run('SetPaused', 3),
    setSpeed: run('SetSpeed', 3),
    setRandomSeed: run('SetRandomSeed', 3),
    setAllColor: run('SetAllColor', 6),
    restInstances: num('GetRestInstancesCount', 1),
    updateTime: num('GetUpdateTime', 1),
    drawTime: num('GetDrawTime', 1),
    setRestoration: run('SetRestorationOfStatesFlag', 2),
    setSoundVolume: run('SetSoundVolume', 2),
    pauseSound: run('PauseSound', 2),
    setLogEnabled: run('SetLogEnabled', 1),
    // FlatChat's patch (third_party/effekseer/flatchat.patch).
    instanceCount: num('GetInstanceCount', 2),
    totalInstances: num('GetTotalInstanceCount', 1),
    setSpawnDisabled: run('SetSpawnDisabled', 3),
    enableGpuTimer: num('EnableGpuTimer', 1),
    gpuTime: num('GetGpuTime', 2),
  };
}
export type Native = ReturnType<typeof bindNative>;

/** WebGPU's colour and depth formats as the runtime numbers them (EffekseerForWeb's
 *  RuntimeContext.h): the formats a pass it draws into may have. */
export const WEBGPU_COLOR_FORMATS: Readonly<Record<string, number>> = { rgba8unorm: 1, bgra8unorm: 2, 'rgba8unorm-srgb': 3, 'bgra8unorm-srgb': 4, rg11b10ufloat: 5 };
export const WEBGPU_DEPTH_FORMATS: Readonly<Record<string, number>> = { depth32float: 1, 'depth24plus-stencil8': 2, 'depth32float-stencil8': 3 };

/** Whether an error came from the runtime giving up (an abort, a trap): after one the module is
 *  spent and a new one must be made. */
export function isNativeFailure(err: unknown): boolean {
  return err instanceof Error && (err.name === 'RuntimeError' || /^(Aborted|RuntimeError|abort)\b|Aborted\(/.test(err.message));
}
