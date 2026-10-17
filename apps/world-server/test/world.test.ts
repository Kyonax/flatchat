// SPDX-License-Identifier: MPL-2.0
// The world's pure parts: the grid, the interest tiers, pose checks, snapshots and voice routing.
import { CELL_SIZE, decodeCellBlock, decodeMessage, type MessageOf } from '@flatchat/protocol';
import { describe, expect, it } from 'vitest';
import { cellKey, cellOf, distanceToCell, keyCx, keyCz } from '../src/world/grid.ts';
import { DEFAULT_INTEREST, isDue, tierFor } from '../src/world/interest.ts';
import { VoiceRouter } from '../src/world/voice.ts';
import { World } from '../src/world/world.ts';

const pose = (seq: number, x: number, z: number, y = 0): MessageOf<'pose'> => ({ type: 'pose', seq, position: { x, y, z }, yaw: 0, look: 0, stance: 'standing' });
const mouth = { aa: 1, ih: 2, ou: 3, ee: 4, oh: 5, level: 6 };

function snapshotsOf(bytes: Uint8Array[]): Array<MessageOf<'snapshot'>> {
  return bytes.map((b) => decodeMessage(b, 'server') as MessageOf<'snapshot'>);
}

function seen(bytes: Uint8Array[]): Map<number, 'full' | 'coarse'> {
  const out = new Map<number, 'full' | 'coarse'>();
  for (const s of snapshotsOf(bytes)) {
    for (const block of s.blocks) {
      const b = decodeCellBlock(block);
      for (const e of b.full) out.set(e.id, 'full');
      for (const e of b.coarse) if (!out.has(e.id)) out.set(e.id, 'coarse');
    }
  }
  return out;
}

describe('the grid', () => {
  it('maps coordinates to 32 m cells and keys back', () => {
    expect(CELL_SIZE).toBe(32);
    expect([cellOf(0), cellOf(31.99), cellOf(32), cellOf(-0.01)]).toEqual([0, 0, 1, -1]);
    for (const [cx, cz] of [[0, 0], [7, -3], [-32768, 32767]] as const) {
      const key = cellKey(cx, cz);
      expect([keyCx(key), keyCz(key)]).toEqual([cx, cz]);
    }
  });

  it('measures the distance from a point to a cell', () => {
    expect(distanceToCell(10, 10, 0, 0)).toBe(0);
    expect(distanceToCell(40, 10, 0, 0)).toBe(8);
    expect(distanceToCell(35, 36, 0, 0)).toBe(5);
  });

  it('puts near, ring and far cells on their own rates and phases', () => {
    expect([tierFor(0), tierFor(15), tierFor(15.1), tierFor(50), tierFor(50.1)]).toEqual(['near', 'near', 'ring', 'ring', 'far']);
    const due = (tier: 'near' | 'ring' | 'far', phase: number): number => [...Array(20).keys()].filter((t) => isDue(tier, t, phase, DEFAULT_INTEREST)).length;
    expect([due('near', 3), due('ring', 3), due('far', 3)]).toEqual([20, 5, 1]);
    expect(isDue('far', 17, 3)).toBe(true);
  });
});

describe('poses', () => {
  it('applies a pose within the speed limit and moves the player between cells', () => {
    const world = new World();
    world.add(1, { x: 31, y: 0, z: 10 }, 0, 0);
    expect(world.applyPose(1, pose(1, 33, 10), 1000)).toBe('applied');
    expect(world.players.get(1)).toMatchObject({ x: 33, z: 10, ack: 1 });
    expect(world.near(33, 10, 1).map((n) => n.player.entity)).toEqual([1]);
  });

  it('corrects a pose that moves too fast and keeps the old position', () => {
    const world = new World();
    world.add(1, { x: 10, y: 0, z: 10 }, 0, 0);
    expect(world.applyPose(1, pose(1, 60, 10), 100)).toBe('corrected');
    expect(world.players.get(1)).toMatchObject({ x: 10, ack: 1, correction: { seq: 1, position: { x: 10, z: 10 } } });
  });

  it('ignores stale or repeated poses, across the 16-bit wrap', () => {
    const world = new World();
    world.add(1, { x: 10, y: 0, z: 10 }, 0, 0);
    expect(world.applyPose(1, pose(65_535, 10.5, 10), 1000)).toBe('applied');
    expect(world.applyPose(1, pose(65_535, 11, 10), 2000)).toBe('stale');
    expect(world.applyPose(1, pose(65_000, 11, 10), 2000)).toBe('stale');
    expect(world.applyPose(1, pose(0, 11, 10), 2000)).toBe('applied');
  });

  it('keeps players inside the world', () => {
    const world = new World({ size: 64 });
    world.add(1, { x: -5, y: 0, z: 70 }, 0, 0);
    const p = world.players.get(1)!;
    expect(p.x).toBe(0);
    expect(p.z).toBeLessThan(64);
  });
});

