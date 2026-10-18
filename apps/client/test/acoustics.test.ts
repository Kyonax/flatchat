// SPDX-License-Identifier: MPL-2.0
// 3D audio (S6.06), without a window: a test room with walls (Rapier's solids, as a world builds
// them) where a sound behind the dividing wall is found occluded and one through the door is not,
// the player's own body never in the way, a sound inside its own box not behind it, and the rays kept
// within their budget; each room's impulse (its length, its fall, as loud as the others, wide); the
// reverb zone the listener is in (the smallest, turned zones too); the reverb crossfading from room
// to room and letting the old one go; the world's emitters muffled and opened again.
import type { BuiltZone, Collider } from '@flatchat/content';
import { REVERB_ROOMS } from '@flatchat/content';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMPULSE_MAX_S, impulseResponse, OCCLUDED_GAIN, OCCLUDED_HZ, Occlusion, Reverb, reverbAt, ROOM_ACOUSTICS, SOURCE_CLEARANCE } from '../src/renderer/src/world/acoustics';
import { loadPhysics, Physics } from '../src/renderer/src/world/physics';
import { type SoundContext, WorldSounds } from '../src/renderer/src/world/sounds';

const box = (position: [number, number, number], half: [number, number, number]): Collider => ({ type: 'box', position, rotation: [0, 0, 0, 1], half });

/** A 10 m room, 3 m high, split along z = 0 by a wall with a 1.2 m door at x = 2.5 to 3.7; and a
 *  speaker box (0.4 m) on the near side. */
const ROOM: Collider[] = [
  box([0, -0.5, 0], [6, 0.5, 6]),
  box([-1.25, 1.5, 0], [3.75, 1.5, 0.1]),
  box([4.35, 1.5, 0], [0.65, 1.5, 0.1]),
  box([0, 1.5, -5], [5, 1.5, 0.1]),
  box([0, 1.5, 5], [5, 1.5, 0.1]),
  box([-2, 0.6, -2], [0.2, 0.2, 0.2]),
];

describe('a test room with walls', () => {
  beforeAll(async () => {
    await loadPhysics();
  });

  it('finds a sound behind the wall occluded, and one through the door or on this side clear', () => {
    const p = new Physics(ROOM, { x: 0, y: 0, z: -3 });
    const head = { x: 0, y: 1.6, z: -3 };
    expect(p.blocked(head, { x: 0, y: 1.6, z: 3 }, SOURCE_CLEARANCE)).toBe(true);
    expect(p.blocked(head, { x: -3, y: 1.2, z: 4 }, SOURCE_CLEARANCE)).toBe(true);
    expect(p.blocked({ x: 3.1, y: 1.6, z: -3 }, { x: 3.1, y: 1.6, z: 3 }, SOURCE_CLEARANCE)).toBe(false);
    expect(p.blocked(head, { x: 2, y: 1.2, z: -1 }, SOURCE_CLEARANCE)).toBe(false);
    // The ray starts inside the player's own body, which is never in the way; a sound inside its own
    // speaker box is not behind it (the last half metre is not tested).
    expect(p.blocked({ x: 0, y: 1, z: -3 }, { x: 1, y: 1, z: -3.5 }, SOURCE_CLEARANCE)).toBe(false);
    expect(p.blocked(head, { x: -2, y: 0.6, z: -2 }, SOURCE_CLEARANCE)).toBe(false);
    p.dispose();
  });

  it('tests a few sounds a frame, each in turn, and forgets those out of reach', () => {
    // The listener stands in front of the door.
    const p = new Physics(ROOM, { x: 3.1, y: 0, z: -3 });
    const o = new Occlusion((a, b) => p.blocked(a, b, SOURCE_CLEARANCE), 16);
    const head = { x: 3.1, y: 1.6, z: -3 };
    // 80 sounds: half behind the wall, half on this side; and one too far to hear.
    const sounds = Array.from({ length: 80 }, (_, k) => ({ key: `s${k}`, at: { x: -4 + (k % 8), y: 1.2, z: k < 40 ? 3 : -1.5 }, reach: 25 }));
    const far = { key: 'far', at: { x: 0, y: 1.2, z: 4 }, reach: 2 };
    let state = o.update(head, [...sounds, far]);
    expect(o.rays).toBe(16);
    expect(state.size).toBe(16);
    for (let f = 0; f < 4; f++) state = o.update(head, [...sounds, far]);
    expect(o.rays).toBe(80);
    expect(state.size).toBe(80);
    expect(state.has('far')).toBe(false);
    // Behind the wall, those in line with the door (x = 2 and 3, ten of them) are heard; the other
    // thirty are occluded.
    const behind = sounds.filter((s) => s.at.z > 0);
    expect(behind.filter((s) => !state.get(s.key)).map((s) => s.at.x).sort()).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    const occludedBehind = behind.filter((s) => state.get(s.key)).length;
    expect(occludedBehind).toBe(30);
    expect(sounds.filter((s) => s.at.z < 0).every((s) => state.get(s.key) === false)).toBe(true);
    expect(o.count).toBe(occludedBehind);
    const c = o.takeCounts();
    expect(c).toMatchObject({ rays: 80, frames: 5 });
    expect(c.ms / c.frames).toBeLessThan(5);
    expect(o.takeCounts()).toMatchObject({ rays: 0, frames: 0 });
    // Out of reach now: forgotten.
    expect(o.update(head, sounds.slice(0, 10)).size).toBe(10);
    p.dispose();
  });
});

