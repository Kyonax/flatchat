// SPDX-License-Identifier: MPL-2.0
// One world's replicated state: the players, the poses they send, the grid of cells they stand
// in, and the snapshots each viewer receives on a tick. Pure: no sockets and no clock (the caller
// passes the time), so tests drive it tick by tick.
//
// The rule that keeps 200 players cheap (dp-008, S0.07): each busy cell is encoded at most once
// per form (full or coarse) per tick, and those bytes are copied into every snapshot that needs
// them, so the encodings follow the busy cells, never the viewers.
import { CELL_SIZE, encodeCellBlock, encodeMessage, type MessageBody, type STANCES } from '@flatchat/protocol';
import { type Box, checkMove, DEFAULT_LIMITS } from '@flatchat/sim';
import { cellKey, cellOf, distanceToCell, keyCx, keyCz } from './grid.ts';
import { DEFAULT_INTEREST, formFor, type InterestConfig, isDue, type Tier, tierFor } from './interest.ts';

export type Stance = (typeof STANCES)[number];
export type Pose = MessageBody<'pose'>;
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Correction {
  seq: number;
  position: Vec3;
  yaw: number;
}

export interface Player {
  readonly entity: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  look: number;
  stance: Stance;
  /** The last pose sequence applied, echoed in snapshots as `ack`. */
  ack: number | undefined;
  /** When the last pose was applied, or the player joined (ms, the caller's clock). */
  lastPoseAt: number;
  /** The cell the player stands in (a grid key). */
  cell: number;
  /** Sent in the next snapshot: where the server put the player (spawn, or a refused pose). */
  correction: Correction | undefined;
  /** True until the player's first snapshot, which carries every busy cell (the join snapshot). */
  needsAll: boolean;
  /** Spreads this viewer's slower tiers over the ticks. */
  readonly phase: number;
}

export interface WorldConfig {
  /** The world is the square [0, size) in x and z, in metres. */
  size: number;
  /** Fastest accepted ground speed, m/s (packages/sim: running plus a margin). */
  maxSpeed: number;
  /** Metres of tolerance on each pose's checks. */
  speedSlack: number;
  /** The world's solid boxes, for the height check; none means flat ground at y = 0. */
  solids: readonly Box[];
  /** Whether players may fly; otherwise a pose rising above a jump's reach is corrected. */
  flying: boolean;
  interest: InterestConfig;
  /** Target size of one snapshot message, so each fits one datagram. */
  maxSnapshotBytes: number;
  /** Avatars per block; a fuller cell is split into several blocks with the same cx and cz. */
  maxFullPerBlock: number;
  maxCoarsePerBlock: number;
}

export const DEFAULT_WORLD: WorldConfig = {
  size: 256,
  maxSpeed: DEFAULT_LIMITS.maxSpeed,
  speedSlack: DEFAULT_LIMITS.slack,
  solids: [],
  flying: false,
  interest: DEFAULT_INTEREST,
  maxSnapshotBytes: 1100,
  maxFullPerBlock: 96,
  maxCoarsePerBlock: 160,
};

export type PoseOutcome = 'applied' | 'corrected' | 'stale' | 'unknown';

export interface TickStats {
  tick: number;
  /** Cells with at least one player. */
  busyCells: number;
  /** Cell-block encodings this tick: the state serialisations. */
  encodings: number;
  /** Snapshot messages assembled, their bytes, and the largest one. */
  messages: number;
  bytes: number;
  largest: number;
  /** Viewers who received their join snapshot this tick, with its size in bytes. */
  joins: Array<{ entity: number; bytes: number; messages: number }>;
}

export interface TickOutput {
  /** The encoded snapshot messages for each viewer, in sending order. */
  snapshots: Map<number, Uint8Array[]>;
  stats: TickStats;
}

const TIER_ORDER: Record<Tier, number> = { near: 0, ring: 1, far: 2 };
const Y_MIN = -100;
const Y_MAX = 500;
const LIST_OVERHEAD = 3;
const HEADER_ALLOWANCE = 40;

export class World {
  readonly config: WorldConfig;
  readonly players = new Map<number, Player>();
  private readonly cells = new Map<number, Set<number>>();

  constructor(config: Partial<WorldConfig> = {}) {
    this.config = { ...DEFAULT_WORLD, ...config };
  }