describe('snapshots', () => {
  it('gives a joining player every busy cell, with its spawn as a correction', () => {
    const world = new World();
    world.add(1, { x: 10, y: 0, z: 10 }, 0, 0);
    world.add(2, { x: 200, y: 0, z: 200 }, 0, 0);
    const { snapshots, stats } = world.tick(1);
    expect(stats.joins.map((j) => j.entity).sort()).toEqual([1, 2]);
    const mine = snapshots.get(1)!;
    expect(snapshotsOf(mine)[0]?.correction).toMatchObject({ seq: 0, position: { x: 10, z: 10 } });
    expect(seen(mine)).toEqual(new Map([[1, 'full'], [2, 'coarse']]));
  });

  it('repeats the spawn until the first pose arrives (snapshots can be lost)', () => {
    const world = new World();
    world.add(1, { x: 10, y: 0, z: 10 }, 0, 0);
    expect(snapshotsOf(world.tick(1).snapshots.get(1)!)[0]?.correction?.seq).toBe(0);
    expect(snapshotsOf(world.tick(2).snapshots.get(1)!)[0]?.correction?.seq).toBe(0);
    world.applyPose(1, pose(1, 10, 10), 100);
    expect(snapshotsOf(world.tick(3).snapshots.get(1)!)[0]).toMatchObject({ ack: 1, correction: { seq: 0 } });
    expect(snapshotsOf(world.tick(4).snapshots.get(1)!)[0]?.correction).toBeUndefined();
  });

  it('then sends near cells every tick, the ring every fourth and far cells once a second', () => {
    const world = new World();
    world.add(20, { x: 20, y: 0, z: 16 }, 0, 0); // the viewer; its phase is 20 % 20 = 0
    world.add(2, { x: 40, y: 0, z: 16 }, 0, 0); // its cell starts 12 m away: near
    world.add(3, { x: 70, y: 0, z: 16 }, 0, 0); // 44 m: the ring
    world.add(4, { x: 200, y: 0, z: 200 }, 0, 0); // far
    world.tick(0);
    const counts = { 2: 0, 3: 0, 4: 0 };
    for (let t = 1; t <= 20; t++) {
      const got = seen(world.tick(t).snapshots.get(20)!);
      for (const id of [2, 3, 4] as const) if (got.has(id)) counts[id] += 1;
    }
    expect(counts).toEqual({ 2: 20, 3: 5, 4: 1 });
  });

  it('encodes each busy cell once per form, however many players watch it', () => {
    const world = new World();
    let id = 1;
    for (let i = 0; i < 40; i++) world.add(id++, { x: 5 + (i % 8), y: 0, z: 5 + Math.floor(i / 8) }, 0, 0);
    for (let i = 0; i < 40; i++) world.add(id++, { x: 230 + (i % 8), y: 0, z: 230 + Math.floor(i / 8) }, 0, 0);
    world.tick(0);
    const { stats } = world.tick(1);
    expect(stats.busyCells).toBe(2);
    expect(stats.encodings).toBeLessThanOrEqual(4);
    expect(stats.messages).toBeGreaterThanOrEqual(80);
  });

  it('keeps snapshot messages near the datagram size by splitting crowded cells', () => {
    const world = new World();
    for (let i = 1; i <= 200; i++) world.add(i, { x: 1 + (i % 30), y: 0, z: 1 + Math.floor(i / 8) }, 0, 0);
    const { snapshots, stats } = world.tick(0);
    expect(stats.largest).toBeLessThan(1400);
    expect(seen(snapshots.get(1)!).size).toBe(200);
  });
});

describe('voice routing', () => {
  it('bundles the nearest speakers in range, never the listener itself', () => {
    const world = new World();
    world.add(1, { x: 100, y: 0, z: 100 }, 0, 0);
    for (let i = 2; i <= 20; i++) world.add(i, { x: 100 + i, y: 0, z: 100 }, 0, 0);
    world.add(30, { x: 140, y: 0, z: 100 }, 0, 0);
    const router = new VoiceRouter();
    for (const from of [1, 30, ...Array.from({ length: 19 }, (_, k) => k + 2)]) router.push({ from, seq: 1, start: true, mouth, opus: new Uint8Array(60) });
    const { bundles, stats } = router.step(world);
    const heard = (decodeMessage(bundles.get(1)!, 'server') as MessageOf<'voiceBundle'>).frames.map((f) => f.from);
    expect(heard).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(stats.speakers).toBe(21);
  });

  it('forwards one frame per speaker per step, keeping bunched frames in order', () => {
    const world = new World();
    world.add(1, { x: 10, y: 0, z: 10 }, 0, 0);
    world.add(2, { x: 12, y: 0, z: 10 }, 0, 0);
    const router = new VoiceRouter();
    router.push({ from: 2, seq: 7, start: true, mouth, opus: new Uint8Array(10) });
    router.push({ from: 2, seq: 8, start: false, mouth, opus: new Uint8Array(10) });
    const first = decodeMessage(router.step(world).bundles.get(1)!, 'server') as MessageOf<'voiceBundle'>;
    const second = decodeMessage(router.step(world).bundles.get(1)!, 'server') as MessageOf<'voiceBundle'>;
    expect([first.frames[0]?.seq, second.frames[0]?.seq]).toEqual([7, 8]);
    expect(router.step(world).bundles.size).toBe(0);
  });
});
