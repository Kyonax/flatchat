// SPDX-License-Identifier: MPL-2.0
// Drawing effects into the world's frame (S6.01). Effekseer's effects are made for a finished,
// display-ready image (its textures are sRGB and its blends assume it), so they are drawn after
// three.js has rendered the scene and written it to the canvas, over that image, and hidden
// behind what stands in front of them by the scene's own depth:
//
//   - WebGPU: three keeps the scene's depth in its frame buffer target (multisampled when the
//     renderer antialiases), which the runtime cannot draw against (its pipelines are single
//     sampled), so one small pass copies it, sample 0 a pixel, into a depth texture of our own;
//     then the runtime records into a pass on the canvas's texture with that depth.
//   - WebGL2: three resolves the scene's depth into its frame buffer target's texture; one quad
//     writes it into the canvas's own depth buffer, then the runtime draws, and three's state
//     cache is reset after it.
//
// three's frame buffer target and its depth are internals (r186): every step checks they are
// there, and without them effects draw over the image with no depth (`depth` false in the stats).
// On WebGPU the effects' pass is timed with timestamp queries when the device has them; when it
// takes longer than an effect may, a probe frame draws each effect in a pass of its own, for the
// GPU watch.
import * as THREE from 'three/webgpu';
import type { EffectsRuntime } from '@flatchat/effects';

type Internals = {
  _getFrameBufferTarget?: () => THREE.RenderTarget | null;
  _textures?: { get(rt: THREE.RenderTarget): { depthTexture?: THREE.Texture | null } | undefined };
  _canvasTarget?: { depthTexture?: THREE.Texture };
  backend: { device?: GPUDevice; context?: GPUCanvasContext; gl?: WebGL2RenderingContext; get(o: object): { texture?: GPUTexture; textureGPU?: WebGLTexture } | undefined; isWebGPUBackend?: boolean };
};

const RESOLVE = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@group(0) @binding(0) var depthMs: texture_depth_multisampled_2d;
@fragment fn fsMs(@builtin(position) at: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(depthMs, vec2i(at.xy), 0);
}
`;
const RESOLVE_SINGLE = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@group(0) @binding(0) var depth1: texture_depth_2d;
@fragment fn fs1(@builtin(position) at: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(depth1, vec2i(at.xy), 0);
}
`;

/** The scene's depth as three left it, for the frame just rendered. */
function sceneDepth(renderer: THREE.WebGPURenderer): THREE.Texture | undefined {
  const r = renderer as unknown as Internals;
  const fbt = r._getFrameBufferTarget?.();
  const fromTarget = fbt ? (fbt.depthTexture ?? r._textures?.get(fbt)?.depthTexture ?? undefined) : undefined;
  return fromTarget ?? r._canvasTarget?.depthTexture ?? undefined;
}

export interface DrawResult {
  /** Whether the scene's depth hid the effects behind what stands in front of them. */
  depth: boolean;
  /** The GPU time of each effect, by handle, in milliseconds, when this frame measured it. */
  gpuMs?: Map<number, number>;
}

