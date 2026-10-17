// SPDX-License-Identifier: MPL-2.0
// Where spike S0.09's crowd stands (pure, so the tests can check it). The camera is a player at the
// origin, eyes at 1.6 m, looking along +z. The nearest avatars are drawn in full and all stand in
// view (the worst case); the ring is drawn at a lower level of detail, partly out of view; the rest
// are proxies all around, as the world server's tiers send them (near 15 m, ring 50 m, the rest).

export type Tier = 'full' | 'lod' | 'proxy';

export interface Placement {
  tier: Tier;
  /** Where the avatar's circle is centred, metres. */
  x: number;
  z: number;
  /** The circle it walks; 0 stands idle. */
  radius: number;
  /** Seconds into its walk cycle, so the crowd does not move in step. */
  phase: number;
  /** Turning direction of its circle: 1 or −1. */
  turn: number;
}

export interface CrowdCounts {
  full: number;
  lod: number;
  proxies: number;
}

/** Half the angle, from +z, inside which the full avatars stand: well inside a 60° vertical, 16:9 view. */
export const FULL_HALF_ANGLE = (35 * Math.PI) / 180;

export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function place(random: () => number, tier: Tier, minR: number, maxR: number, halfAngle: number): Placement {
  const r = minR + random() * (maxR - minR);
  const a = (random() * 2 - 1) * halfAngle;
  const idle = random() < 0.3;
  return {
    tier,
    x: Math.sin(a) * r,
    z: Math.cos(a) * r,
    // At most a quarter of the distance, so a circle stays within about 14.5° of its centre's bearing.
    radius: idle ? 0 : Math.min(0.6 + random() * 1.4, r / 4),
    phase: random() * 10,
    turn: random() < 0.5 ? 1 : -1,
  };
}

/** The crowd, nearest first: full avatars 2.5–12 m away in view, the ring 15–45 m, proxies 50–120 m all around. */
export function crowdLayout(counts: CrowdCounts, seed = 1): Placement[] {
  const random = seeded(seed);
  const out: Placement[] = [];
  for (let i = 0; i < counts.full; i++) out.push(place(random, 'full', 2.5, 12, FULL_HALF_ANGLE));
  for (let i = 0; i < counts.lod; i++) out.push(place(random, 'lod', 15, 45, (70 * Math.PI) / 180));
  for (let i = 0; i < counts.proxies; i++) out.push(place(random, 'proxy', 50, 120, Math.PI));
  return out;
}

/** Where an avatar is at time t: on its circle, facing the way it walks. */
export function positionAt(p: Placement, tSeconds: number, speed = 1.2): { x: number; z: number; yaw: number } {
  if (p.radius === 0) return { x: p.x, z: p.z, yaw: Math.PI };
  const angle = (p.turn * speed * (tSeconds + p.phase)) / p.radius;
  const x = p.x + Math.cos(angle) * p.radius;
  const z = p.z + Math.sin(angle) * p.radius;
  // The direction of travel, as a rotation about +y from +z.
  const dx = -Math.sin(angle) * p.turn;
  const dz = Math.cos(angle) * p.turn;
  return { x, z, yaw: Math.atan2(dx, dz) };
}