  add(entity: number, spawn: Vec3, yaw: number, now: number): Player {
    if (this.players.has(entity)) throw new Error(`entity ${entity} is already in the world`);
    const x = this.clampGround(spawn.x);
    const z = this.clampGround(spawn.z);
    const y = Math.min(Y_MAX, Math.max(Y_MIN, spawn.y));
    const player: Player = {
      entity,
      x,
      y,
      z,
      yaw,
      look: 0,
      stance: 'standing',
      ack: undefined,
      lastPoseAt: now,
      cell: cellKey(cellOf(x), cellOf(z)),
      correction: { seq: 0, position: { x, y, z }, yaw },
      needsAll: true,
      phase: entity % this.config.interest.farEvery,
    };
    this.players.set(entity, player);
    this.enter(player.cell, entity);
    return player;
  }

  remove(entity: number): boolean {
    const player = this.players.get(entity);
    if (!player) return false;
    this.leave(player.cell, entity);
    this.players.delete(entity);
    return true;
  }

  /** Applies a client's pose, or refuses it and queues a correction (sf-004: the server checks). */
  applyPose(entity: number, pose: Pose, now: number): PoseOutcome {
    const player = this.players.get(entity);
    if (!player) return 'unknown';
    if (player.ack !== undefined) {
      const ahead = (pose.seq - player.ack) & 0xffff;
      if (ahead === 0 || ahead >= 0x8000) return 'stale';
    }
    const dt = Math.max(0, now - player.lastPoseAt) / 1000;
    const nx = this.clampGround(pose.position.x);
    const nz = this.clampGround(pose.position.z);
    const ny = Math.min(Y_MAX, Math.max(Y_MIN, pose.position.y));
    player.ack = pose.seq;
    player.lastPoseAt = now;
    const limits = { maxSpeed: this.config.maxSpeed, slack: this.config.speedSlack, flying: this.config.flying, reach: DEFAULT_LIMITS.reach };
    if (checkMove(player, { x: nx, y: ny, z: nz }, dt, limits, this.config.solids) !== 'ok') {
      player.correction = { seq: pose.seq, position: { x: player.x, y: player.y, z: player.z }, yaw: player.yaw };
      return 'corrected';
    }
    player.x = nx;
    player.y = ny;
    player.z = nz;
    player.yaw = pose.yaw;
    player.look = pose.look;
    player.stance = pose.stance;
    const cell = cellKey(cellOf(nx), cellOf(nz));
    if (cell !== player.cell) {
      this.leave(player.cell, entity);
      this.enter(cell, entity);
      player.cell = cell;
    }
    return 'applied';
  }

  /** Puts a player somewhere the server allowed (a seat, a teleport, S2.06). Poses sent from the old
   *  place before the client heard of it are corrected back to here. */
  place(entity: number, at: Vec3, yaw: number, stance: Player['stance'], now: number): boolean {
    const player = this.players.get(entity);
    if (!player) return false;
    player.x = this.clampGround(at.x);
    player.z = this.clampGround(at.z);
    player.y = Math.min(Y_MAX, Math.max(Y_MIN, at.y));
    player.yaw = yaw;
    player.stance = stance;
    player.lastPoseAt = now;
    const cell = cellKey(cellOf(player.x), cellOf(player.z));
    if (cell !== player.cell) {
      this.leave(player.cell, entity);
      this.enter(cell, entity);
      player.cell = cell;
    }
    return true;
  }

  /** Players within `radius` metres of a point, nearest first, with their squared distances. */
  near(x: number, z: number, radius: number, except?: number): Array<{ player: Player; d2: number }> {
    const found: Array<{ player: Player; d2: number }> = [];
    const r2 = radius * radius;
    for (let cx = cellOf(x - radius); cx <= cellOf(x + radius); cx++) {
      for (let cz = cellOf(z - radius); cz <= cellOf(z + radius); cz++) {
        const members = this.cells.get(cellKey(cx, cz));
        if (!members) continue;
        for (const entity of members) {
          if (entity === except) continue;
          const player = this.players.get(entity);
          if (!player) continue;
          const d2 = (player.x - x) ** 2 + (player.z - z) ** 2;
          if (d2 <= r2) found.push({ player, d2 });
        }
      }
    }
    found.sort((a, b) => a.d2 - b.d2);
    return found;
  }