/** Draws effects on WebGPU, after three's frame. */
export class WebGpuEffectsDraw {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private depth: GPUTexture | undefined;
  private readonly pipelines = new Map<number, GPURenderPipeline>();
  private readonly timing: Timestamps | undefined;
  private readonly renderer: THREE.WebGPURenderer;
  private probeIn = 0;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    const b = (renderer as unknown as Internals).backend;
    this.device = b.device!;
    this.context = b.context!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.timing = this.device.features.has('timestamp-query') ? new Timestamps(this.device) : undefined;
  }

  get colorFormat(): string {
    return this.format;
  }

  private ownDepth(width: number, height: number): GPUTexture {
    if (!this.depth || this.depth.width !== width || this.depth.height !== height) {
      this.depth?.destroy();
      this.depth = this.device.createTexture({ label: 'flatchat-effects-depth', size: { width, height }, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return this.depth;
  }

  private resolvePipeline(samples: number): GPURenderPipeline {
    let p = this.pipelines.get(samples);
    if (!p) {
      const module = this.device.createShaderModule({ code: samples > 1 ? RESOLVE : RESOLVE_SINGLE });
      p = this.device.createRenderPipeline({
        label: 'flatchat-effects-depth-copy',
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: samples > 1 ? 'fsMs' : 'fs1', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(samples, p);
    }
    return p;
  }

  /** Draws every shown effect; `handles` are the ones playing, for a probe frame. */
  draw(runtime: EffectsRuntime, handles: readonly number[], probeOver: boolean): DrawResult {
    const target = this.context.getCurrentTexture();
    const width = target.width;
    const height = target.height;
    const encoder = this.device.createCommandEncoder({ label: 'flatchat-effects' });
    const depth = this.ownDepth(width, height);
    // The scene's depth, copied single-sampled.
    let hasDepth = false;
    const scene = sceneDepth(this.renderer);
    const gpu = scene ? (this.renderer as unknown as Internals).backend.get(scene)?.texture : undefined;
    if (gpu && gpu.width === width && gpu.height === height && (gpu.usage & GPUTextureUsage.TEXTURE_BINDING) !== 0) {
      const pipeline = this.resolvePipeline(gpu.sampleCount);
      const bind = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: gpu.createView({ aspect: 'depth-only' }) }] });
      const copier = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      copier.setPipeline(pipeline);
      copier.setBindGroup(0, bind);
      copier.draw(3);
      copier.end();
      hasDepth = true;
    }
    const color = target.createView();
    const effectsPass = (timed: boolean, index = 0): GPURenderPassEncoder =>
      encoder.beginRenderPass({
        label: 'flatchat-effects-pass',
        colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), ...(hasDepth ? { depthLoadOp: 'load' as const } : { depthClearValue: 1, depthLoadOp: 'clear' as const }), depthStoreOp: 'store' },
        ...(timed && this.timing ? { timestampWrites: this.timing.writes(index) } : {}),
      });
    let measured: Map<number, number> | undefined;
    // A probe frame (the last frame's effects took longer than one may, at most every 10th frame):
    // each effect in a pass of its own, the others hidden.
    const probe = this.timing && probeOver && handles.length > 1 && --this.probeIn <= 0 && this.timing.ready(handles.length);
    if (probe) {
      this.probeIn = 10;
      handles.forEach((h, i) => {
        for (const o of handles) runtime.setShown(o, o === h);
        const recorder = effectsPass(true, i);
        runtime.drawPass(recorder, this.format, 'depth32float');
        recorder.end();
      });
      for (const o of handles) runtime.setShown(o, true);
      this.timing!.resolve(encoder, handles.length);
    } else {
      const timed = this.timing?.ready(1) ?? false;
      const recorder = effectsPass(timed, 0);
      runtime.drawPass(recorder, this.format, 'depth32float');
      recorder.end();
      if (timed) this.timing!.resolve(encoder, 1);
    }
    this.device.queue.submit([encoder.finish()]);
    if (this.timing) {
      const took = this.timing.collect(probe ? handles : undefined);
      if (took) measured = took;
    }
    return { depth: hasDepth, ...(measured ? { gpuMs: measured } : {}) };
  }

  dispose(): void {
    this.depth?.destroy();
    this.timing?.dispose();
  }
}

/** Timestamp queries for the effects' passes: written each frame they are free, read back a few
 *  frames later. `collect` returns the last result once: by handle for a probe, else the whole
 *  pass under the key -1. */
class Timestamps {
  private readonly set: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private busy = false;
  private pending: { handles: readonly number[] | undefined; count: number } | undefined;
  private result: Map<number, number> | undefined;
  private mapping = false;
  private static readonly MAX = 64;

