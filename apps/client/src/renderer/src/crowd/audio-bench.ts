// SPDX-License-Identifier: MPL-2.0
// The audio bench (S6.06's Verify: the CPU cost measured). The worst case the client allows, 16
// voices through HRTF panners behind their distance low-pass and 64 placed sounds through
// equalpower panners, rendered offline for the given seconds of audio four ways: plain (the graph
// before S6.06), with the occlusion's low-pass on every placed sound, with the longest room's reverb
// (one convolver for the voices and one for the world, as the client has), and with both. Each run's
// share of one CPU core is its render time over the audio's length. Then the occlusion's rays: 80
// sounds in a test room (walls, a door, a ground of 8,192 triangles), 600 frames, their milliseconds
// a frame.
//
//   flatchat --bench=SECONDS --bench-audio=1 [--bench-out=FILE]
import type { Collider } from '@flatchat/content';
import { impulseResponse, Occlusion, OCCLUDED_HZ, SOURCE_CLEARANCE } from '../world/acoustics';
import { loadPhysics, Physics } from '../world/physics';

const VOICES = 16;
const EMITTERS = 64;
const RATE = 48_000;
const RAY_FRAMES = 600;
/** S6.06's budget: the worst case at most a quarter of one core, the rays at most 0.5 ms a frame. */
export const AUDIO_BUDGET = { load: 0.25, rayMs: 0.5 };

const RUNS: ReadonlyArray<{ name: string; filters: boolean; reverb: boolean }> = [
  { name: 'plain', filters: false, reverb: false },
  { name: 'occlusion', filters: true, reverb: false },
  { name: 'reverb', filters: false, reverb: true },
  { name: 'all', filters: true, reverb: true },
];

/** One run: the graph rendered offline; its time and its share of one core. */
async function render(seconds: number, filters: boolean, reverb: boolean): Promise<{ renderMs: number; load: number }> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
  const master = ctx.createGain();
  master.gain.value = 0.05;
  master.connect(ctx.destination);
  // The room: one convolver for the voices, one for the world's sounds (two contexts in the client).
  const rooms: GainNode[] = [];
  if (reverb) {
    const [l, r] = impulseResponse('cathedral', RATE);
    const impulse = ctx.createBuffer(2, l.length, RATE);
    impulse.copyToChannel(l, 0);
    impulse.copyToChannel(r, 1);
    for (let k = 0; k < 2; k++) {
      const send = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = impulse;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      send.connect(conv).connect(wet).connect(master);
      rooms.push(send);
    }
  }
  // A second of noise, looped, for every source: nothing stays silent.
  const noise = ctx.createBuffer(1, RATE, RATE);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  for (let k = 0; k < VOICES + EMITTERS; k++) {
    const voice = k < VOICES;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    let node: AudioNode = source;
    // A voice always has its distance low-pass; a placed sound has the occlusion's.
    if (voice || filters) node = node.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: voice ? 6_000 : OCCLUDED_HZ }));
    node = node.connect(new GainNode(ctx, { gain: 0.5 }));
    const angle = (k / (VOICES + EMITTERS)) * Math.PI * 2;
    const panner = new PannerNode(ctx, { panningModel: voice ? 'HRTF' : 'equalpower', distanceModel: 'inverse', positionX: Math.cos(angle) * 5, positionY: 1.6, positionZ: Math.sin(angle) * 5 });
    node.connect(panner).connect(master);
    if (rooms.length) panner.connect(rooms[voice ? 0 : 1]!);
    source.start();
  }
  const t0 = performance.now();
  await ctx.startRendering();
  const renderMs = performance.now() - t0;
  return { renderMs: Number(renderMs.toFixed(1)), load: Number((renderMs / (seconds * 1000)).toFixed(4)) };
}

/** A 12 m room split by a wall with a door, on a ground of triangles. */
function testRoom(): Collider[] {
  const box = (position: [number, number, number], half: [number, number, number]): Collider => ({ type: 'box', position, rotation: [0, 0, 0, 1], half });
  const n = 64;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) positions.set([-6 + (12 * x) / n, 0.05 * Math.sin(x) * Math.cos(z), -6 + (12 * z) / n], (z * (n + 1) + x) * 3);
  const indices = new Uint32Array(n * n * 6);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      indices.set([a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2], (z * n + x) * 6);
    }
  return [
    { type: 'trimesh', positions, indices },
    box([-1.25, 1.5, 0], [4.75, 1.5, 0.1]),
    box([4.85, 1.5, 0], [1.15, 1.5, 0.1]),
    box([0, 1.5, -6], [6, 1.5, 0.1]),
    box([0, 1.5, 6], [6, 1.5, 0.1]),
    box([-6, 1.5, 0], [0.1, 1.5, 6]),
    box([6, 1.5, 0], [0.1, 1.5, 6]),
  ];
}

/** The occlusion's rays: 80 sounds on both sides of the wall, the listener walking across. */
async function rays(): Promise<Record<string, number>> {
  await loadPhysics();
  const physics = new Physics(testRoom(), { x: 3.1, y: 0.1, z: -3 });
  try {
    const occlusion = new Occlusion((a, b) => physics.blocked(a, b, SOURCE_CLEARANCE));
    const sounds = Array.from({ length: VOICES + EMITTERS }, (_, k) => ({ key: `s${k}`, at: { x: -5 + (k % 10) * 1.1, y: 1.4, z: k < 40 ? 3 + (k % 3) : -4 + (k % 3) }, reach: 25 }));
    let occluded = 0;
    for (let f = 0; f < RAY_FRAMES; f++) {
      const head = { x: 3.1 - (f / RAY_FRAMES) * 6, y: 1.6, z: -3 };
      occlusion.update(head, sounds);
      occluded = Math.max(occluded, occlusion.count);
    }
    const c = occlusion.takeCounts();
    return { frames: c.frames, raysPerFrame: c.rays / c.frames, avgMs: Number((c.ms / c.frames).toFixed(4)), worstMs: Number(c.worstMs.toFixed(3)), mostOccluded: occluded };
  } finally {
    physics.dispose();
  }
}

export async function runAudioBench(o: { seconds: number; onProgress: (line: string) => void }): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { mode: 'audio-bench', seconds: o.seconds, voices: VOICES, emitters: EMITTERS, sampleRate: RATE };
  try {
    // A short render first (the HRTF database loads on the first), then each run twice, the faster
    // kept: what else the machine does only ever slows a run down.
    o.onProgress('Audio bench: warming up…');
    await render(0.5, true, true);
    const results: Array<Record<string, unknown>> = [];
    for (const run of RUNS) {
      o.onProgress(`Audio bench: ${run.name}…`);
      const a = await render(o.seconds, run.filters, run.reverb);
      const b = await render(o.seconds, run.filters, run.reverb);
      results.push({ name: run.name, ...(a.renderMs <= b.renderMs ? a : b) });
    }
    const plain = results[0]!['load'] as number;
    for (const r of results) r['costLoad'] = Number(((r['load'] as number) - plain).toFixed(4));
    report['audio'] = results;
    o.onProgress('Audio bench: rays…');
    const r = await rays();
    report['rays'] = r;
    report['budget'] = AUDIO_BUDGET;
    report['withinBudget'] = (results.at(-1)!['load'] as number) <= AUDIO_BUDGET.load && (r['avgMs'] ?? Infinity) <= AUDIO_BUDGET.rayMs;
  } catch (err) {
    report['error'] = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }
  return report;
}
