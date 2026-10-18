// SPDX-License-Identifier: MPL-2.0
// Downloading a world (S2.04) and moving through it with Rapier (S2.06), without a window. Its
// sounds (S2.14) with the platform's default footsteps and interface sounds (Track P's P.06).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Collider } from '@flatchat/content';
import { fromHex, type Message, toHex } from '@flatchat/protocol';
import { BODY, MOVE, type MoveInput, PLAZA } from '@flatchat/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentCache } from '../src/main/content-cache';
import { Downloader } from '../src/renderer/src/world/download';
import { loadPhysics, Physics } from '../src/renderer/src/world/physics';
import * as THREE from 'three/webgpu';
import { checkGlb, levelsOfDetail, lodDistances, SceneError } from '../src/renderer/src/world/scene-loader';
import { buildParts, partGeometry } from '../src/renderer/src/world/parts';
import { mapColliders } from '../src/renderer/src/world/session';
import { FOOTSTEPS, soundBytes, UI_SOUNDS } from '../src/renderer/src/world/default-sounds';
import { MAX_EMITTERS, planEmitters, type SoundContext, Strides, UiSounds, WorldSounds } from '../src/renderer/src/world/sounds';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function memoryCache(): { has: (h: string[]) => Promise<string[]>; get: (h: string) => Promise<Uint8Array | undefined>; put: (h: string, b: Uint8Array) => Promise<boolean>; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    has: async (h) => h.filter((x) => files.has(x)),
    get: async (h) => files.get(h),
    put: async (h, b) => {
      files.set(h, b);
      return true;
    },
  };
}

/** A pretend world server: answers fetches from a set of files, in 16 KB chunks. */
function server(files: Map<string, Uint8Array>, dl: () => Downloader, sent: Message[]): (m: Message) => void {
  return (m) => {
    sent.push(m);
    if (m.type !== 'fetch') return;
    const bytes = files.get(toHex(m.hash));
    queueMicrotask(() => {
      if (!bytes) return void dl().message({ type: 'notFound', hash: m.hash });
      for (let o = m.from; o < bytes.length || (o === 0 && bytes.length === 0); o += 16_384) {
        dl().message({ type: 'chunk', hash: m.hash, offset: o, total: bytes.length, data: bytes.subarray(o, o + 16_384) });
        if (bytes.length === 0) break;
      }
    });
  };
}

