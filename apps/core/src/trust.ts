// SPDX-License-Identifier: AGPL-3.0-or-later
// Trust levels (S3.09, Q-L16, ad-003, G-04). An account earns levels 1 to 3 with its age, a verified
// email and activity (the days it joined a world); the thresholds are the core's setting
// FLATCHAT_CORE_TRUST, "days:active,days:active,days:active" for levels 1, 2 and 3. The owner may
// raise an account by hand (admin account EMAIL --trust N): the stored level is a floor, and
// levels 4 to 7 come only that way. The tester flag stays apart: the closed test's door. Worlds see
// the level in the connect token; uploads and strangers' views use it from Stage 4.

export interface TrustRule {
  /** The account's age in days. */
  days: number;
  /** Days on which it joined a world. */
  activeDays: number;
}

export const DEFAULT_TRUST: readonly TrustRule[] = [
  { days: 3, activeDays: 1 },
  { days: 14, activeDays: 5 },
  { days: 60, activeDays: 20 },
];

export class TrustError extends Error {}

/** FLATCHAT_CORE_TRUST: three `days:active` pairs, each no lower than the one before. */
export function parseTrust(text: string | undefined): TrustRule[] {
  if (!text) return [...DEFAULT_TRUST];
  const rules = text.split(',').map((pair) => {
    const m = /^\s*(\d{1,4}):(\d{1,4})\s*$/.exec(pair);
    if (!m) throw new TrustError(`FLATCHAT_CORE_TRUST: "${pair}" is not days:active`);
    return { days: Number(m[1]), activeDays: Number(m[2]) };
  });
  if (rules.length !== 3) throw new TrustError('FLATCHAT_CORE_TRUST: three levels, days:active each');
  for (let i = 1; i < rules.length; i++) {
    if (rules[i]!.days < rules[i - 1]!.days || rules[i]!.activeDays < rules[i - 1]!.activeDays) throw new TrustError('FLATCHAT_CORE_TRUST: each level asks at least as much as the one below');
  }
  return rules;
}

export interface TrustFacts {
  trust: number;
  emailVerified: boolean;
  createdAt: Date;
  activeDays: number;
}

/** The level an account has earned (0 to 3): none without a verified email. */
export function earnedTrust(a: TrustFacts, now: Date, rules: readonly TrustRule[] = DEFAULT_TRUST): number {
  if (!a.emailVerified) return 0;
  const age = (now.getTime() - a.createdAt.getTime()) / 86_400_000;
  let level = 0;
  for (const [i, r] of rules.entries()) if (age >= r.days && a.activeDays >= r.activeDays) level = i + 1;
  return level;
}

/** The level worlds see: what the owner set by hand, or what the account earned, whichever is higher. */
export function trustOf(a: TrustFacts, now: Date, rules: readonly TrustRule[] = DEFAULT_TRUST): number {
  return Math.min(7, Math.max(a.trust, earnedTrust(a, now, rules)));
}