  /** Builds every viewer's snapshot messages for one tick. */
  tick(tick: number): TickOutput {
    const { interest, maxSnapshotBytes } = this.config;
    const full = new Map<number, Uint8Array[]>();
    const coarse = new Map<number, Uint8Array[]>();
    let encodings = 0;
    const blocksOf = (key: number, form: 'full' | 'coarse'): Uint8Array[] => {
      const cache = form === 'full' ? full : coarse;
      let blocks = cache.get(key);
      if (!blocks) {
        blocks = this.encodeCell(key, form);
        encodings += blocks.length;
        cache.set(key, blocks);
      }
      return blocks;
    };

    const busy: Array<{ key: number; cx: number; cz: number }> = [];
    for (const [key, members] of this.cells) {
      if (members.size > 0) busy.push({ key, cx: keyCx(key), cz: keyCz(key) });
    }

    const stats: TickStats = { tick, busyCells: busy.length, encodings: 0, messages: 0, bytes: 0, largest: 0, joins: [] };
    const snapshots = new Map<number, Uint8Array[]>();
    for (const viewer of this.players.values()) {
      const due: Array<{ order: number; block: Uint8Array }> = [];
      for (const cell of busy) {
        const tier = tierFor(distanceToCell(viewer.x, viewer.z, cell.cx, cell.cz), interest);
        if (!viewer.needsAll && !isDue(tier, tick, viewer.phase, interest)) continue;
        for (const block of blocksOf(cell.key, formFor(tier))) due.push({ order: TIER_ORDER[tier], block });
      }
      due.sort((a, b) => a.order - b.order);
      const messages = this.pack(
        tick,
        viewer,
        due.map((d) => d.block),
        maxSnapshotBytes,
      );
      if (messages.length > 0) snapshots.set(viewer.entity, messages);
      let bytes = 0;
      for (const m of messages) {
        bytes += m.length;
        if (m.length > stats.largest) stats.largest = m.length;
      }
      stats.messages += messages.length;
      stats.bytes += bytes;
      if (viewer.needsAll) {
        stats.joins.push({ entity: viewer.entity, bytes, messages: messages.length });
        viewer.needsAll = false;
      }
      // The spawn (sequence 0) repeats until the player's first pose shows it arrived: snapshots go
      // on the unreliable channel, and a client that lost it would not know where it stands.
      if (viewer.correction?.seq !== 0 || viewer.ack !== undefined) viewer.correction = undefined;
    }
    stats.encodings = encodings;
    return { snapshots, stats };
  }

  private pack(tick: number, viewer: Player, blocks: Uint8Array[], limit: number): Uint8Array[] {
    // A viewer with nothing due still gets its ack and any correction, in one small message.
    const needsHeader = viewer.ack !== undefined || viewer.correction !== undefined;
    if (blocks.length === 0 && !needsHeader) return [];
    const groups: Uint8Array[][] = [];
    let group: Uint8Array[] = [];
    let size = HEADER_ALLOWANCE;
    for (const block of blocks) {
      const add = block.length + LIST_OVERHEAD;
      if (group.length > 0 && size + add > limit) {
        groups.push(group);
        group = [];
        size = HEADER_ALLOWANCE;
      }
      group.push(block);
      size += add;
    }
    if (group.length > 0 || groups.length === 0) groups.push(group);
    return groups.map((g, i) =>
      encodeMessage({
        type: 'snapshot',
        tick,
        ...(i === 0 && viewer.ack !== undefined ? { ack: viewer.ack } : {}),
        ...(i === 0 && viewer.correction !== undefined ? { correction: viewer.correction } : {}),
        blocks: g,
      }),
    );
  }

  private encodeCell(key: number, form: 'full' | 'coarse'): Uint8Array[] {
    const members = this.cells.get(key);
    if (!members || members.size === 0) return [];
    const cx = keyCx(key);
    const cz = keyCz(key);
    const x0 = cx * CELL_SIZE;
    const z0 = cz * CELL_SIZE;
    const entities = [...members].sort((a, b) => a - b);
    const per = form === 'full' ? this.config.maxFullPerBlock : this.config.maxCoarsePerBlock;
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < entities.length; i += per) {
      const chunk: Player[] = [];
      for (const entity of entities.slice(i, i + per)) {
        const p = this.players.get(entity);
        if (p) chunk.push(p);
      }
      blocks.push(
        encodeCellBlock(
          form === 'full'
            ? {
                cx,
                cz,
                full: chunk.map((p) => ({ id: p.entity, x: p.x - x0, y: p.y, z: p.z - z0, yaw: p.yaw, look: p.look, stance: p.stance })),
                coarse: [],
              }
            : { cx, cz, full: [], coarse: chunk.map((p) => ({ id: p.entity, x: p.x - x0, y: p.y, z: p.z - z0, yaw: p.yaw })) },
        ),
      );
    }
    return blocks;
  }

  private clampGround(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.min(this.config.size - 1 / 128, Math.max(0, v));
  }

  private enter(key: number, entity: number): void {
    let members = this.cells.get(key);
    if (!members) {
      members = new Set();
      this.cells.set(key, members);
    }
    members.add(entity);
  }

  private leave(key: number, entity: number): void {
    const members = this.cells.get(key);
    if (!members) return;
    members.delete(entity);
    if (members.size === 0) this.cells.delete(key);
  }
}
