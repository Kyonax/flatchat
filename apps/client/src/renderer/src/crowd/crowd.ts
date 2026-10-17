// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's crowd bench (--crowd=SECONDS): avatars on three.js's WebGPU renderer at a fixed
// 1280×720 on the "low" preset (no antialiasing, no shadows, no outlines), with no frame-rate cap,
// so every frame time is the work. The nearest avatars are drawn in full (spring bones on the
// nearest six, mouths moving while they talk), the next ring at a lower level of detail animated at
// 15 Hz, the rest as proxies animated at 5 Hz (layout.ts). After loading, a warm-up, then the
// measured run: every frame time is kept, and every few seconds one full avatar is replaced by a
// freshly loaded one, so the frames during a load count as well. A swap paces its work as a game
// must: load and parse, fit the textures (off the main thread), upload one texture a frame,
// compile the pipelines, then show it; each frame records which of those steps was under way. The avatars come from the folder
// the command line names, through the read-only flatchat-avatar:// protocol (src/main/avatar-files.ts).
import { type VRM, VRMUtils } from '@pixiv/three-vrm';
import * as THREE from 'three/webgpu';
import { type FrameSummary, percentile, summarizeFrames } from '../frame-stats';
import { type AvatarFacts, avatarFacts, buildProxy, fitTextures, loadAvatar, mergeAvatar, poseAvatar, Proxy, type ProxyTemplate, simplifyAvatar, texturesOf } from './avatar';
import { crowdLayout, type Placement, positionAt, seeded } from './layout';
import { walkPose } from './walk';

export interface CrowdOptions {
  seconds: number;
  width: number;
  height: number;
  full: number;
  lod: number;
  /** Everyone in the world; the rest after the full and lower-detail ones are proxies. */
  present: number;
  springs: number;
  /** Seconds between avatar swaps while measuring; 0 never swaps. */
  swapSeconds: number;
  /** A full avatar's texture budget, MB of RGBA with mipmaps (a quarter at the lower detail); 0 keeps them. */
  textureMB: number;
  /** The lower detail's share of the triangles. */
  lodRatio: number;
  /** Merge each avatar's materials into at most three (the converter's job), or draw them as exported. */
  merge: boolean;
  onProgress: (line: string) => void;
}

interface TierFacts {
  count: number;
  triangles: number;
  materials: number;
  textureMB: number;
}

/** What a frame was doing for a swap. */
export type SwapPhase = 'none' | 'load' | 'fit' | 'upload' | 'compile' | 'show' | 'settle';

export interface CrowdLoad {
  file: string;
  /** From the measurement's start. */
  atMs: number;
  /** Wall time of each step, and the slowest single texture upload. */
  loadMs: number;
  fitMs: number;
  uploadMs: number;
  slowestUploadMs: number;
  compileMs: number;
  textures: number;
}

export interface CrowdReport {
  backend: 'WebGPU' | 'WebGL2' | 'none';
  adapter?: string;
  error?: string;
  width: number;
  height: number;
  config: Omit<CrowdOptions, 'onProgress' | 'width' | 'height'> & { proxies: number; warmupSeconds: number };
  files: number;
  tiers: { full: TierFacts; lod: TierFacts; proxy: TierFacts };
  render: { drawCalls: number; triangles: number };
  loadMs: { initial: number; perAvatar: number; slowest: number };
  summary: FrameSummary;
  framesOver50: number;
  framesOver100: number;
  /** Frames from a swap's start until a second after its avatar appeared. */
  duringLoads: { frames: number; p95Ms: number; maxMs: number };
  /** Per swap step: frames, the slowest, and how many took over 100 ms. */
  byPhase: Record<SwapPhase, { frames: number; maxMs: number; over100: number }>;
  outsideLoads: { maxMs: number };
  /** Main-thread time per measured frame: updating the avatars (poses, springs, mouths) and the render call itself. */
  cpuMs: { updateP50: number; updateP95: number; renderP50: number; renderP95: number };
  /** GPU time of one frame in every 15, from WebGPU timestamp queries (three returns the last frame's); null where the adapter has none. */
  gpuMs: { p50: number; p95: number; samples: number } | null;
  loads: CrowdLoad[];
  jsHeapMB: number;
}

