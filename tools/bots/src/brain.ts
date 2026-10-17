// SPDX-License-Identifier: MPL-2.0
// How a bot moves: social hubs it gathers in, mingling inside a hub, idling (sometimes seated),
// and now and then a walk or a run to another hub. Deterministic for a seed, and pure: the caller
// passes the elapsed time, so tests step it without a clock.
//
// Scenarios: `hubs` spreads the players over six gathering places (a lively world); `crowd` puts
// everyone around one 15 m stage (the worst case for interest management: everyone is near);
// `plaza` gathers them at Stage 1's greybox plaza (packages/sim): the fountain, the stage, the
// platforms, walking at the paving's height (they pass through benches: load, not looks).
// Yaw follows packages/sim: 0 faces -z.
import { PLAZA } from '@flatchat/sim';
import { seededRandom } from '@flatchat/world-server/metrics';

export type Scenario = 'hubs' | 'crowd' | 'plaza';
export type Stance = 'standing' | 'sitting';

export interface Hub {
  x: number;
  z: number;
  r: number;
}

export interface BrainConfig {
  size: number;
  scenario: Scenario;
  walk: number;
  run: number;
}

export const DEFAULT_BRAIN: BrainConfig = { size: 256, scenario: 'hubs', walk: 1.4, run: 4 };

const C = PLAZA.size / 2;
const PLAZA_HUBS: Hub[] = [
  { x: C, z: C + 9, r: 4 },
  { x: C, z: C - 9, r: 5 },
  { x: C - 10, z: C, r: 3 },
  { x: C + 10, z: C, r: 3 },
  { x: C, z: C + 18, r: 6 },
  { x: C - 18, z: C + 8, r: 3 },
];

/** The height a plaza bot walks at: the paving inside the square, the ground outside. */
export function plazaHeight(x: number, z: number): number {
  return Math.abs(x - C) <= 24 && Math.abs(z - C) <= 24 ? 0.15 : 0;
}

export function hubsFor(size: number, scenario: Scenario): Hub[] {
  if (scenario === 'crowd') return [{ x: size / 2, z: size / 2, r: 15 }];
  if (scenario === 'plaza') return PLAZA_HUBS;
  const r = Math.max(6, size * 0.05);
  return [
    [0.2, 0.25],
    [0.5, 0.18],
    [0.82, 0.3],
    [0.22, 0.72],
    [0.55, 0.58],
    [0.8, 0.82],
  ].map(([fx, fz]) => ({ x: (fx ?? 0) * size, z: (fz ?? 0) * size, r }));
}

export interface PoseOut {
  x: number;
  y: number;
  z: number;
  yaw: number;
  look: number;
  stance: Stance;
}

type Mode = { kind: 'travel'; tx: number; tz: number; speed: number } | { kind: 'idle'; left: number; turnIn: number };

export class Brain {
  readonly config: BrainConfig;
  readonly hubs: Hub[];
  private readonly random: () => number;
  private readonly wanderer: boolean;
  private hub: number;
  private x: number;
  private z: number;
  private yaw = 0;
  private look = 0;
  private stance: Stance = 'standing';
  private mode: Mode;

  constructor(seed: number, config: BrainConfig, start: { x: number; z: number }) {
    this.config = config;
    this.hubs = hubsFor(config.size, config.scenario);
    this.random = seededRandom(seed);
    this.wanderer = this.random() < 0.2;
    this.hub = Math.floor(this.random() * this.hubs.length);
    this.x = start.x;
    this.z = start.z;
    this.mode = this.travelTo(this.hub, this.random() < 0.3);
  }

  /** The server put the player somewhere (its spawn, or a correction): continue from there. */
  teleport(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
  }

  step(dt: number): PoseOut {
    if (this.mode.kind === 'travel') {
      const dx = this.mode.tx - this.x;
      const dz = this.mode.tz - this.z;
      const dist = Math.hypot(dx, dz);
      const move = this.mode.speed * dt;
      this.stance = 'standing';
      if (dist <= move || dist < 0.05) {
        this.x = this.mode.tx;
        this.z = this.mode.tz;
        this.mode = { kind: 'idle', left: 3 + this.random() * 12, turnIn: 1 + this.random() * 3 };
        if (this.random() < 0.15) this.stance = 'sitting';
      } else {
        this.x += (dx / dist) * move;
        this.z += (dz / dist) * move;
        this.yaw = Math.atan2(-dx, -dz);
      }
    } else {
      this.mode.left -= dt;
      this.mode.turnIn -= dt;
      if (this.mode.turnIn <= 0) {
        this.yaw = this.random() * Math.PI * 2 - Math.PI;
        this.look = (this.random() - 0.5) * 0.8;
        this.mode.turnIn = 1 + this.random() * 4;
      }
      if (this.mode.left <= 0) {
        const leave = this.config.scenario !== 'crowd' && this.random() < (this.wanderer ? 0.6 : 0.25);
        if (leave) this.hub = (this.hub + 1 + Math.floor(this.random() * (this.hubs.length - 1))) % this.hubs.length;
        this.mode = this.travelTo(this.hub, leave && this.random() < 0.3);
      }
    }
    const y = this.config.scenario === 'plaza' ? plazaHeight(this.x, this.z) : 0;
    return { x: this.x, y, z: this.z, yaw: this.yaw, look: this.look, stance: this.stance };
  }

  private travelTo(hub: number, running: boolean): Mode {
    const h = this.hubs[hub] ?? this.hubs[0]!;
    const angle = this.random() * Math.PI * 2;
    const radius = Math.sqrt(this.random()) * h.r;
    const edge = this.config.size - 0.01;
    return {
      kind: 'travel',
      tx: Math.min(edge, Math.max(0, h.x + Math.cos(angle) * radius)),
      tz: Math.min(edge, Math.max(0, h.z + Math.sin(angle) * radius)),
      speed: running ? this.config.run : this.config.walk,
    };
  }
}
