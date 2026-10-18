// SPDX-License-Identifier: Apache-2.0
// The gallery's licence fields (S5.06, ad-008, Q-J4): VRM 1.0's terms, which every avatar maker
// already knows, stated for every avatar and item published in the free gallery. Who may wear it
// (the gallery takes only `everyone`), whether the authors must be credited where it shows, whether
// others may re-upload it or change it, commercial use, and the four usage permissions; a licence
// link. Every field is required: nothing is assumed. An avatar's file states its own terms (its
// VRM meta, kept in its manifest): its publisher may make them stricter, never looser. Shared by
// the core (which enforces them) and the client (which shows them).

export const AVATAR_PERMISSIONS = ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'] as const;
export const COMMERCIAL_USAGES = ['personalNonProfit', 'personalProfit', 'corporation'] as const;
export const CREDIT_NOTATIONS = ['required', 'unnecessary'] as const;
export const MODIFICATIONS = ['prohibited', 'allowModification', 'allowModificationRedistribution'] as const;
export const USAGE_FLAGS = ['allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage', 'allowPoliticalOrReligiousUsage', 'allowAntisocialOrHateUsage'] as const;

export interface Licence {
  /** Who may wear it. */
  avatarPermission: (typeof AVATAR_PERMISSIONS)[number];
  commercialUsage: (typeof COMMERCIAL_USAGES)[number];
  /** Whether its authors must be named where it is shown. */
  creditNotation: (typeof CREDIT_NOTATIONS)[number];
  /** Whether others may upload a copy of it as theirs. */
  allowRedistribution: boolean;
  /** Whether others may change it, and share what they changed. */
  modification: (typeof MODIFICATIONS)[number];
  allowExcessivelyViolentUsage: boolean;
  allowExcessivelySexualUsage: boolean;
  allowPoliticalOrReligiousUsage: boolean;
  allowAntisocialOrHateUsage: boolean;
  /** The licence's own text: VRM's (https://vrm.dev/licenses/1.0/), a Creative Commons one, the author's; and any other. */
  licenseUrl: string;
  otherLicenseUrl: string;
}

export class LicenceError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

const URL_MAX = 300;
const isUrl = (v: string): boolean => v === '' || (/^https?:\/\/[^\s]+$/.test(v) && v.length <= URL_MAX);

/** A licence as a publisher stated it: every field present and one of its values, or every
 *  reason it is not, at once. */
export function readLicence(value: unknown): Licence {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const one = <T extends string>(key: string, allowed: readonly T[]): T => {
    if (typeof v[key] !== 'string' || !allowed.includes(v[key] as T)) problems.push(`${key}: one of ${allowed.join(', ')}`);
    return v[key] as T;
  };
  const flag = (key: string): boolean => {
    if (typeof v[key] !== 'boolean') problems.push(`${key}: true or false`);
    return v[key] === true;
  };
  const url = (key: string, required: boolean): string => {
    const s = typeof v[key] === 'string' ? (v[key] as string).trim() : undefined;
    if (s === undefined || !isUrl(s) || (required && s === '')) problems.push(`${key}: ${required ? 'a link to the licence' : 'a link, or empty'} (http or https, ${URL_MAX} characters at most)`);
    return s ?? '';
  };
  const licence: Licence = {
    avatarPermission: one('avatarPermission', AVATAR_PERMISSIONS),
    commercialUsage: one('commercialUsage', COMMERCIAL_USAGES),
    creditNotation: one('creditNotation', CREDIT_NOTATIONS),
    allowRedistribution: flag('allowRedistribution'),
    modification: one('modification', MODIFICATIONS),
    allowExcessivelyViolentUsage: flag('allowExcessivelyViolentUsage'),
    allowExcessivelySexualUsage: flag('allowExcessivelySexualUsage'),
    allowPoliticalOrReligiousUsage: flag('allowPoliticalOrReligiousUsage'),
    allowAntisocialOrHateUsage: flag('allowAntisocialOrHateUsage'),
    licenseUrl: url('licenseUrl', true),
    otherLicenseUrl: url('otherLicenseUrl', false),
  };
  if (problems.length > 0) throw new LicenceError(problems);
  return licence;
}

/** What an avatar's file said about its terms (its manifest's `licence`: VRM 1.0's meta as it
 *  was, or VRM 0.x's), as licence fields. A field the file did not state is left out; a plain GLB
 *  states none. */
