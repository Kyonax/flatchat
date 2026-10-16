// SPDX-License-Identifier: MPL-2.0
// The blank scene: a greybox floor and a turning block on three.js's WebGPURenderer, which uses
// WebGPU when the GPU and driver allow it and falls back to WebGL2 by itself (DR-01). It reports the
// backend and the frame rate twice a second; in smoke mode it also reports once, after a few seconds.
import * as THREE from 'three/webgpu';

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

const SMOKE_AFTER_MS = 3000;

export async function startScene(
  canvas: HTMLCanvasElement,
  onStats: (stats: SceneStats) => void,
  onSmoke?: (report: SmokeReport) => void,
): Promise<() => void> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  const backend: Backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const adapter = await describeAdapter(renderer, backend);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 0.5, 0);

  scene.add(new THREE.HemisphereLight(0xdde3ff, 0x202024, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 10, 4);
  scene.add(sun);
  scene.add(new THREE.GridHelper(40, 40, 0x5a5a66, 0x2a2a32));
  const block = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.6 }),
  );
  block.position.y = 0.5;
  scene.add(block);

  const resize = (): void => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const start = performance.now();
  let frames = 0;
  let windowFrames = 0;
  let windowStart = start;
  let reported = false;

  await renderer.setAnimationLoop((time: number) => {
    block.rotation.y = time / 1000;
    renderer.render(scene, camera);
    frames += 1;
    windowFrames += 1;
    const now = performance.now();
    if (now - windowStart >= 500) {
      onStats({ backend, fps: (windowFrames * 1000) / (now - windowStart), ...(adapter ? { adapter } : {}) });
      windowFrames = 0;
      windowStart = now;
    }
    if (onSmoke && !reported && now - start >= SMOKE_AFTER_MS) {
      reported = true;
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
  });

  return () => {
    void renderer.setAnimationLoop(null);
    window.removeEventListener('resize', resize);
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
