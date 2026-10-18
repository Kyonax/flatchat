// SPDX-License-Identifier: MPL-2.0
// The look check (S6.03, S6.04): each avatar in the bench folder (tools/bots/src/look-check.ts
// makes it: the converter's output and the uploaded file beside it) drawn on this GPU, then checked.
//   - The default materials (S6.04, Q-E4): the converted full level through the world's own loader
//     (three-vrm's MToon port as node materials, three's built-in materials for the rest) against
//     the uploaded file in a VRM viewer's pipeline (three-vrm's own MToon on three's classic WebGL
//     renderer, as three-vrm's viewer draws it), the same camera and lights. The pictures must
//     match within a tolerance.
//   - Creator shaders (S6.03): an avatar with one drawn with its fallback, then with its shader made
//     for this GPU (a few moments apart, since it pulses): it builds, it draws, it changes the
//     picture.
// Run with --crowd=SECONDS --avatars=DIR --crowd-converted=1 --crowd-look=1; the report goes where
// the crowd's goes, with `error` set when a check fails.
import type { AvatarManifest } from '@flatchat/content';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import * as CLASSIC from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three/webgpu';
import { type MaterialShader, parseLevel } from '../world/avatar-loader';
import { compileCreatorShader } from '../world/creator-shader';

const BASE = 'flatchat-avatar://bench/';
const SIZE = 256;
/** A pixel differs when a channel is off by more than this (of 255). */
const PIXEL_TOLERANCE = 24;
/** The VRM viewer's picture and ours may differ in this share of their pixels at most. */
export const LOOK_TOLERANCE = 0.04;
/** A creator shader must change at least this share of the picture: a fresnel rim glows only at
 *  grazing angles, about 1 % of the boxy reference avatar seen from the front; a shader that did not
 *  draw changes none. */
const SHADER_VISIBLE = 0.002;

/** The share of pixels that differ, and the mean difference, of two RGBA pictures; `flip` reads the
 *  second one bottom row first (WebGL reads rows the other way round). */
function compare(a: Uint8Array, b: Uint8Array, flip: boolean): { differing: number; mean: number } {
  let differing = 0;
  let sum = 0;
  for (let y = 0; y < SIZE; y++) {
    const by = flip ? SIZE - 1 - y : y;
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const j = (by * SIZE + x) * 4;
      const d = Math.max(Math.abs(a[i]! - b[j]!), Math.abs(a[i + 1]! - b[j + 1]!), Math.abs(a[i + 2]! - b[j + 2]!));
      if (d > PIXEL_TOLERANCE) differing += 1;
      sum += d;
    }
  }
  return { differing: differing / (SIZE * SIZE), mean: sum / (SIZE * SIZE) / 255 };
}

/** The share of a picture that is not its background (its corner pixel: the render targets hold
 *  linear colour, so the background is not the sRGB value it was set to): an avatar fills a fifth
 *  or so; a picture with almost none drew nothing worth comparing. */
const MIN_COVERAGE = 0.02;
function coverage(p: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const d = Math.max(Math.abs(p[i * 4]! - p[0]!), Math.abs(p[i * 4 + 1]! - p[1]!), Math.abs(p[i * 4 + 2]! - p[2]!));
    if (d > PIXEL_TOLERANCE) n += 1;
  }
  return n / (SIZE * SIZE);
}

/** The same lights in both pipelines: a sky over a ground, and a sun from the front right. */
function lightUp(scene: { add(o: unknown): unknown }, three: typeof CLASSIC | typeof THREE): void {
  scene.add(new three.HemisphereLight(0xffffff, 0x6b6b5a, 2));
  const sun = new three.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 4, 6);
  scene.add(sun);
}