describe('the rooms', () => {
  it('each make an impulse that falls away over its reverberation time, as loud as the others, wide', () => {
    let last = 0;
    for (const room of REVERB_ROOMS) {
      const a = ROOM_ACOUSTICS[room];
      const [l, r] = impulseResponse(room, 48_000);
      expect(l.length, room).toBe(Math.round(Math.min(IMPULSE_MAX_S, a.predelay + a.rt60 * 1.1) * 48_000));
      expect(a.rt60, room).toBeGreaterThan(last);
      last = a.rt60;
      // Silent before the first reflections; unit energy in each channel.
      expect(l.slice(0, Math.round(a.predelay * 48_000) - 1).every((v) => v === 0), room).toBe(true);
      const energy = (x: Float32Array, from = 0, to = x.length): number => x.slice(from, to).reduce((s, v) => s + v * v, 0);
      expect(energy(l), room).toBeCloseTo(1, 4);
      expect(energy(r), room).toBeCloseTo(1, 4);
      // The last tenth holds next to nothing of it (60 dB down by the reverberation time).
      expect(energy(l, Math.round(l.length * 0.9)), room).toBeLessThan(0.001);
      // The two channels are different noise: the room is wide.
      let dot = 0;
      for (let i = 0; i < l.length; i++) dot += l[i]! * r[i]!;
      expect(Math.abs(dot), room).toBeLessThan(0.2);
      // The same room always sounds the same.
      expect(impulseResponse(room, 48_000)[0]).toEqual(l);
    }
  });

  it('are found where the listener stands: the smallest zone that holds the point, turned or not', () => {
    const zone = (center: [number, number, number], half: [number, number, number], over: Partial<BuiltZone> = {}): BuiltZone => ({ center, half, yaw: 0, kind: 'reverb', room: 'hall', mix: 0.4, ...over });
    const zones = [zone([0, 2, 0], [20, 5, 20]), zone([5, 2, 5], [2, 2, 2], { room: 'small', mix: 0.2 }), zone([-10, 2, 0], [1, 2, 4], { yaw: Math.PI / 2, room: 'cave', mix: 0.7 }), zone([0, 2, 0], [1, 1, 1], { kind: 'quiet', room: undefined, mix: undefined })];
    expect(reverbAt(zones, { x: 0, y: 1.6, z: 0 })).toEqual({ room: 'hall', mix: 0.4 });
    expect(reverbAt(zones, { x: 5.5, y: 1.6, z: 4 })).toEqual({ room: 'small', mix: 0.2 });
    // The cave is 2 m by 8 m turned a quarter: 3 m along x from its centre is inside.
    expect(reverbAt(zones, { x: -13, y: 1.6, z: 0.5 })).toEqual({ room: 'cave', mix: 0.7 });
    expect(reverbAt(zones, { x: 30, y: 1.6, z: 0 })).toBeUndefined();
  });
});

