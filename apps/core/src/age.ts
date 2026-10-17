// SPDX-License-Identifier: AGPL-3.0-or-later
// The age rule (S1.03, rr-015, OQ-16). Sign-up asks for the birth month and year and the country,
// with no hint of any limit. Under 13 is refused everywhere and nothing is kept. Until Stage 3's
// protections ship (the guardian link, teen-safe defaults), accounts are for adults only; after
// that, 13 to 17 needs a guardian, Australia stays 16 and over, and Brazilian minors wait (B-20).
// Without the day, an age is counted as if the birthday were the last day of its month, so a
// doubtful case is always the younger one.

export interface BirthFacts {
  year: number;
  month: number;
  country: string;
}

export interface AgePolicy {
  /** On once Stage 3's protections for minors ship (S3.04, S3.10); off in Stage 1. */
  minors: boolean;
}

export type AgeRefusal = 'invalid' | 'under-13' | 'minors-not-yet' | 'under-16-here' | 'minors-wait-here';

export type AgeVerdict = { ok: true; age: number; minor: boolean } | { ok: false; reason: AgeRefusal };

/** Completed years on `today`, counting the birthday as the last day of the birth month. */
export function ageOn(year: number, month: number, today: Date): number {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  return y - year - (m <= month ? 1 : 0);
}

/** Whether an account is under 18 today: the only age fact a world ever sees (S3.10). */
export function isMinor(year: number, month: number, today: Date): boolean {
  return ageOn(year, month, today) < 18;
}

export function ageRule(birth: BirthFacts, today: Date, policy: AgePolicy): AgeVerdict {
  const { year, month } = birth;
  const country = birth.country.toUpperCase();
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 1900) return { ok: false, reason: 'invalid' };
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, reason: 'invalid' };
  const thisMonth = today.getUTCFullYear() * 12 + today.getUTCMonth();
  if (year * 12 + (month - 1) > thisMonth) return { ok: false, reason: 'invalid' };
  const age = ageOn(year, month, today);
  if (age < 13) return { ok: false, reason: 'under-13' };
  if (age >= 18) return { ok: true, age, minor: false };
  if (country === 'AU' && age < 16) return { ok: false, reason: 'under-16-here' };
  if (country === 'BR') return { ok: false, reason: 'minors-wait-here' };
  if (!policy.minors) return { ok: false, reason: 'minors-not-yet' };
  return { ok: true, age, minor: true };
}
