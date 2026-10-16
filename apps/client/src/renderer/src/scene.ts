// SPDX-License-Identifier: MPL-2.0
// The render loop: the greybox on three.js's WebGPURenderer, which uses WebGPU when the GPU and
// driver allow it and falls back to WebGL2 by itself (DR-01). It reports the backend and the frame
// rate twice a second. Smoke mode reports once, after a few seconds. Bench mode draws a fixed-size
// frame, warms up, then logs every frame time for the requested seconds and reports them.
import * as THREE from 'three/webgpu';
import { summarizeFrames, type FrameSummary } from './frame-stats';
import { animate, buildGreybox } from './greybox';

export type Backend = 'WebGPU' | 'WebGL2';

export interface SceneStats {
  backend: Backend;
  fps: number;
  adapter?: string;
}

export interface SmokeReport extends SceneStats {
  frames: number;
  seconds: number;
  width: number;
  height: number;
}

export interface BenchReport {
  backend: Backend;
  adapter?: string;
  width: number;
  height: number;
  warmupSeconds: number;
  summary: FrameSummary;
  frameTimesMs: number[];
}

export interface BenchOptions {
  seconds: number;
  width: number;
  height: number;
  onDone: (report: BenchReport) => void;
}

export interface SceneOptions {
  onStats: (stats: SceneStats) => void;
  onSmoke?: (report: SmokeReport) => void;
  bench?: BenchOptions;
}

const SMOKE_AFTER_MS = 3000;
const BENCH_WARMUP_MS = 2000;

export async function startScene(canvas: HTMLCanvasElement, options: SceneOptions): Promise<() => void> {
  // Machines with two GPUs (laptops with a discrete card, desktops with the CPU's graphics on) must draw on the stronger one.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  await renderer.init();
  const backend: Backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const adapter = await describeAdapter(renderer, backend);
  const box = buildGreybox();
  const { bench, onStats, onSmoke } = options;

  let resize: (() => void) | undefined;
  if (bench) {
    // A fixed drawing buffer: the same pixel work whatever size the window manager gives the window.
    renderer.setPixelRatio(1);
    renderer.setSize(bench.width, bench.height, false);
    box.camera.aspect = bench.width / bench.height;
    box.camera.updateProjectionMatrix();
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    resize = (): void => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setSize(w, h, false);
      box.camera.aspect = w / h;
      box.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
  }

  const start = performance.now();
  let frames = 0;
  let windowFrames = 0;
  let windowStart = start;
  let smokeSent = false;
  let last: number | undefined;
  let measuredMs = 0;
  let benchDone = false;
  const frameTimesMs: number[] = [];

  await renderer.setAnimationLoop((time: number) => {
    animate(box, time);
    renderer.render(box.scene, box.camera);
    frames += 1;
    windowFrames += 1;
    const now = performance.now();
    if (now - windowStart >= 500) {
      onStats({ backend, fps: (windowFrames * 1000) / (now - windowStart), ...(adapter ? { adapter } : {}) });
      windowFrames = 0;
      windowStart = now;
    }
    if (onSmoke && !smokeSent && now - start >= SMOKE_AFTER_MS) {
      smokeSent = true;
      const seconds = (now - start) / 1000;
      onSmoke({
        backend,
        fps: frames / seconds,
        frames,
        seconds,
        width: canvas.width,
        height: canvas.height,
        ...(adapter ? { adapter } : {}),
      });
    }
    if (bench && !benchDone && now - start >= BENCH_WARMUP_MS) {
      if (last !== undefined) {
        frameTimesMs.push(now - last);
        measuredMs += now - last;
      }
      last = now;
      if (measuredMs >= bench.seconds * 1000) {
        benchDone = true;
        void renderer.setAnimationLoop(null);
        bench.onDone({
          backend,
          width: canvas.width,
          height: canvas.height,
          warmupSeconds: BENCH_WARMUP_MS / 1000,
          summary: summarizeFrames(frameTimesMs),
          frameTimesMs: frameTimesMs.map((t) => Math.round(t * 1000) / 1000),
          ...(adapter ? { adapter } : {}),
        });
      }
    }
  });

  return () => {
    void renderer.setAnimationLoop(null);
    if (resize) window.removeEventListener('resize', resize);
    renderer.dispose();
  };
}

async function describeAdapter(renderer: THREE.WebGPURenderer, backend: Backend): Promise<string | undefined> {
  try {
    if (backend === 'WebGPU') {
      const info = (await navigator.gpu?.requestAdapter())?.info;
      if (!info) return undefined;
      return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || undefined;
    }
    const gl = (renderer.backend as { gl?: WebGL2RenderingContext }).gl;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : undefined;
  } catch {
    return undefined;
  }
}