  constructor(device: GPUDevice) {
    this.set = device.createQuerySet({ type: 'timestamp', count: Timestamps.MAX * 2 });
    this.resolveBuffer = device.createBuffer({ size: Timestamps.MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuffer = device.createBuffer({ size: Timestamps.MAX * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  ready(count: number): boolean {
    return !this.busy && count <= Timestamps.MAX;
  }

  writes(index: number): GPURenderPassTimestampWrites {
    return { querySet: this.set, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 };
  }

  resolve(encoder: GPUCommandEncoder, count: number): void {
    encoder.resolveQuerySet(this.set, 0, count * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, count * 16);
    this.busy = true;
    this.pending = { handles: undefined, count };
  }

  collect(handles: readonly number[] | undefined): Map<number, number> | undefined {
    if (this.pending && this.pending.handles === undefined && this.busy && !this.mapping) {
      const p = this.pending;
      p.handles = handles ?? [];
      this.mapping = true;
      this.readBuffer.mapAsync(GPUMapMode.READ, 0, p.count * 16).then(
        () => {
          const t = new BigUint64Array(this.readBuffer.getMappedRange(0, p.count * 16).slice(0));
          this.readBuffer.unmap();
          const out = new Map<number, number>();
          for (let i = 0; i < p.count; i++) out.set(p.handles && p.handles.length ? p.handles[i]! : -1, Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6);
          this.result = out;
          this.busy = false;
          this.mapping = false;
          this.pending = undefined;
        },
        () => {
          this.busy = false;
          this.mapping = false;
          this.pending = undefined;
        },
      );
    }
    const r = this.result;
    this.result = undefined;
    return r;
  }

  dispose(): void {
    this.set.destroy();
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }
}

const COPY_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const COPY_FS = `#version 300 es
precision highp float;
uniform highp sampler2D depthTexture;
void main() {
  gl_FragDepth = texelFetch(depthTexture, ivec2(gl_FragCoord.xy), 0).r;
}`;

/** Draws effects on WebGL2, after three's frame. */
export class WebGlEffectsDraw {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private readonly renderer: THREE.WebGPURenderer;
  readonly gpuTimer: boolean;

  constructor(renderer: THREE.WebGPURenderer, runtime: EffectsRuntime) {
    this.renderer = renderer;
    this.gl = (renderer as unknown as Internals).backend.gl!;
    // The runtime's own GPU timer per effect needs the browser's timer queries.
    this.gpuTimer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null && runtime.enableGpuTimer();
  }

  private ensure(): boolean {
    if (this.program) return true;
    const gl = this.gl;
    const shader = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, COPY_VS);
    const fs = shader(gl.FRAGMENT_SHADER, COPY_FS);
    if (!vs || !fs) return false;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return false;
    this.program = p;
    this.vao = gl.createVertexArray();
    return true;
  }

  draw(runtime: EffectsRuntime, handles: readonly number[]): DrawResult {
    const gl = this.gl;
    const scene = sceneDepth(this.renderer);
    const tex = scene ? (this.renderer as unknown as Internals).backend.get(scene)?.textureGPU : undefined;
    let hasDepth = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.SCISSOR_TEST);
    if (tex && this.ensure()) {
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.program!, 'depthTexture'), 0);
      gl.colorMask(false, false, false, false);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.ALWAYS);
      gl.depthMask(true);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.colorMask(true, true, true, true);
      gl.depthFunc(gl.LEQUAL);
      gl.bindVertexArray(null);
      hasDepth = true;
    } else {
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    runtime.drawGl();
    this.renderer.resetState();
    let gpuMs: Map<number, number> | undefined;
    if (this.gpuTimer) {
      gpuMs = new Map();
      for (const h of handles) gpuMs.set(h, runtime.gpuTime(h) / 1000);
    }
    return { depth: hasDepth, ...(gpuMs ? { gpuMs } : {}) };
  }

  dispose(): void {
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.vao) this.gl.deleteVertexArray(this.vao);
  }
}
