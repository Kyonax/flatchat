// SPDX-License-Identifier: MPL-2.0
// The crowd bench with real converted avatars (S4.05's "the S0.09 benchmark repeated with real
// avatars", S4.12's frame-rate lines): --crowd=SECONDS --crowd-converted=1 --avatars=DIR, where
// DIR holds the converter's output, one folder per avatar (its manifest.json and its levels as
// <sha256>.vrm; tools/bots/src/avatar-bench.ts makes it). The world's own avatar layer draws them,
// exactly as in a world: levels by distance and the viewer's policy, impostors shared, the shared
// walk, spring bones on the nearest. `present` players stand around the camera, `inView` of them in
// a wedge in front of it (the plan's 55 in view, 200 present); after every wanted level has loaded,
// the measured run keeps every frame time, at 1280×720 with no frame-rate cap.
import type { AvatarManifest, Level } from '@flatchat/content';
import * as THREE from 'three/webgpu';
import { summarizeFrames } from '../frame-stats';
import { AvatarLayer, type AvatarState } from '../world/avatar-layer';

export interface ConvertedOptions {
  seconds: number;
  width: number;
  height: number;
  present: number;
  inView: number;
  full: number;
  lower: number;
  springs: number;
  onProgress: (line: string) => void;
}

const BASE = 'flatchat-avatar://bench/';
const WARMUP_MS = 5000;
const LOAD_LIMIT_MS = 180_000;

export async function runConvertedCrowd(canvas: HTMLCanvasElement, o: ConvertedOptions): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { mode: 'converted', width: o.width, height: o.height, config: { ...o, onProgress: undefined } };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  try {
    await renderer.init();
    report['backend'] = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    renderer.setPixelRatio(1);
    renderer.setSize(o.width, o.height, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa7bfd6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6b5a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 10, 6);
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0x9a948a }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const camera = new THREE.PerspectiveCamera(60, o.width / o.height, 0.1, 400);
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.2, -10);

    // The converted avatars: each folder with a manifest.json.
    const index = (await (await fetch(`${BASE}index.json`)).json()) as Array<{ name: string }>;
    const folders = [...new Set(index.filter((f) => f.name.endsWith('/manifest.json')).map((f) => f.name.split('/')[0]!))];
    if (folders.length === 0) throw new Error('no converted avatars in the folder (make them with tools/bots/src/avatar-bench.ts)');
    const manifests = new Map<string, AvatarManifest>();
    for (const f of folders) manifests.set(f, (await (await fetch(`${BASE}${f}/manifest.json`)).json()) as AvatarManifest);
    report['avatars'] = folders.length;
    const layer = new AvatarLayer(renderer, async (folder: string, level: Level) => {
      const m = manifests.get(folder)!;
      const r = await fetch(`${BASE}${folder}/${m.levels[level].file}.vrm`);
      if (!r.ok) throw new Error(`${folder} ${level}: ${r.status}`);
      return { bytes: await r.arrayBuffer(), manifest: m };
    });
    layer.policy = { full: o.full, lower: o.lower, springs: o.springs, minRank: 'veryPoor' };
    scene.add(layer.group);

    // Where everyone stands: `inView` in a wedge in front of the camera, the rest all around. The
    // first `full` of them within the 8 m the layer draws in full, so the run is the worst the
    // policy allows: its whole full quota at LOD0, its lower quota at LOD1 and LOD2, impostors after.
    let seed = 20_261_017;
    const random = (): number => ((seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) / 0xffffffff);
    const people = Array.from({ length: o.present }, (_, i) => {
      const inView = i < o.inView;
      const near = i < Math.min(o.full, o.inView);
      const angle = inView ? -Math.PI / 2 + (random() - 0.5) * (Math.PI / 3) : random() * Math.PI * 2;
      const d = near ? 3 + random() * 3.5 : inView ? 9 + Math.pow(random(), 0.8) * 25 : 12 + random() * 50;
      const walks = i % 3 !== 0;
      const r = walks ? (near ? 0.5 + random() * 0.5 : 1 + random() * 2) : 0;
      return { entity: i + 1, folder: folders[i % folders.length]!, cx: Math.cos(angle) * d, cz: Math.sin(angle) * d, r, phase: random() * Math.PI * 2 };
    });
    for (const p of people) layer.wear(p.entity, p.folder);
    const neutral = { expression: 'neutral' as const, left: 'relaxed' as const, right: 'relaxed' as const };
    const states = (t: number): AvatarState[] =>
      people.map((p) => {
        const a = p.phase + t * (p.r > 0 ? 1.2 / p.r : 0);
        return {
          entity: p.entity,
          manifest: p.folder,
          x: p.cx + Math.cos(a) * p.r,
          y: 0,
          z: p.cz + Math.sin(a) * p.r,
          yaw: p.r > 0 ? -a : 0,
          stance: 'standing',
          face: neutral,
          mouth: undefined,
          hidden: false,
          height: manifests.get(p.folder)?.height ?? 1.7,
          me: false,
        };
      });

    // Load, warm up, measure.
    const frames: number[] = [];
    const started = performance.now();
    let last = started;
    let loadedAt = 0;
    let measuring = false;
    let measureFrom = 0;
    await new Promise<void>((resolve) => {
      void renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        layer.update(states((now - started) / 1000), camera, dt, now);
        renderer.render(scene, camera);
        const c = layer.counts();
        const loaded = c.lod0 + c.lod1 + c.lod2 + c.impostor;
        if (!loadedAt && (loaded >= o.present || now - started > LOAD_LIMIT_MS)) {
          loadedAt = now;
          report['loadMs'] = Math.round(now - started);
          o.onProgress(`Converted crowd: ${loaded} of ${o.present} drawn after ${Math.round((now - started) / 1000)} s; warming up`);
        }
        if (loadedAt && !measuring && now - loadedAt > WARMUP_MS) {
          measuring = true;
          measureFrom = now;
        } else if (measuring) {
          frames.push(dt * 1000);
          if (now - measureFrom >= o.seconds * 1000) {
            void renderer.setAnimationLoop(null);
            resolve();
          }
        } else if (!loadedAt) o.onProgress(`Converted crowd: loading ${loaded} of ${o.present} ${JSON.stringify(layer.status())}`);
      });
    });
    const counts = layer.counts();
    report['summary'] = summarizeFrames(frames);
    report['framesOver50'] = frames.filter((f) => f > 50).length;
    report['framesOver100'] = frames.filter((f) => f > 100).length;
    report['tiers'] = { full: { count: counts.lod0 }, lod: { count: counts.lod1 + counts.lod2 }, proxy: { count: counts.impostor } };
    report['levels'] = counts;
    report['render'] = { drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
    report['failures'] = layer.failures;
    report['status'] = layer.status();
    report['jsHeapMB'] = Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576);
    layer.dispose();
  } catch (err) {
    report['error'] = err instanceof Error ? err.message : String(err);
  }
  return report;
}
