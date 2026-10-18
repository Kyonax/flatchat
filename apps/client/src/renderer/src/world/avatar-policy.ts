// SPDX-License-Identifier: MPL-2.0
// The viewer's policy over avatars (S4.05's first-launch tier, S4.09): every viewer decides what
// renders on their own screen. A tier measured on the first visit sets how many avatars this
// computer draws in full and the worst rank it draws in full; the viewer can change both, hide any
// person's avatar (shown as the impostor), and shield themselves from strangers below a trust
// level; and while frames are slow the frame-rate tuner (quality.ts, S6.08) draws fewer in full
// until they recover. Pure.
import type { AvatarSettings, Tier } from '../../../shared/settings';
import type { AvatarPolicy } from './avatar-layer';

export type MeasuredTier = Exclude<Tier, 'unset'>;

/** What each tier draws: in full, at LOD1 or LOD2, with spring bones, and the worst rank in full. */
export const TIER_POLICY: Record<MeasuredTier, { full: number; lower: number; springs: number; minRank: AvatarSettings['minRank'] }> = {
  low: { full: 4, lower: 12, springs: 2, minRank: 'good' },
  medium: { full: 8, lower: 20, springs: 6, minRank: 'medium' },
  high: { full: 12, lower: 28, springs: 8, minRank: 'poor' },
};

/** The first visit's measurement: frames over the first seconds in a world, as p95. */
export function tierOf(frameMs: readonly number[]): MeasuredTier {
  if (frameMs.length === 0) return 'medium';
  const sorted = [...frameMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  if (p95 <= 12) return 'high';
  if (p95 <= 22) return 'medium';
  return 'low';
}

export interface Viewer {
  accountOf(entity: number): string | undefined;
  trustOf(entity: number): number;
  friends: ReadonlySet<string>;
  me: number;
  /** Safe mode (S6.02, the safe-mode key): everyone else's avatar shows as its fallback. */
  safe?: boolean;
}

/** The layer's policy from the viewer's settings, the tier and the tuner. */
export function viewerPolicy(s: AvatarSettings, factor: number, viewer: Viewer): AvatarPolicy {
  const tier = TIER_POLICY[s.tier === 'unset' ? 'medium' : s.tier];
  const hidden = new Set(s.hidden);
  return {
    full: Math.max(0, Math.round(s.full * factor)),
    lower: Math.max(0, Math.round(tier.lower * factor)),
    springs: Math.max(0, Math.round(tier.springs * factor)),
    minRank: s.minRank,
    shown: (entity) => {
      if (entity === viewer.me) return 'full';
      if (viewer.safe) return 'impostor';
      const account = viewer.accountOf(entity);
      if (account && hidden.has(account)) return 'impostor';
      if (s.shield > 0 && viewer.trustOf(entity) < s.shield && !(account && viewer.friends.has(account))) return 'impostor';
      return 'full';
    },
  };
}