const WARMUP_MS = 5000;
const AFTER_LOAD_MS = 1000;
const SCHEME = 'flatchat-avatar://bench/';

interface Member {
  holder: THREE.Group;
  vrm: VRM;
  placement: Placement;
  tier: 'full' | 'lod';
  springs: boolean;
  next: number;
  facts: AvatarFacts;
  /** Seconds into the talk pattern; full avatars talk about a quarter of the time. */
  voice: number;
}

interface ProxyMember {
  proxy: Proxy;
  placement: Placement;
  next: number;
}

function colorFor(name: string): THREE.Color {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.35, 0.55);
}

function tierFacts(members: readonly { facts: AvatarFacts }[]): TierFacts {
  return {
    count: members.length,
    triangles: members.reduce((s, m) => s + m.facts.triangles, 0),
    materials: members.reduce((s, m) => s + m.facts.materials, 0),
    textureMB: Math.round(members.reduce((s, m) => s + m.facts.textureBytes, 0) / 1e5) / 10,
  };
}

/** Talks in bursts: 1.5 to 6 s, then silence, about a quarter of the time (as the bots do). */
function mouthAt(t: number, offset: number): number {
  const cycle = 16;
  const at = (t + offset) % cycle;
  if (at > 4) return 0;
  return 0.5 + 0.5 * Math.sin(t * 17 + offset);
}

