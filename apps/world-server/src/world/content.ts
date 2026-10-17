// SPDX-License-Identifier: MPL-2.0
// A built world on disk (S2.03's output: world.json and content/<sha256>) and serving it to players
// over the world connection (S2.04, protocol version 2): `content` names world.json by its hash,
// players `fetch` what their cache lacks from any offset, and the server sends `chunk`s, paced per
// player and in total so downloads never starve the game.
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type BuiltWorld, type Collider, decodeColliders, parseBuiltWorld } from '@flatchat/content';
import { fromHex, toHex } from '@flatchat/protocol';
import type { Box } from '@flatchat/sim';

export const CHUNK_BYTES = 16_384;

export interface LoadedWorld {
  dir: string;
  world: BuiltWorld;
  /** world.json's bytes and SHA-256. */
  json: Uint8Array;
  hash: string;
  /** Every file a player may fetch, by hash: its path and size. */
  files: Map<string, { path: string; size: number }>;
  colliders: Collider[];
}

/** Reads a built world, checks world.json and every listed file's hash. */
export async function loadBuiltWorld(dir: string): Promise<LoadedWorld> {
  const json = new Uint8Array(await readFile(join(dir, 'world.json')));
  const parsed = parseBuiltWorld(JSON.parse(new TextDecoder().decode(json)));
  if ('error' in parsed) throw new Error(`world.json: ${parsed.error}`);
  const world = parsed.world;
  const hash = createHash('sha256').update(json).digest('hex');
  const files = new Map<string, { path: string; size: number }>([[hash, { path: join(dir, 'world.json'), size: json.length }]]);
  for (const f of world.files) {
    const path = join(dir, 'content', f.hash);
    const bytes = await readFile(path);
    if (bytes.length !== f.size || createHash('sha256').update(bytes).digest('hex') !== f.hash) throw new Error(`content/${f.hash} does not match world.json`);
    files.set(f.hash, { path, size: f.size });
  }
  const colliders = decodeColliders(new Uint8Array(await readFile(join(dir, 'content', world.collision))));
  return { dir, world, json, hash, files, colliders };
}

/** An axis-aligned box around each collider: what the server's height check needs (S1.08). */
export function boundsOf(colliders: readonly Collider[]): Box[] {
  return colliders.map((c) => {
    if (c.type === 'trimesh') {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < c.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, c.positions[i + k]!);
          max[k] = Math.max(max[k]!, c.positions[i + k]!);
        }
      }
      return { min: { x: min[0]!, y: min[1]!, z: min[2]! }, max: { x: max[0]!, y: max[1]!, z: max[2]! } };
    }
    const h = c.type === 'box' ? c.half : c.type === 'sphere' ? [c.radius, c.radius, c.radius] : [c.radius, c.halfHeight + (c.type === 'capsule' ? c.radius : 0), c.radius];
    // The rotated box's extent along each axis: |R| times the half extents.
    const [x, y, z, w] = c.rotation;
    const r = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    const e = r.map((row) => Math.abs(row[0]!) * h[0]! + Math.abs(row[1]!) * h[1]! + Math.abs(row[2]!) * h[2]!);
    return {
      min: { x: c.position[0] - e[0]!, y: c.position[1] - e[1]!, z: c.position[2] - e[2]! },
      max: { x: c.position[0] + e[0]!, y: c.position[1] + e[1]!, z: c.position[2] + e[2]! },
    };
  });
}

interface Fetch {
  hash: string;
  next: number;
  size: number;
  path: string;
}

export interface ContentSink {
  send(type: 'content' | 'chunk' | 'notFound', message: Record<string, unknown>): void;
}

/** Paces downloads: each player gets up to `perPlayer` bytes a second, everyone together `total`. */
export class ContentServer {
  readonly loaded: LoadedWorld;
  private readonly queues = new Map<ContentSink, Fetch[]>();
  private readonly perStep: number;
  private readonly totalPerStep: number;
  sentBytes = 0;

  constructor(loaded: LoadedWorld, o: { perPlayerBytesPerSec?: number; totalBytesPerSec?: number; stepsPerSec?: number } = {}) {
    this.loaded = loaded;
    const steps = o.stepsPerSec ?? 50;
    this.perStep = Math.max(CHUNK_BYTES, Math.floor((o.perPlayerBytesPerSec ?? 2_000_000) / steps));
    this.totalPerStep = Math.max(CHUNK_BYTES, Math.floor((o.totalBytesPerSec ?? 6_000_000) / steps));
  }

  /** Tells a joining player which world this is. */
  announce(sink: ContentSink): void {
    sink.send('content', { world: fromHex(this.loaded.hash), size: this.loaded.json.length });
  }

  fetch(sink: ContentSink, hashBytes: Uint8Array, from: number): void {
    const hash = toHex(hashBytes);
    const file = this.loaded.files.get(hash);
    if (!file) {
      sink.send('notFound', { hash: hashBytes });
      return;
    }
    const queue = (this.queues.get(sink) ?? []).filter((f) => f.hash !== hash);
    if (queue.length >= 64) return;
    queue.push({ hash, next: Math.min(from, file.size), size: file.size, path: file.path });
    this.queues.set(sink, queue);
  }

  unfetch(sink: ContentSink, hashBytes: Uint8Array): void {
    const hash = toHex(hashBytes);
    const queue = this.queues.get(sink);
    if (queue) this.queues.set(sink, queue.filter((f) => f.hash !== hash));
  }

  forget(sink: ContentSink): void {
    this.queues.delete(sink);
  }

  get pending(): number {
    return [...this.queues.values()].reduce((n, q) => n + q.length, 0);
  }

  /** One pacing step (call it 50 times a second): each player's first fetch moves on. */
  async step(): Promise<void> {
    let total = this.totalPerStep;
    for (const [sink, queue] of this.queues) {
      if (total <= 0) break;
      let budget = Math.min(this.perStep, total);
      while (budget > 0 && queue.length > 0) {
        const f = queue[0]!;
        const length = Math.min(CHUNK_BYTES, f.size - f.next, budget);
        const data = new Uint8Array(length);
        if (length > 0) {
          const handle = await open(f.path, 'r');
          try {
            await handle.read(data, 0, length, f.next);
          } finally {
            await handle.close();
          }
        }
        sink.send('chunk', { hash: fromHex(f.hash), offset: f.next, total: f.size, data });
        f.next += length;
        budget -= Math.max(length, 1);
        total -= length;
        this.sentBytes += length;
        if (f.next >= f.size) queue.shift();
      }
      if (queue.length === 0) this.queues.delete(sink);
    }
  }
}