/** A fake audio context: every node records its connections and its parameters' targets. */
function fakeContext(): { ctx: SoundContext; convolvers: Array<Record<string, unknown>>; buffers: number; advance: (s: number) => void } {
  const out = { convolvers: [] as Array<Record<string, unknown>>, buffers: 0, time: 0 };
  const param = (): { value: number; target: number; setTargetAtTime: (v: number) => void; setValueAtTime: (v: number) => void } => {
    const p = { value: 0, target: Number.NaN, setTargetAtTime: (v: number) => (p.target = v), setValueAtTime: (v: number) => (p.value = v) };
    return p;
  };
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = { to: [] as unknown[], gain: param(), frequency: param(), Q: param(), connect: (to: unknown) => ((n['to'] as unknown[]).push(to), to), disconnect: (to?: unknown) => (n['to'] = to === undefined ? [] : (n['to'] as unknown[]).filter((x) => x !== to)) };
    return n;
  };
  const ctx = {
    createGain: node,
    createBiquadFilter: node,
    createPanner: () => ({ ...node(), positionX: param(), positionY: param(), positionZ: param() }),
    createConvolver: () => {
      const c = { ...node(), buffer: null as unknown, normalize: true };
      out.convolvers.push(c);
      return c;
    },
    createBuffer: (channels: number, length: number) => {
      out.buffers += 1;
      return { length, numberOfChannels: channels, copyToChannel: () => undefined };
    },
    createBufferSource: () => ({ ...node(), playbackRate: param(), start: () => undefined, stop: () => undefined }),
    decodeAudioData: async () => ({}),
    destination: {},
    listener: {},
    get currentTime() {
      return out.time;
    },
    sampleRate: 48_000,
    close: async () => undefined,
    resume: async () => undefined,
  } as unknown as SoundContext;
  return {
    ctx,
    convolvers: out.convolvers,
    get buffers() {
      return out.buffers;
    },
    advance: (s: number) => (out.time += s),
  };
}

describe('the reverb', () => {
  it('crossfades from room to room, and lets the old convolver go once silent', () => {
    const f = fakeContext();
    const output = f.ctx.createGain();
    const reverb = new Reverb(f.ctx, output);
    reverb.set('hall', 0.4);
    expect(f.convolvers).toHaveLength(1);
    expect(f.convolvers[0]).toMatchObject({ normalize: false });
    expect((f.convolvers[0]!['buffer'] as { length: number }).length).toBe(impulseResponse('hall', 48_000)[0].length);
    // The same room at another mix: the same convolver, eased to the new mix.
    reverb.set('hall', 0.6);
    expect(f.convolvers).toHaveLength(1);
    reverb.set('cave', 0.5);
    expect(f.convolvers).toHaveLength(2);
    expect(reverb.working).toBe(2);
    f.advance(1.1);
    reverb.set('cave', 0.5);
    expect(reverb.working).toBe(1);
    // Back to the hall: its impulse was made once.
    const made = f.buffers;
    reverb.set('hall', 0.4);
    expect(f.buffers).toBe(made);
    reverb.set(undefined, 0);
    f.advance(1.1);
    reverb.set(undefined, 0);
    expect(reverb.working).toBe(0);
  });
});

describe("the world's emitters", () => {
  it('are muffled behind a wall, and open again', async () => {
    const f = fakeContext();
    const sounds = new WorldSounds(0.8, f.ctx);
    const emitter = (k: number) => ({ audio: `a${k}`, position: [k, 1, 0] as [number, number, number], positional: true, gain: 0.5, loop: true, autoPlay: true, refDistance: 2, maxDistance: 30 });
    const world = { scenes: [{ emitters: [emitter(1), emitter(2), { ...emitter(3), positional: false }] }] } as unknown as Parameters<WorldSounds['start']>[0];
    const files = new Map([1, 2, 3].map((k) => [`a${k}`, new Uint8Array([k])]));
    expect(await sounds.start(world, files)).toBe(3);
    // Only the placed ones are tested.
    expect(sounds.audibles().map((a) => [a.key, a.at.x, a.reach])).toEqual([
      ['emitter:0', 1, 30],
      ['emitter:1', 2, 30],
    ]);
    expect(sounds.occlude(new Map([['emitter:0', true]]))).toBe(1);
    const placed = (sounds as unknown as { placed: Array<{ gain: { gain: { target: number } }; filter: { frequency: { target: number } } }> }).placed;
    expect(placed[0]!.filter.frequency.target).toBe(OCCLUDED_HZ);
    expect(placed[0]!.gain.gain.target).toBeCloseTo(0.5 * OCCLUDED_GAIN);
    expect(Number.isNaN(placed[1]!.filter.frequency.target)).toBe(true);
    expect(sounds.occlude(new Map())).toBe(0);
    expect(placed[0]!.filter.frequency.target).toBe(20_000);
    expect(placed[0]!.gain.gain.target).toBe(0.5);
    // In a reverb zone, the room's convolver takes what the placed sounds send.
    sounds.room('room', 0.3);
    expect(f.convolvers).toHaveLength(1);
  });
});