function builtFiles(): { files: Map<string, Uint8Array>; json: Uint8Array; scene: Uint8Array } {
  const scene = new Uint8Array(50_000).map((_, i) => i & 255);
  const collision = new Uint8Array([1, 2, 3]);
  const world = {
    format: 1,
    manifest: { format: 1, name: 'DL', description: '', capacity: { recommended: 4, maximum: 6 }, persistence: 'reset', flying: false, avatars: { minHeight: 0.5, maxHeight: 3 }, voice: { range: 25 }, scenes: [{ id: 'main', file: 'main.glb' }] },
    scenes: [{ id: 'main', glb: sha(scene), spawns: [{ position: [0, 0, 0], yaw: 0, title: '', group: '' }], seats: [], portals: [], zones: [], emitters: [], triangles: 1 }],
    collision: sha(collision),
    bounds: { min: [0, -100, 0], max: [16, 500, 16] },
    files: [
      { hash: sha(scene), size: scene.length, kind: 'scene' },
      { hash: sha(collision), size: collision.length, kind: 'collision' },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(world));
  return { files: new Map([[sha(json), json], [sha(scene), scene], [sha(collision), collision]]), json, scene };
}

describe('downloading a world', () => {
  it('fetches world.json and every file it lists, checks them and keeps them', async () => {
    const { files, json, scene } = builtFiles();
    const cache = memoryCache();
    const sent: Message[] = [];
    const progress: number[] = [];
    // The pretend server reaches the downloader through a closure, called only after it exists.
    const dl: Downloader = new Downloader(server(files, () => dl, sent), cache, (p) => progress.push(p.done / p.total));
    const r = await dl.world(sha(json), json.length);
    expect(r.world.manifest.name).toBe('DL');
    expect(r.files.get(sha(scene))).toEqual(scene);
    expect(sent.filter((m) => m.type === 'fetch')).toHaveLength(3);
    expect(cache.files.size).toBe(3);
    expect(progress.at(-1)).toBe(1);
    // A second visit comes from the cache: nothing is fetched.
    sent.length = 0;
    await new Downloader(server(files, () => dl, sent), cache).world(sha(json), json.length);
    expect(sent).toEqual([]);
  });

  it('refuses a file that does not match its hash, a world.json out of shape, and a missing file', async () => {
    const { files, json, scene } = builtFiles();
    const bad = new Map(files);
    bad.set(sha(scene), new Uint8Array(50_000));
    let dl!: Downloader;
    dl = new Downloader(server(bad, () => dl, []), memoryCache());
    await expect(dl.world(sha(json), json.length)).rejects.toThrow(/did not match its hash/);
    const odd = new TextEncoder().encode('{"format":7}');
    const oddFiles = new Map([[sha(odd), odd]]);
    dl = new Downloader(server(oddFiles, () => dl, []), memoryCache());
    await expect(dl.world(sha(odd), odd.length)).rejects.toThrow(/world.json: format/);
    dl = new Downloader(server(new Map(), () => dl, []), memoryCache());
    await expect(dl.file('ab'.repeat(32))).rejects.toThrow(/does not have/);
  });

  it('refuses chunks out of order', async () => {
    const cache = memoryCache();
    const dl: Downloader = new Downloader((m) => {
      if (m.type === 'fetch') queueMicrotask(() => dl.message({ type: 'chunk', hash: m.hash, offset: 100, total: 200, data: new Uint8Array(100) }));
    }, cache);
    await expect(dl.file('cd'.repeat(32))).rejects.toThrow(/out of order/);
  });

  it('keeps on disk only what matches its name, and trims the least used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-cache-'));
    dirs.push(dir);
    const c = new ContentCache(dir, 100);
    const a = new Uint8Array(60).fill(1);
    const b = new Uint8Array(60).fill(2);
    expect(c.put(sha(a), b)).toBe(false);
    expect(c.put('../evil', a)).toBe(false);
    expect(c.put(sha(a), a)).toBe(true);
    expect(c.has([sha(a), sha(b), 'nope'])).toEqual([sha(a)]);
    expect(c.put(sha(b), b)).toBe(true);
    // Over 100 bytes: the older file goes.
    expect(c.has([sha(a), sha(b)])).toEqual([sha(b)]);
    expect(c.get(sha(b))).toEqual(b);
    expect(toHex(fromHex(sha(b)))).toBe(sha(b));
  });
});

describe('moving with Rapier', () => {
  beforeAll(async () => {
    await loadPhysics();
  });
  const idle: MoveInput = { forward: 0, right: 0, run: false, jump: false, yaw: 0 };
  const run = (p: Physics, input: MoveInput, seconds: number): ReturnType<Physics['step']> => {
    let s = p.state;
    for (let t = 0; t < seconds; t += 1 / 60) s = p.step(input, 1 / 60);
    return s;
  };

  it('stands, walks at walking speed, and jumps about as high as packages/sim says', () => {
    const floor: Collider = { type: 'box', position: [0, -0.5, 0], rotation: [0, 0, 0, 1], half: [50, 0.5, 50] };
    const p = new Physics([floor], { x: 0, y: 0, z: 0 });
    expect(run(p, idle, 0.5).y).toBeCloseTo(0, 1);
    const walked = run(p, { ...idle, forward: 1 }, 2);
    expect(-walked.z).toBeGreaterThan(MOVE.walk * 2 - 0.6);
    expect(-walked.z).toBeLessThan(MOVE.walk * 2 + 0.1);
    p.step({ ...idle, jump: true }, 1 / 60);
    let peak = 0;
    for (let i = 0; i < 90; i++) peak = Math.max(peak, p.step(idle, 1 / 60).y);
    expect(peak).toBeGreaterThan(0.75);
    expect(peak).toBeLessThan(1.0);
    p.dispose();
  });

  it('climbs the plaza’s steps onto its stage, and stops at a wall', () => {
    const p = new Physics(mapColliders(PLAZA), { x: 59.5, y: 0.15, z: PLAZA.spawn.z });
    const onStage = run(p, { ...idle, forward: 1 }, 8);
    expect(onStage.y).toBeCloseTo(0.15 + 0.9, 1);
    p.dispose();
    const wall: Collider = { type: 'box', position: [0, 1.5, -3], rotation: [0, 0, 0, 1], half: [5, 1.5, 0.5] };
    const floor: Collider = { type: 'box', position: [0, -0.5, 0], rotation: [0, 0, 0, 1], half: [50, 0.5, 50] };
    const q = new Physics([floor, wall], { x: 0, y: 0, z: 0 });
    expect(run(q, { ...idle, forward: 1 }, 2).z).toBeGreaterThan(-2.5 + BODY.radius - 0.1);
    q.dispose();
  });

  it('walks up a ramp made of triangles', () => {
    // A 20° ramp rising toward -z.
    const rise = Math.tan((20 * Math.PI) / 180) * 10;
    const ramp: Collider = { type: 'trimesh', positions: new Float32Array([-5, 0, 0, 5, 0, 0, 5, rise, -10, -5, rise, -10, -50, 0, 50, 50, 0, 50, 50, 0, 0, -50, 0, 0]), indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6]) };
    const p = new Physics([ramp], { x: 0, y: 0, z: 1 });
    const s = run(p, { ...idle, forward: 1 }, 2.5);
    expect(s.y).toBeGreaterThan(1.5);
    p.dispose();
  });
});

