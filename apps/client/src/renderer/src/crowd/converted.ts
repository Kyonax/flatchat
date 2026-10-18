// SPDX-License-Identifier: MPL-2.0
// The crowd bench with real converted avatars (S4.05's "the S0.09 benchmark repeated with real
// avatars", S4.12's frame-rate lines): --crowd=SECONDS --crowd-converted=1 --avatars=DIR, where
// DIR holds the converter's output, one folder per avatar (its manifest.json and its levels as
// <sha256>.vrm; tools/bots/src/avatar-bench.ts makes it). The world's own avatar layer draws them,
// exactly as in a world: levels by distance and the viewer's policy, impostors shared, the shared
// walk, spring bones on the nearest. `present` players stand around the camera, `inView` of them in
// a wedge in front of it (the plan's 55 in view, 200 present); after every wanted level has loaded,
// the measured run keeps every frame time, at 1280×720 with no frame-rate cap.
import { type AvatarManifest, type Level, rankIndex } from '@flatchat/content';
import * as THREE from 'three/webgpu';
import { summarizeFrames } from '../frame-stats';
import { AvatarLayer, type AvatarState } from '../world/avatar-layer';
import { TIER_POLICY } from '../world/avatar-policy';

export interface ConvertedOptions {
  seconds: number;
  width: number;
  height: number;
  present: number;
  inView: number;
  full: number;
  lower: number;
  springs: number;
  /** A tier's policy as it ships, in place of full, lower and springs with every rank in full. */
  tier?: keyof typeof TIER_POLICY;
  /** S4.10's look check: everyone at the ends of the proportion sliders, in every combination. */
  proportions?: boolean;
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
    const policy = o.tier ? { ...TIER_POLICY[o.tier] } : { full: o.full, lower: o.lower, springs: o.springs, minRank: 'veryPoor' as const };
    layer.policy = policy;
    report['policy'] = { tier: o.tier ?? null, ...policy };
    scene.add(layer.group);

    // Where everyone stands, the worst the policy allows: `inView` in a wedge in front of the camera,
    // the rest around it but out of its view (beyond 75° either side: the camera sees 46°, the walks
    // and bodies need the rest). Nearest, within the 8 m the layer draws in full, the policy's full
    // quota, the heaviest avatars (by LOD0 triangles) it draws in full (every rank without a tier; a
    // tier's lowest rank and better with one); then its lower quota within 9 to 13 m, the heaviest
    // of all (LOD1 has no rank gate); the rest of those in view farther off, as impostors.
    const fullOk = (f: string): boolean => rankIndex(manifests.get(f)!.rank) <= rankIndex(policy.minRank);
    const byWeight = (a: string, b: string): number => manifests.get(b)!.levels.lod0.triangles - manifests.get(a)!.levels.lod0.triangles;
    const heaviest = [...folders].sort(byWeight);
    const heaviestFull = heaviest.filter(fullOk);
    const nearCount = Math.min(policy.full, o.inView);
    const lowerCount = Math.min(policy.lower, o.inView - nearCount);
    let seed = 20_261_017;
    const random = (): number => ((seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) / 0xffffffff);
    const people = Array.from({ length: o.present }, (_, i) => {
      const inView = i < o.inView;
      const near = i < nearCount;
      const lower = !near && i < nearCount + lowerCount;
      const angle = inView ? -Math.PI / 2 + (random() - 0.5) * (Math.PI / 3) : -Math.PI / 2 + (Math.PI * 5) / 12 + random() * ((Math.PI * 7) / 6);
      const d = near ? 3 + random() * 3.5 : lower ? 9 + random() * 4 : inView ? 21 + random() * 13 : 12 + random() * 50;
      const walks = i % 3 !== 0;
      const r = walks ? (near ? 0.5 + random() * 0.5 : 1 + random() * 2) : 0;
      const folder = near && heaviestFull.length > 0 ? heaviestFull[i % heaviestFull.length]! : heaviest[(near ? i : i - nearCount) % heaviest.length]!;
      return { entity: i + 1, folder, cx: Math.cos(angle) * d, cz: Math.sin(angle) * d, r, phase: random() * Math.PI * 2 };
    });
    for (const p of people) layer.wear(p.entity, p.folder);
    if (o.proportions) {
      const end = (bit: number): number => (bit ? 125 : 80);
      people.forEach((p, i) => layer.reshape(p.entity, { width: end(i & 1), arms: end(i & 2), legs: end(i & 4), head: end(i & 8) }));
    }
    // The pass line's count in full: the near ones the policy draws in full.
    report['fullExpected'] = people.slice(0, Math.min(policy.full, o.inView)).filter((p) => fullOk(p.folder)).length;
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
    const updateMs: number[] = [];
    const renderMs: number[] = [];
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
        const u0 = performance.now();
        layer.update(states((now - started) / 1000), camera, dt, now);
        const u1 = performance.now();
        renderer.render(scene, camera);
        const u2 = performance.now();
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
          // --crowd-shot: a picture of the crowd a second into the measured run.
          setTimeout(() => void window.flatchat?.crowdShot(), 1000);
        } else if (measuring) {
          frames.push(dt * 1000);
          updateMs.push(u1 - u0);
          renderMs.push(u2 - u1);
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
    // The main thread's share of a frame: the avatar layer's update, and the render call (its CPU side).
    const median = (a: number[]): number => Math.round(([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0) * 100) / 100;
    report['cpuMs'] = { update: median(updateMs), render: median(renderMs) };
    report['inView'] = layer.inView;
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
