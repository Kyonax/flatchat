// SPDX-License-Identifier: MPL-2.0
// A GPU reset (S6.03, T-01): the driver lost the device, after a hang, a crash or a shader too
// heavy for it. Windows bug-checks the machine after five GPU hangs within a minute (rr-008), so
// after one every creator shader stays off for the rest of the session (until the client restarts),
// and the world view joins again with a fresh renderer. Kept here, outside any one world's session,
// so the next session knows.
import type * as THREE from 'three/webgpu';

export const gpuResets = { count: 0 };

/** Watches a renderer's device and calls `lost` once if the driver loses it; the returned function
 *  stops watching (before the renderer is disposed on purpose, which also ends the device). */
export function watchGpu(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement, lost: () => void): () => void {
  let watching = true;
  const fire = (): void => {
    if (!watching) return;
    watching = false;
    gpuResets.count += 1;
    lost();
  };
  // three tells the renderer through `onDeviceLost`, whose default logs an error and stops drawing:
  // this one stops drawing too, and the view recovers, so nothing is logged.
  const r = renderer as unknown as { onDeviceLost: (info: unknown) => void; _isDeviceLost?: boolean };
  r.onDeviceLost = () => {
    r._isDeviceLost = true;
    fire();
  };
  const device = (renderer.backend as { device?: GPUDevice }).device;
  void device?.lost.then(fire);
  const onLost = (e: Event): void => {
    e.preventDefault();
    fire();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  return () => {
    watching = false;
    canvas.removeEventListener('webglcontextlost', onLost);
  };
}

/** For the end-to-end test only: lose the device as a driver reset would. */
export function loseGpu(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as { device?: GPUDevice; gl?: WebGL2RenderingContext };
  if (backend.device) backend.device.destroy();
  else backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
}