describe('a downloaded scene', () => {
  it('must be a self-contained GLB', () => {
    expect(() => checkGlb(new Uint8Array(10))).toThrow(SceneError);
    const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], images: [{ uri: 'https://evil.example/x.png' }] }));
    const glb = new Uint8Array(20 + Math.ceil(json.length / 4) * 4).fill(0x20);
    const v = new DataView(glb.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, glb.length, true);
    v.setUint32(12, glb.length - 20, true);
    v.setUint32(16, 0x4e4f534a, true);
    glb.set(json, 20);
    expect(() => checkGlb(glb)).toThrow(/inside its GLB/);
  });
});

describe('levels of detail (S2.03)', () => {
  it('gathers marked siblings into a THREE.LOD at the full level, leaving every level where it was', () => {
    const root = new THREE.Group();
    const parent = new THREE.Group();
    parent.position.set(5, 0, 0);
    root.add(parent);
    const level = (k: number, size: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
      m.position.set(10, 1, -4);
      m.userData['flatchatLod'] = k;
      return m;
    };
    const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    parent.add(level(2, 1), level(0, 1), level(1, 1), other);
    root.updateMatrixWorld(true);
    expect(levelsOfDetail(root)).toBe(1);
    const lod = parent.children.find((c): c is THREE.LOD => (c as THREE.LOD).isLOD === true)!;
    expect(parent.children).toContain(other);
    expect(lod.position.toArray()).toEqual([10, 1, -4]);
    expect(lod.levels.map((l) => [l.object.userData['flatchatLod'], l.distance])).toEqual([
      [0, 0],
      [1, 12],
      [2, 30],
    ]);
    const at = lod.levels[2]!.object.getWorldPosition(new THREE.Vector3());
    expect(at.toArray()).toEqual([15, 1, -4]);
    expect(lodDistances(10)).toEqual([80, 200]);
  });

  it('leaves unmarked scenes, and a set without its full level, as they are', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    a.userData['flatchatLod'] = 1;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.userData['flatchatLod'] = 2;
    root.add(a, b, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(levelsOfDetail(root)).toBe(0);
    expect(root.children).toHaveLength(3);
  });
});