export async function runLookCheck(canvas: HTMLCanvasElement, onProgress: (line: string) => void): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { mode: 'look', size: SIZE, tolerance: LOOK_TOLERANCE };
  const failures: string[] = [];
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  const viewerCanvas = document.createElement('canvas');
  const viewer = new CLASSIC.WebGLRenderer({ canvas: viewerCanvas, antialias: false, preserveDrawingBuffer: true });
  try {
    await renderer.init();
    report['backend'] = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    renderer.setSize(SIZE, SIZE, false);
    viewer.setSize(SIZE, SIZE, false);
    const ours = new THREE.RenderTarget(SIZE, SIZE);
    const theirs = new CLASSIC.WebGLRenderTarget(SIZE, SIZE);
    const index = (await (await fetch(`${BASE}index.json`)).json()) as Array<{ name: string }>;
    const folders = [...new Set(index.filter((f) => f.name.endsWith('/manifest.json')).map((f) => f.name.split('/')[0]!))].sort();
    const avatars: Array<Record<string, unknown>> = [];
    for (const folder of folders) {
      onProgress(`Looking at ${folder}…`);
      const row: Record<string, unknown> = { folder };
      avatars.push(row);
      try {
        const m = (await (await fetch(`${BASE}${folder}/manifest.json`)).json()) as AvatarManifest;
        const level = await (await fetch(`${BASE}${folder}/${m.levels.lod0.file}.vrm`)).arrayBuffer();
        const parsed = await parseLevel(renderer, level);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x7f8c99);
        lightUp(scene, THREE);
        scene.add(parsed.vrm.scene);
        // The camera from the converted avatar's size, in front of it (it faces +Z).
        const box = new THREE.Box3().setFromObject(parsed.vrm.scene);
        const centre = box.getCenter(new THREE.Vector3());
        const height = Math.max(0.5, box.max.y - box.min.y);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
        camera.position.set(centre.x, centre.y, centre.z + height * 2.1);
        camera.lookAt(centre);
        const draw = async (): Promise<Uint8Array> => {
          renderer.setRenderTarget(ours);
          await renderer.renderAsync(scene, camera);
          renderer.setRenderTarget(null);
          return new Uint8Array(await renderer.readRenderTargetPixelsAsync(ours, 0, 0, SIZE, SIZE));
        };
        const ourPicture = await draw();
        row['coverage'] = Number(coverage(ourPicture).toFixed(4));
        if ((row['coverage'] as number) < MIN_COVERAGE) failures.push(`${folder}: the world's pipeline drew ${((row['coverage'] as number) * 100).toFixed(2)} % of the picture: no avatar in it`);

        // The uploaded file in a VRM viewer's pipeline, both ways round (the converter may have
        // turned it to face +Z), and the closer of the two.
        const source = await fetch(`${BASE}${folder}/source.vrm`);
        if (source.ok) {
          const loader = new GLTFLoader();
          loader.register((parser) => new VRMLoaderPlugin(parser));
          const gltf = await loader.parseAsync(await source.arrayBuffer(), '');
          const vrm = gltf.userData['vrm'] as Parameters<typeof VRMUtils.rotateVRM0>[0] | undefined;
          const model = (vrm?.scene ?? gltf.scene) as unknown as CLASSIC.Object3D;
          if (vrm) VRMUtils.rotateVRM0(vrm);
          const viewScene = new CLASSIC.Scene();
          viewScene.background = new CLASSIC.Color(0x7f8c99);
          lightUp(viewScene, CLASSIC);
          viewScene.add(model);
          const viewCamera = new CLASSIC.PerspectiveCamera(30, 1, 0.05, 50);
          viewCamera.position.set(camera.position.x, camera.position.y, camera.position.z);
          viewCamera.lookAt(centre.x, centre.y, centre.z);
          let best = { differing: 1, mean: 1, turned: false, flipped: false, coverage: 0 };
          for (const turned of [false, true]) {
            model.rotation.y = turned ? Math.PI : 0;
            model.updateMatrixWorld(true);
            viewer.setRenderTarget(theirs);
            viewer.render(viewScene, viewCamera);
            const theirPicture = new Uint8Array(SIZE * SIZE * 4);
            viewer.readRenderTargetPixels(theirs, 0, 0, SIZE, SIZE, theirPicture);
            viewer.setRenderTarget(null);
            const theirCoverage = coverage(theirPicture);
            for (const flipped of [false, true]) {
              const c = compare(ourPicture, theirPicture, flipped);
              if (c.differing < best.differing) best = { ...c, turned, flipped, coverage: theirCoverage };
            }
          }
          row['materials'] = { differing: Number(best.differing.toFixed(4)), mean: Number(best.mean.toFixed(4)), turned: best.turned, flipped: best.flipped, viewerCoverage: Number(best.coverage.toFixed(4)) };
          if (best.coverage < MIN_COVERAGE) failures.push(`${folder}: the VRM viewer's pipeline drew ${(best.coverage * 100).toFixed(2)} % of the picture: no avatar in it`);
          if (best.differing > LOOK_TOLERANCE) failures.push(`${folder}: ${(best.differing * 100).toFixed(1)} % of the picture differs from a VRM viewer's (${LOOK_TOLERANCE * 100} % at most)`);
          VRMUtils.deepDispose(model as unknown as Parameters<typeof VRMUtils.deepDispose>[0]);
        }

        // Creator shaders: the fallback's picture, then the shader's at a few moments.
        const shaded: Array<{ mesh: THREE.Mesh; fallback: THREE.Material; shader: MaterialShader }> = [];
        parsed.vrm.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          const shader = mesh.isMesh && !Array.isArray(mesh.material) ? (mesh.material.userData['flatchatShader'] as MaterialShader | undefined) : undefined;
          if (shader) shaded.push({ mesh, fallback: mesh.material as THREE.Material, shader });
        });
        if ((m.shaders ?? 0) > 0) {
          if (shaded.length === 0) failures.push(`${folder}: the manifest lists ${m.shaders} creator shaders and the loader found none`);
          for (const s of shaded) s.mesh.material = compileCreatorShader(s.shader.graph, s.shader.textures, s.fallback);
          let changed = 0;
          for (let k = 0; k < 4; k++) {
            await new Promise((r) => setTimeout(r, 300));
            changed = Math.max(changed, compare(ourPicture, await draw(), false).differing);
          }
          row['shader'] = { materials: shaded.length, changed: Number(changed.toFixed(4)) };
          if (changed < SHADER_VISIBLE) failures.push(`${folder}: its creator shader changed ${(changed * 100).toFixed(2)} % of the picture (at least ${SHADER_VISIBLE * 100} %)`);
          for (const s of shaded) {
            (s.mesh.material as THREE.Material).dispose();
            s.mesh.material = s.fallback;
          }
        }
        VRMUtils.deepDispose(parsed.vrm.scene);
      } catch (err) {
        failures.push(`${folder}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
    report['avatars'] = avatars;
    if (avatars.length === 0) failures.push('no avatars in the folder');
  } catch (err) {
    failures.push(err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    viewer.dispose();
    renderer.dispose();
  }
  if (failures.length) report['error'] = failures.join('; ');
  return report;
}
