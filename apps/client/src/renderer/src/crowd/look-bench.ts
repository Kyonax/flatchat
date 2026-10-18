// SPDX-License-Identifier: MPL-2.0
// The look bench (S6.05's Verify: per-effect frame-time cost on the reference laptop): a scene made to
// exercise every screen effect a world's look can ask for (a glossy floor to reflect, boxes that cast
// shadows for the light shafts, neon bars bright enough to bloom, fog) drawn through the world's own
// look code (world/look.ts) at a fixed size with no frame-rate cap, once with no screen effect, then
// with each alone, then with all of them, each for the given seconds after a short warm-up. The
// report lists each one's frame times and its cost against none.
//
//   flatchat --bench=SECONDS --bench-look=1 [--bench-size=WxH] [--bench-out=FILE]
import { DEFAULT_LOOK, type WorldLook } from '@flatchat/content';
import * as THREE from 'three/webgpu';
import { summarizeFrames } from '../frame-stats';
import { applyLook, LookPipeline, lookEffects } from '../world/look';

const LOOK: WorldLook = {
  ...DEFAULT_LOOK,
  sky: '#141821',
  fog: { colour: '#141821', near: 15, far: 70 },
  sun: { colour: '#ffe2b8', intensity: 2.2, direction: [-0.6, 0.7, -0.4] },
  ambient: { sky: '#3a4660', ground: '#1a1a1a', intensity: 0.9 },
  bloom: { strength: 1.1, threshold: 0.7, radius: 0.5 },
  shafts: { strength: 0.7 },
  reflections: { strength: 0.6 },
  filters: { crt: 0.5, grain: 0.3, vignette: 0.4, saturation: 1.15, contrast: 1.05, exposure: 1, tint: '#eef4ff' },
};

const CONFIGS: ReadonlyArray<{ name: string; on: { bloom: boolean; shafts: boolean; reflections: boolean; filters: boolean } }> = [
  { name: 'none', on: { bloom: false, shafts: false, reflections: false, filters: false } },
  { name: 'bloom', on: { bloom: true, shafts: false, reflections: false, filters: false } },
  { name: 'shafts', on: { bloom: false, shafts: true, reflections: false, filters: false } },
  { name: 'reflections', on: { bloom: false, shafts: false, reflections: true, filters: false } },
  { name: 'filters', on: { bloom: false, shafts: false, reflections: false, filters: true } },
  { name: 'all', on: { bloom: true, shafts: true, reflections: true, filters: true } },
];
const WARMUP_MS = 1000;
const WARMUP_FRAMES = 20;

/** Waits until the GPU has done everything submitted so far. WebGL's finish() does not wait in
 *  Chromium (it only flushes), and reading a pixel back costs more after some frames than others
 *  (the canvas's samples are resolved first), so on WebGL2 a fence is waited for: the same cost
 *  after every frame. */
async function gpuDone(renderer: THREE.WebGPURenderer): Promise<void> {
  const backend = renderer.backend as { device?: GPUDevice; gl?: WebGL2RenderingContext };
  if (backend.device) {
    await backend.device.queue.onSubmittedWorkDone();
    return;
  }
  const gl = backend.gl;
  const fence = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!gl || !fence) return;
  gl.flush();
  try {
    // A fence's state changes only between tasks: look again after each breath, for at most 2 s.
    for (const until = performance.now() + 2000; performance.now() < until; ) {
      const state = gl.clientWaitSync(fence, 0, 0);
      if (state !== gl.TIMEOUT_EXPIRED) return;
      await breathe();
    }
  } finally {
    gl.deleteSync(fence);
  }
}

/** Lets the page breathe: a message, not a timer (a window Chromium thinks hidden runs timers once a
 *  second, which left each effect thirty frames in CI). */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

function buildScene(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; spin: THREE.Object3D } {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(sun);
  // A glossy floor for the reflections; a ring of boxes casting shadows; neon bars to bloom.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardNodeMaterial({ color: 0x2a2f3a, roughness: 0.15, metalness: 0.6 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const spin = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2 + (i % 3), 1.4), new THREE.MeshStandardNodeMaterial({ color: 0x8a8f99, roughness: 0.6 }));
    box.position.set(Math.cos(a) * 9, 1 + (i % 3) / 2, Math.sin(a) * 9);
    spin.add(box);
    const neon = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3, 0.15), new THREE.MeshStandardNodeMaterial({ color: 0x000000, emissive: i % 2 ? 0xff2bd6 : 0x23f0ff, emissiveIntensity: 4 }));
    neon.position.set(Math.cos(a + 0.26) * 6, 1.5, Math.sin(a + 0.26) * 6);
    spin.add(neon);
  }
  scene.add(spin);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 200);
  camera.position.set(0, 3.2, 14);
  camera.lookAt(0, 1.2, 0);
  return { scene, camera, spin };
}

export async function runLookBench(canvas: HTMLCanvasElement, o: { seconds: number; width: number; height: number; onProgress: (line: string) => void }): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { mode: 'look-bench', width: o.width, height: o.height, seconds: o.seconds };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  try {
    await renderer.init();
    report['backend'] = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    renderer.setPixelRatio(1);
    renderer.setSize(o.width, o.height, false);
    const { scene, camera, spin } = buildScene();
    camera.aspect = o.width / o.height;
    camera.updateProjectionMatrix();
    const { sun } = applyLook(scene, LOOK, 80);
    const results: Array<Record<string, unknown>> = [];
    for (const c of CONFIGS) {
      o.onProgress(`Look bench: ${c.name}…`);
      const on = lookEffects(LOOK, c.on, false);
      const pipeline = c.name === 'none' ? undefined : new LookPipeline(renderer, scene, camera, LOOK, on, sun);
      const draw = async (): Promise<void> => {
        spin.rotation.y += 0.004;
        if (pipeline) pipeline.render();
        else renderer.render(scene, camera);
        await gpuDone(renderer);
      };
      // A warm-up first (the shaders compile on the first frames), then frames back to back, each
      // waited for on the GPU: the time is the frame's whole cost, not how fast its commands were
      // queued (the display's pace has no part in it).
      const warm = performance.now();
      for (let n = 0; n < WARMUP_FRAMES || performance.now() - warm < WARMUP_MS; n++) {
        await draw();
        if (n % 10 === 9) await breathe();
      }
      const times: number[] = [];
      const start = performance.now();
      while (performance.now() - start < o.seconds * 1000) {
        const t0 = performance.now();
        await draw();
        times.push(performance.now() - t0);
        if (times.length % 30 === 0) await breathe();
      }
      pipeline?.dispose();
      const s = summarizeFrames(times);
      const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
      results.push({ name: c.name, frames: times.length, avgMs: Number(mean.toFixed(3)), p95Ms: Number(s.p95Ms.toFixed(3)), avgFps: Number(s.avgFps.toFixed(1)) });
    }
    const none = results[0]!['avgMs'] as number;
    for (const r of results) r['costMs'] = Number(((r['avgMs'] as number) - none).toFixed(3));
    report['effects'] = results;
  } catch (err) {
    report['error'] = err instanceof Error ? err.message.slice(0, 300) : String(err);
  } finally {
    renderer.dispose();
  }
  return report;
}