describe('world sounds (S2.14)', () => {
  const emitter = (k: number, extra: Record<string, unknown> = {}) => ({
    position: [k, 1, -k] as [number, number, number],
    audio: `a${k}`,
    positional: true,
    gain: 0.8,
    loop: true,
    autoPlay: true,
    refDistance: 2,
    maxDistance: 30,
    ...extra,
  });
  const world = (emitters: unknown[]) => ({ scenes: [{ emitters }] }) as unknown as Parameters<typeof planEmitters>[0];

  it('plans the emitters that play by themselves, at their places, within the limits', () => {
    const plan = planEmitters(world([emitter(1), emitter(2, { autoPlay: false }), emitter(3, { gain: 9, refDistance: 5, maxDistance: 1 })]));
    expect(plan.map((p) => p.audio)).toEqual(['a1', 'a3']);
    expect(plan[0]).toEqual({ audio: 'a1', position: [1, 1, -1], positional: true, gain: 0.8, loop: true, refDistance: 2, maxDistance: 30 });
    expect(plan[1]).toMatchObject({ gain: 4, refDistance: 5, maxDistance: 5 });
    expect(planEmitters(world(Array.from({ length: 80 }, (_, k) => emitter(k))))).toHaveLength(MAX_EMITTERS);
  });

  it('puts each positional sound where its emitter stands, and the ears at the camera', async () => {
    const panners: Array<Record<string, unknown>> = [];
    const param = (): { value: number; setValueAtTime: () => void; linearRampToValueAtTime: () => void; exponentialRampToValueAtTime: () => void } => ({
      value: 0,
      setValueAtTime: () => undefined,
      linearRampToValueAtTime: () => undefined,
      exponentialRampToValueAtTime: () => undefined,
    });
    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = { connect: (to: unknown) => to, gain: param(), frequency: param(), Q: param() };
      return n;
    };
    const listener = Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map((k) => [k, param()]));
    let started = 0;
    const fake = {
      createGain: node,
      createBiquadFilter: node,
      createPanner: () => {
        const p = { ...node(), positionX: param(), positionY: param(), positionZ: param() };
        panners.push(p);
        return p;
      },
      createBufferSource: () => ({ ...node(), playbackRate: param(), start: () => (started += 1), stop: () => undefined }),
      createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
      decodeAudioData: async (b: ArrayBuffer) => {
        if (b.byteLength === 1) throw new Error('not audio');
        return {};
      },
      destination: {},
      listener,
      currentTime: 0,
      sampleRate: 48_000,
      close: async () => undefined,
      resume: async () => undefined,
    } as unknown as SoundContext;
    const sounds = new WorldSounds(0.8, fake);
    const files = new Map([
      ['a1', new Uint8Array([1, 2, 3])],
      ['a4', new Uint8Array([1])],
      ['a5', new Uint8Array([1, 2])],
    ]);
    const playing = await sounds.start(world([emitter(1), emitter(4), emitter(5, { positional: false }), emitter(6)]), files);
    // a4 cannot be decoded and a6 never arrived: two play, one of them placed.
    expect(playing).toBe(2);
    expect(started).toBe(2);
    const at = (p: Record<string, unknown>) => ['positionX', 'positionY', 'positionZ'].map((k) => (p[k] as { value: number }).value);
    expect(panners.map(at)).toEqual([[1, 1, -1]]);
    expect(panners[0]).toMatchObject({ refDistance: 2, maxDistance: 30, distanceModel: 'inverse' });
    sounds.listen({ x: 3, y: 2, z: 1 }, Math.PI / 2, 0);
    expect([listener['positionX']!.value, listener['positionY']!.value, listener['positionZ']!.value]).toEqual([3, 2, 1]);
    expect(listener['forwardX']!.value).toBeCloseTo(-1);
    expect(listener['forwardZ']!.value).toBeCloseTo(0);
    // A footstep elsewhere gets its own panner there.
    await sounds.ready;
    sounds.footstep({ x: 9, y: 0, z: 9 });
    expect(at(panners.at(-1)!)).toEqual([9, 0, 9]);
    expect(sounds.steps).toBe(1);
  });

  it('plays the default footsteps: each a recording, never the same twice running, at its loudness', async () => {
    const played: Array<{ buffer: unknown; rate: number; gain: number }> = [];
    const param = (): { value: number } => ({ value: 0 });
    // A step's gain node is the last one made before it starts.
    const gains: Array<{ value: number }> = [];
    // Each decoded footstep is the bytes it came from, so the test sees which one played.
    const fake = {
      createGain: () => {
        const g = { gain: param(), connect: (to: unknown) => to };
        gains.push(g.gain);
        return g;
      },
      createPanner: () => ({ positionX: param(), positionY: param(), positionZ: param(), connect: (to: unknown) => to }),
      createBufferSource: () => {
        const src = { buffer: null as unknown, playbackRate: param(), connect: (to: unknown) => to, start: () => played.push({ buffer: src.buffer, rate: src.playbackRate.value, gain: gains.at(-1)!.value }) };
        return src;
      },
      decodeAudioData: async (b: ArrayBuffer) => ({ bytes: b.byteLength }),
      destination: {},
      listener: {},
      close: async () => undefined,
      resume: async () => undefined,
    } as unknown as SoundContext;
    const sounds = new WorldSounds(1, fake);
    await sounds.ready;
    for (let k = 0; k < 200; k++) sounds.footstep(undefined, 0.3);
    expect(played).toHaveLength(200);
    const which = played.map((p) => (p.buffer as { bytes: number }).bytes);
    for (let k = 1; k < which.length; k++) expect(which[k]).not.toBe(which[k - 1]);
    expect(new Set(which).size).toBe(FOOTSTEPS.length);
    for (const p of played) {
      expect(p.rate).toBeGreaterThanOrEqual(0.94);
      expect(p.rate).toBeLessThanOrEqual(1.06);
      expect(p.gain).toBe(0.3);
    }
  });

  it('plays the interface sounds, once decoded, at their volume', async () => {
    const started: string[] = [];
    let master = { value: 0 };
    const fake = {
      createGain: () => {
        const g = { gain: { value: 0 }, connect: (to: unknown) => to };
        if (master.value === 0) master = g.gain;
        return g;
      },
      createBufferSource: () => {
        const src = { buffer: null as unknown, connect: (to: unknown) => to, start: () => started.push(String((src.buffer as { kind: string }).kind)) };
        return src;
      },
      decodeAudioData: async (b: ArrayBuffer) => ({ kind: Object.entries(UI_SOUNDS).find(([, url]) => soundBytes(url).byteLength === b.byteLength)?.[0] }),
      destination: {},
    } as unknown as ConstructorParameters<typeof UiSounds>[1];
    const ui = new UiSounds(0.5, fake);
    // Before it is decoded, a sound is silent.
    ui.play('click');
    expect(started).toEqual([]);
    await ui.ready;
    for (const kind of ['click', 'chime', 'blip'] as const) ui.play(kind);
    expect(started).toEqual(['click', 'chime', 'blip']);
    expect(master.value).toBe(0.5);
    ui.volume = 0.2;
    expect(master.value).toBe(0.2);
  });

  it('carries the default sounds kits/sounds/sounds.json lists, each the file it names', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'sounds');
    const listed = (JSON.parse(readFileSync(join(dir, 'sounds.json'), 'utf8')) as { sounds: Array<{ name: string; kind: string; file: string; sha256: string }> }).sounds;
    const carried = new Map([...Object.entries(UI_SOUNDS), ...FOOTSTEPS.map((url, k) => [`footstep${k}`, url] as const)]);
    expect(listed.map((l) => l.name).sort()).toEqual([...carried.keys()].sort());
    for (const l of listed) {
      const bytes = new Uint8Array(readFileSync(join(dir, l.file)));
      expect(createHash('sha256').update(bytes).digest('hex'), l.name).toBe(l.sha256);
      expect(new Uint8Array(soundBytes(carried.get(l.name)!)), l.name).toEqual(bytes);
    }
  });

  it('counts a stride every 0.7 m on the ground, never in the air or across a teleport', () => {
    const s = new Strides();
    let steps = 0;
    for (let k = 0; k <= 70; k++) if (s.step(k * 0.05, 0, true, false)) steps += 1;
    expect(steps).toBe(5);
    let air = 0;
    for (let k = 0; k <= 70; k++) if (s.step(k * 0.05, 5, false, false)) air += 1;
    expect(air).toBe(0);
    expect(s.step(50, 50, true, false)).toBe(false);
  });
});

describe('the base library on screen (S2.05)', () => {
  it('draws each kind of part as one instanced mesh, every placement where the world put it', () => {
    const turn = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number];
    const group = buildParts([
      { id: 'flatchat:tree', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { id: 'flatchat:tree', position: [5, 0, 6], rotation: turn, scale: [2, 2, 2] },
      { id: 'flatchat:bench', position: [3, 0, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { id: 'acme:unknown', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ]);
    const meshes = group.children as THREE.InstancedMesh[];
    expect(meshes.map((m) => [m.name, m.count])).toEqual([
      ['flatchat:tree', 2],
      ['flatchat:bench', 1],
    ]);
    const m = new THREE.Matrix4();
    meshes[0]!.getMatrixAt(1, m);
    const at = new THREE.Vector3();
    const size = new THREE.Vector3();
    m.decompose(at, new THREE.Quaternion(), size);
    expect([at.x, at.y, at.z]).toEqual([5, 0, 6]);
    expect(size.x).toBeCloseTo(2);
    // The tree's three boxes are one geometry, with a colour for every vertex.
    const g = partGeometry('flatchat:tree');
    expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
    expect(g.getAttribute('position').count).toBe(3 * 24);
  });
});
