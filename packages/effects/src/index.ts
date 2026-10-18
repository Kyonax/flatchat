// SPDX-License-Identifier: Apache-2.0
// FlatChat's effects (S6.01): the pinned Effekseer runtime (third_party/effekseer), bound and
// guarded, with web APIs only (the shared packages' rule): the client takes it, the measurement
// included, and the converter's dry run (tools/converter/src/effect/dry-run.ts) is its Node side.
export { bindNative, isNativeFailure, type Native, type NativeFactory, type NativeModule, WEBGPU_COLOR_FORMATS, WEBGPU_DEPTH_FORMATS } from './native.ts';
export { type EffectImage, EffectsRuntime, type GraphicsObject, type LoadedEffect, type LoadOptions, RuntimeSpent, type WebGLRuntimeOptions, type WebGPURuntimeOptions } from './runtime.ts';
export { EffectBudget, InstanceTrim, type Owner, type Peaks, type Refusal, TimeWatch } from './guard.ts';
export { type DryRun, DryRunFailed, type DryRunOptions, imageSizes, measure, standIn, type WebGLBuild } from './measure.ts';
export { type DrawCount, stubGl } from './stub-gl.ts';