export function licenceOfFile(meta: Record<string, unknown>): Partial<Licence> {
  const out: Partial<Licence> = {};
  const pick = <K extends keyof Licence>(key: K, ok: (v: unknown) => boolean): void => {
    if (ok(meta[key])) out[key] = meta[key] as Licence[K];
  };
  pick('avatarPermission', (x) => (AVATAR_PERMISSIONS as readonly unknown[]).includes(x));
  pick('commercialUsage', (x) => (COMMERCIAL_USAGES as readonly unknown[]).includes(x));
  pick('creditNotation', (x) => (CREDIT_NOTATIONS as readonly unknown[]).includes(x));
  pick('allowRedistribution', (x) => typeof x === 'boolean');
  pick('modification', (x) => (MODIFICATIONS as readonly unknown[]).includes(x));
  for (const f of USAGE_FLAGS) pick(f, (x) => typeof x === 'boolean');
  pick('licenseUrl', (x) => typeof x === 'string' && isUrl(x));
  pick('otherLicenseUrl', (x) => typeof x === 'string' && isUrl(x));
  // VRM 0.x's names (UniVRM and Blender's exporter write them).
  if (out.avatarPermission === undefined && typeof meta['allowedUserName'] === 'string') {
    out.avatarPermission = meta['allowedUserName'] === 'Everyone' ? 'everyone' : meta['allowedUserName'] === 'ExplicitlyLicensedPerson' ? 'onlySeparatelyLicensedPerson' : 'onlyAuthor';
  }
  if (out.allowExcessivelyViolentUsage === undefined && typeof meta['violentUssageName'] === 'string') out.allowExcessivelyViolentUsage = meta['violentUssageName'] === 'Allow';
  if (out.allowExcessivelySexualUsage === undefined && typeof meta['sexualUssageName'] === 'string') out.allowExcessivelySexualUsage = meta['sexualUssageName'] === 'Allow';
  if (out.commercialUsage === undefined && typeof meta['commercialUssageName'] === 'string') out.commercialUsage = meta['commercialUssageName'] === 'Allow' ? 'personalProfit' : 'personalNonProfit';
  // VRM 0.x's licence by name, read as the converter reads it (an unknown one, the strict way).
  if (typeof meta['licenseName'] === 'string') {
    const name = meta['licenseName'];
    const cc = /^CC/.test(name);
    out.creditNotation ??= name === 'CC0' ? 'unnecessary' : 'required';
    out.allowRedistribution ??= name === 'CC0' || name === 'CC_BY' || name === 'CC_BY_SA';
    out.modification ??= cc && !name.includes('ND') ? 'allowModificationRedistribution' : 'prohibited';
  }
  return out;
}

const rank = (list: readonly string[], v: string): number => list.indexOf(v);

/** Where a publisher's licence lets more than the file's own terms do (each such field by name):
 *  the gallery refuses those. Stricter is always allowed. */
export function looserThan(given: Licence, file: Partial<Licence>): string[] {
  const out: string[] = [];
  if (file.avatarPermission && rank(AVATAR_PERMISSIONS, given.avatarPermission) > rank(AVATAR_PERMISSIONS, file.avatarPermission)) out.push('avatarPermission');
  if (file.commercialUsage && rank(COMMERCIAL_USAGES, given.commercialUsage) > rank(COMMERCIAL_USAGES, file.commercialUsage)) out.push('commercialUsage');
  if (file.creditNotation === 'required' && given.creditNotation === 'unnecessary') out.push('creditNotation');
  if (file.allowRedistribution === false && given.allowRedistribution) out.push('allowRedistribution');
  if (file.modification && rank(MODIFICATIONS, given.modification) > rank(MODIFICATIONS, file.modification)) out.push('modification');
  for (const f of USAGE_FLAGS) if (file[f] === false && given[f]) out.push(f);
  return out;
}

/** The strictest licence, a starting point for a publisher: everyone may wear it (the gallery's
 *  condition), credit required, no copies, no changes, no profit, none of the four usages. */
export const STRICT_LICENCE: Licence = {
  avatarPermission: 'everyone',
  commercialUsage: 'personalNonProfit',
  creditNotation: 'required',
  allowRedistribution: false,
  modification: 'prohibited',
  allowExcessivelyViolentUsage: false,
  allowExcessivelySexualUsage: false,
  allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false,
  licenseUrl: 'https://vrm.dev/licenses/1.0/',
  otherLicenseUrl: '',
};

/** What stops a licence from going in the free gallery: it must let everyone wear the item. */
export function galleryProblems(l: Licence): string[] {
  return l.avatarPermission === 'everyone' ? [] : ['the gallery is for avatars and items everyone may wear: avatarPermission must be everyone'];
}
