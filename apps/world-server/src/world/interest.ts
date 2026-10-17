// SPDX-License-Identifier: MPL-2.0
// Interest tiers (the plan's REPLICATION AND INTEREST MANAGEMENT, dp-008): a viewer receives each
// busy cell by its distance to the cell: near cells in full every tick, the next ring in full at
// a quarter of the rate, everything else as coarse positions once a second. The tier depends on
// the distance to the cell's square, not to each avatar, so a cell is encoded once per tick for
// all viewers. Each viewer's slower tiers run on its own phase, which spreads them over the ticks.

export type Tier = 'near' | 'ring' | 'far';

export interface InterestConfig {
  /** Cells within this distance (metres) are near. */
  nearM: number;
  /** Cells within this distance are the ring; farther ones are far. */
  ringM: number;
  /** Send near cells every this many ticks (1 = every tick). */
  nearEvery: number;
  ringEvery: number;
  farEvery: number;
}

/** At 20 Hz: near at 20 Hz within 15 m, the ring at 5 Hz to 50 m, the rest at 1 Hz. */
export const DEFAULT_INTEREST: InterestConfig = { nearM: 15, ringM: 50, nearEvery: 1, ringEvery: 4, farEvery: 20 };

export function tierFor(distance: number, cfg: InterestConfig = DEFAULT_INTEREST): Tier {
  if (distance <= cfg.nearM) return 'near';
  if (distance <= cfg.ringM) return 'ring';
  return 'far';
}

/** Whether a viewer with this phase receives a cell of this tier on this tick. */
export function isDue(tier: Tier, tick: number, phase: number, cfg: InterestConfig = DEFAULT_INTEREST): boolean {
  const every = tier === 'near' ? cfg.nearEvery : tier === 'ring' ? cfg.ringEvery : cfg.farEvery;
  return (tick + phase) % every === 0;
}

/** Near and ring cells carry full avatars; far cells only coarse positions. */
export function formFor(tier: Tier): 'full' | 'coarse' {
  return tier === 'far' ? 'coarse' : 'full';
}