export async function runCrowd(canvas: HTMLCanvasElement, o: CrowdOptions): Promise<CrowdReport> {
  const proxies = Math.max(0, o.present - o.full - o.lod);
  const report: CrowdReport = {
    backend: 'none',
    width: o.width,
    height: o.height,
    config: { seconds: o.seconds, full: o.full, lod: o.lod, present: o.present, proxies, springs: o.springs, swapSeconds: o.swapSeconds, textureMB: o.textureMB, lodRatio: o.lodRatio, merge: o.merge, warmupSeconds: WARMUP_MS / 1000 },
    files: 0,
    tiers: { full: tierFacts([]), lod: tierFacts([]), proxy: { count: 0, triangles: 0, materials: 0, textureMB: 0 } },
    render: { drawCalls: 0, triangles: 0 },
    loadMs: { initial: 0, perAvatar: 0, slowest: 0 },
    summary: summarizeFrames([]),
    framesOver50: 0,
    framesOver100: 0,
    duringLoads: { frames: 0, p95Ms: 0, maxMs: 0 },
    byPhase: Object.fromEntries((['none', 'load', 'fit', 'upload', 'compile', 'show', 'settle'] as const).map((k) => [k, { frames: 0, maxMs: 0, over100: 0 }])) as CrowdReport['byPhase'],
    outsideLoads: { maxMs: 0 },
    cpuMs: { updateP50: 0, updateP95: 0, renderP50: 0, renderP95: 0 },
    gpuMs: null,
    loads: [],
    jsHeapMB: 0,
  };
  // Timestamp queries give the GPU's own time, so a run on a strong card can say how much of a weak one's budget it would use.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', trackTimestamp: true });
  try {
    await renderer.init();
    report.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    if (report.backend === 'WebGPU') {
      const info = (await navigator.gpu?.requestAdapter())?.info;
      if (info) report.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
    }
    renderer.setPixelRatio(1);
    renderer.setSize(o.width, o.height, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101014);
    scene.add(new THREE.HemisphereLight(0xdde3ff, 0x202024, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 4);
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshLambertNodeMaterial({ color: 0x2a2a32 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const camera = new THREE.PerspectiveCamera(60, o.width / o.height, 0.1, 300);
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.2, 10);

    const files = (await (await fetch(`${SCHEME}index.json`)).json()) as Array<{ name: string; bytes: number }>;
    if (files.length === 0) throw new Error('the avatar folder has no .vrm files');
    report.files = files.length;
    let nextFile = 0;
    const pickFile = (): string => files[nextFile++ % files.length]!.name;
    const templates = new Map<string, ProxyTemplate>();

    const budget = (tier: 'full' | 'lod'): number => (o.textureMB * 1e6) / (tier === 'full' ? 1 : 4);
    const prepare = async (name: string, tier: 'full' | 'lod'): Promise<{ vrm: VRM; facts: AvatarFacts; ms: number }> => {
      const t0 = performance.now();
      const vrm = await loadAvatar(SCHEME + encodeURIComponent(name));
      if (!templates.has(name)) templates.set(name, await buildProxy(vrm, colorFor(name)));
      if (o.merge) await mergeAvatar(vrm, tier === 'full' ? 1024 : 512);
      await fitTextures(vrm.scene, budget(tier));
      if (tier === 'lod') await simplifyAvatar(vrm, o.lodRatio);
      return { vrm, facts: avatarFacts(vrm), ms: performance.now() - t0 };
    };

    // Load everyone drawn in full or at the lower detail, three at a time.
    const layout = crowdLayout({ full: o.full, lod: o.lod, proxies }, 1);
    const drawn = layout.filter((p) => p.tier !== 'proxy');
    const members: Member[] = [];
    const loadTimes: number[] = [];
    const t0 = performance.now();
    let done = 0;
    const queue = drawn.map((placement, i) => ({ placement, i, name: pickFile() }));
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const tier = job.placement.tier === 'full' ? 'full' : 'lod';
          const { vrm, facts, ms } = await prepare(job.name, tier);
          loadTimes.push(ms);
          const holder = new THREE.Group();
          holder.add(vrm.scene);
          members[job.i] = { holder, vrm, placement: job.placement, tier, springs: false, next: 0, facts, voice: job.i * 3.7 };
          done += 1;
          o.onProgress(`Loading avatars: ${done} of ${drawn.length}`);
        }
      }),
    );
    for (const m of members) scene.add(m.holder);
    // Spring bones on the nearest full avatars.
    const near = (m: Member): number => Math.hypot(m.placement.x, m.placement.z);
    members
      .filter((m) => m.tier === 'full')
      .sort((a, b) => near(a) - near(b))
      .slice(0, o.springs)
      .forEach((m) => {
        m.springs = true;
      });
    report.loadMs = {
      initial: Math.round(performance.now() - t0),
      perAvatar: Math.round(loadTimes.reduce((a, b) => a + b, 0) / Math.max(1, loadTimes.length)),
      slowest: Math.round(loadTimes.reduce((a, b) => Math.max(a, b), 0)),
    };

    // The proxies share their avatar's mesh and material.
    const proxyMembers: ProxyMember[] = [];
    const templateList = [...templates.values()];
    if (templateList.length > 0) {
      layout
        .filter((p) => p.tier === 'proxy')
        .forEach((placement, i) => {
          const proxy = new Proxy(templateList[i % templateList.length]!);
          scene.add(proxy.object);
          proxyMembers.push({ proxy, placement, next: 0 });
        });
    }
    report.tiers = {
      full: tierFacts(members.filter((m) => m.tier === 'full')),
      lod: tierFacts(members.filter((m) => m.tier === 'lod')),
      proxy: { count: proxyMembers.length, triangles: proxyMembers.reduce((s, p) => s + p.proxy.triangles, 0), materials: proxyMembers.length, textureMB: 0 },
    };
    o.onProgress('Compiling…');
    await renderer.compileAsync(scene, camera);

    // The loop: warm up, then measure; swap a full avatar every few seconds.
    const start = performance.now();
    let last = start;
    let measureStart = 0;
    const frames: number[] = [];
    const flags: boolean[] = [];
    const windows: Array<[number, number]> = [];
    let swapping = false;
    let nextSwap = 0;
    let swapIndex = 0;
    const fullMembers = members.filter((m) => m.tier === 'full');
    const random = seeded(9);

    // Work a swap spreads over frames: one waiter released, and one texture uploaded, each frame.
    const waiters: Array<() => void> = [];
    const nextFrame = (): Promise<void> => new Promise<void>((resolve) => waiters.push(resolve));
    const uploads: Array<{ texture: THREE.Texture; done: (ms: number) => void }> = [];
    let phase: SwapPhase = 'none';
    let settleUntil = 0;
    const uploadAll = (textures: THREE.Texture[]): Promise<number[]> =>
      Promise.all(textures.map((texture) => new Promise<number>((done) => uploads.push({ texture, done }))));

    const swap = async (now: number): Promise<void> => {
      if (fullMembers.length === 0) return;
      swapping = true;
      const name = pickFile();
      const began = now;
      const window: [number, number] = [began, Number.POSITIVE_INFINITY];
      windows.push(window);
      phase = 'load';
      const t0 = performance.now();
      const vrm = await loadAvatar(SCHEME + encodeURIComponent(name));
      if (!templates.has(name)) templates.set(name, await buildProxy(vrm, colorFor(name)));
      const t1 = performance.now();
      phase = 'fit';
      if (o.merge) await mergeAvatar(vrm, 1024, nextFrame);
      await fitTextures(vrm.scene, budget('full'), nextFrame);
      const t2 = performance.now();
      phase = 'upload';
      const textures = [...texturesOf(vrm.scene)];
      const uploadTimes = await uploadAll(textures);
      const t3 = performance.now();
      phase = 'compile';
      const target = fullMembers[fullMembers.length - 1 - (swapIndex++ % fullMembers.length)]!;
      const holder = new THREE.Group();
      holder.add(vrm.scene);
      holder.position.copy(target.holder.position);
      holder.rotation.copy(target.holder.rotation);
      await renderer.compileAsync(holder, camera, scene);
      const t4 = performance.now();
      // Each mesh's first draw still costs three.js tens of milliseconds, so the meshes appear one a frame.
      phase = 'show';
      const parts: THREE.Object3D[] = [];
      holder.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.visible = false;
          parts.push(o);
        }
      });
      scene.add(holder);
      for (const part of parts) {
        await nextFrame();
        part.visible = true;
      }
      await nextFrame();
      scene.remove(target.holder);
      VRMUtils.deepDispose(target.vrm.scene);
      Object.assign(target, { holder, vrm, facts: avatarFacts(vrm) });
      phase = 'settle';
      settleUntil = t4 + AFTER_LOAD_MS;
      window[1] = settleUntil;
      report.loads.push({
        file: name,
        atMs: Math.round(began - measureStart),
        loadMs: Math.round(t1 - t0),
        fitMs: Math.round(t2 - t1),
        uploadMs: Math.round(t3 - t2),
        slowestUploadMs: Math.round(uploadTimes.reduce((a, b) => Math.max(a, b), 0) * 100) / 100,
        compileMs: Math.round(t4 - t3),
        textures: textures.length,
      });
      swapping = false;
    };
    const phases: SwapPhase[] = [];
    const updateMs: number[] = [];
    const renderMs: number[] = [];
    const gpuMs: number[] = [];
    let sinceResolve = 0;

    await new Promise<void>((resolve, reject) => {
      void renderer.setAnimationLoop(() => {
        try {
          const now = performance.now();
          const dt = Math.min(0.1, (now - last) / 1000);
          const t = (now - start) / 1000;
          for (const m of members) {
            if (m.tier === 'lod') {
              if (now < m.next) continue;
              m.next = now + 1000 / 15;
            }
            const at = positionAt(m.placement, t);
            const pose = walkPose(t + m.placement.phase, m.placement.radius > 0);
            m.holder.position.set(at.x, pose.bob, at.z);
            m.holder.rotation.y = at.yaw;
            poseAvatar(m.vrm, pose);
            if (m.tier === 'full') {
              // A merged avatar has no blend shapes left to drive.
              const e = m.vrm.scene.userData['merged'] ? undefined : m.vrm.expressionManager;
              if (e) {
                const open = mouthAt(t, m.voice);
                e.setValue('aa', open * 0.8);
                e.setValue('oh', open * 0.3);
                e.update();
              }
              if (m.springs) m.vrm.springBoneManager?.update(dt);
            }
          }
          for (const p of proxyMembers) {
            if (now < p.next) continue;
            p.next = now + 200 * (0.9 + random() * 0.2);
            const at = positionAt(p.placement, t);
            p.proxy.object.position.set(at.x, 0, at.z);
            p.proxy.object.rotation.y = at.yaw;
            p.proxy.pose(walkPose(t + p.placement.phase, p.placement.radius > 0));
          }
          waiters.shift()?.();
          const job = uploads.shift();
          if (job) {
            const u0 = performance.now();
            renderer.initTexture(job.texture);
            job.done(performance.now() - u0);
          }
          if (phase === 'settle' && now > settleUntil) phase = 'none';
          const r0 = performance.now();
          renderer.render(scene, camera);
          const r1 = performance.now();

          if (measureStart === 0 && now - start >= WARMUP_MS) {
            measureStart = now;
            nextSwap = now + o.swapSeconds * 1000;
            report.render = { drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
            o.onProgress(`${report.tiers.full.count} in full, ${report.tiers.lod.count} at the lower detail, ${report.tiers.proxy.count} proxies · ${report.render.drawCalls} draw calls · measuring ${o.seconds} s`);
            // The devlog's crowd shot, a second in, if the command line asked for one (the main process saves the window).
            setTimeout(() => void window.flatchat?.crowdShot(), 1000);
          } else if (measureStart > 0) {
            frames.push(now - last);
            phases.push(phase);
            updateMs.push(r0 - now);
            renderMs.push(r1 - r0);
            if (++sinceResolve >= 15) {
              sinceResolve = 0;
              void renderer.resolveTimestampsAsync('render').then((ms) => {
                if (typeof ms === 'number' && ms > 0) gpuMs.push(ms);
              });
            }
            flags.push(swapping || windows.some(([a, b]) => now >= a && now <= b));
            if (o.swapSeconds > 0 && !swapping && now >= nextSwap) {
              nextSwap = now + o.swapSeconds * 1000;
              swap(now).catch(reject);
            }
            if (now - measureStart >= o.seconds * 1000 && !swapping) {
              void renderer.setAnimationLoop(null);
              resolve();
            }
          }
          last = now;
        } catch (err) {
          void renderer.setAnimationLoop(null);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    report.summary = summarizeFrames(frames);
    report.framesOver50 = frames.filter((f) => f > 50).length;
    report.framesOver100 = frames.filter((f) => f > 100).length;
    const during = frames.filter((_, i) => flags[i]).sort((a, b) => a - b);
    const outside = frames.filter((_, i) => !flags[i]);
    report.duringLoads = { frames: during.length, p95Ms: Math.round(percentile(during, 95) * 100) / 100, maxMs: Math.round((during.at(-1) ?? 0) * 100) / 100 };
    report.outsideLoads = { maxMs: Math.round(outside.reduce((a, b) => Math.max(a, b), 0) * 100) / 100 };
    const p = (list: number[], q: number): number => Math.round(percentile([...list].sort((a, b) => a - b), q) * 100) / 100;
    report.cpuMs = { updateP50: p(updateMs, 50), updateP95: p(updateMs, 95), renderP50: p(renderMs, 50), renderP95: p(renderMs, 95) };
    report.gpuMs = gpuMs.length > 0 ? { p50: p(gpuMs, 50), p95: p(gpuMs, 95), samples: gpuMs.length } : null;
    frames.forEach((f, i) => {
      const b = report.byPhase[phases[i] ?? 'none'];
      b.frames += 1;
      b.maxMs = Math.max(b.maxMs, Math.round(f * 100) / 100);
      if (f > 100) b.over100 += 1;
    });
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    report.jsHeapMB = heap ? Math.round(heap.usedJSHeapSize / 1e6) : 0;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    void renderer.setAnimationLoop(null);
  }
  return report;
}
