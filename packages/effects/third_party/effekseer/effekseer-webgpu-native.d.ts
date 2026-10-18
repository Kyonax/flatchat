// The module factory Emscripten makes of the runtime's WebGPU build (MODULARIZE with EXPORT_ES6): FlatChat's
// declaration for it; packages/effects/src/native.ts describes the module it resolves to.
declare function effekseer_webgpu_native(options?: Record<string, unknown>): Promise<unknown>;
export default effekseer_webgpu_native;
