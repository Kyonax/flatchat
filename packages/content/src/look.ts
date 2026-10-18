// SPDX-License-Identifier: Apache-2.0
// A world's look (S6.05, Q-E6): its sky, fog, sun and ambient light, and the screen effects its
// maker sets (bloom and neon glow, light shafts from the sun, reflections on glossy surfaces, and
// screen filters: a CRT's scanlines and curve, film grain, a vignette, colour grading). Read from
// world.toml's [look] and kept in the built world; every viewer can switch each screen effect off
// (T-14: on until switched off), and the safe-mode key clears them. Left out, a world keeps the look
// every world had before (DEFAULT_LOOK). Shared by the validator, the converter and the client.

export interface WorldLook {
  /** The sky's colour behind everything, #rrggbb. */
  sky: string;
  /** Fog from `near` to `far` metres in `colour` (the sky's when left out); null for none. */
  fog: { colour: string; near: number; far: number } | null;
  sun: { colour: string; intensity: number; direction: [number, number, number] };
  ambient: { sky: string; ground: string; intensity: number };
  /** Screen effects, each null when the world has none. */
  bloom: { strength: number; threshold: number; radius: number } | null;
  shafts: { strength: number } | null;
  reflections: { strength: number } | null;
  filters: LookFilters | null;
}

export interface LookFilters {
  /** 0 to 1: a CRT's scanlines, curve and colour bleed. */
  crt: number;
  /** 0 to 1: film grain. */
  grain: number;
  /** 0 to 1: the corners darkened. */
  vignette: number;
  /** 0 to 2 (1 as drawn). */
  saturation: number;
  contrast: number;
  exposure: number;
  /** Multiplied over the picture, #rrggbb (#ffffff for none). */
  tint: string;
}

/** The look every world had before S6.05 (the client's plaza scene), and a world keeps without
 *  [look]; its fog's far end is 0.9 of the world's size when not given. */
export const DEFAULT_LOOK: WorldLook = {
  sky: '#9fb8d0',
  fog: { colour: '#9fb8d0', near: 40, far: 0 },
  sun: { colour: '#fff1dc', intensity: 1.8, direction: [0.4, 1, 0.3] },
  ambient: { sky: '#dfe8f5', ground: '#3a3f33', intensity: 1.6 },
  bloom: null,
  shafts: null,
  reflections: null,
  filters: null,
};

export const LOOK_KEYS = ['sky', 'fog', 'sun', 'ambient', 'bloom', 'shafts', 'reflections', 'filters'] as const;

const COLOUR = /^#[0-9a-fA-F]{6}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads a [look] table (or a built world's look), every problem with its field. Fields left out
 *  take DEFAULT_LOOK's values; a screen effect is on only when the table gives it. */
export function readLook(raw: unknown, at = 'look'): { look: WorldLook; problems: Array<{ at: string; message: string }> } {
  const problems: Array<{ at: string; message: string }> = [];
  const look: WorldLook = structuredClone(DEFAULT_LOOK);
  if (raw === undefined) return { look, problems };
  if (!isObj(raw)) return { look, problems: [{ at, message: 'look is a table' }] };
  const colour = (v: unknown, path: string, fallback: string): string => {
    if (v === undefined) return fallback;
    if (typeof v === 'string' && COLOUR.test(v)) return v.toLowerCase();
    problems.push({ at: path, message: `${path} is a colour like "#9fb8d0"` });
    return fallback;
  };
  const num = (v: unknown, path: string, min: number, max: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
    problems.push({ at: path, message: `${path} is a number from ${min} to ${max}` });
    return fallback;
  };
  const table = (key: string): Record<string, unknown> | undefined => {
    const v = raw[key];
    if (v === undefined || v === false || v === null) return undefined;
    if (isObj(v)) return v;
    problems.push({ at: `${at}.${key}`, message: `${at}.${key} is a table` });
    return undefined;
  };
  look.sky = colour(raw['sky'], `${at}.sky`, DEFAULT_LOOK.sky);
  if (raw['fog'] === false || raw['fog'] === null) look.fog = null;
  else {
    const f = table('fog') ?? {};
    const near = num(f['near'], `${at}.fog.near`, 0, 10_000, DEFAULT_LOOK.fog!.near);
    const far = num(f['far'], `${at}.fog.far`, 0, 10_000, 0);
    if (far !== 0 && far <= near) problems.push({ at: `${at}.fog`, message: `${at}.fog.far must be beyond ${at}.fog.near` });
    look.fog = { colour: colour(f['colour'], `${at}.fog.colour`, look.sky), near, far };
  }
  const sun = table('sun') ?? {};
  const dir = sun['direction'];
  let direction = DEFAULT_LOOK.sun.direction;
  if (dir !== undefined) {
    if (Array.isArray(dir) && dir.length === 3 && dir.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1000) && Math.hypot(...(dir as number[])) > 1e-3) direction = dir as [number, number, number];
    else problems.push({ at: `${at}.sun.direction`, message: `${at}.sun.direction is three numbers, not all zero` });
  }
  look.sun = { colour: colour(sun['colour'], `${at}.sun.colour`, DEFAULT_LOOK.sun.colour), intensity: num(sun['intensity'], `${at}.sun.intensity`, 0, 10, DEFAULT_LOOK.sun.intensity), direction };
  const amb = table('ambient') ?? {};
  look.ambient = { sky: colour(amb['sky'], `${at}.ambient.sky`, DEFAULT_LOOK.ambient.sky), ground: colour(amb['ground'], `${at}.ambient.ground`, DEFAULT_LOOK.ambient.ground), intensity: num(amb['intensity'], `${at}.ambient.intensity`, 0, 10, DEFAULT_LOOK.ambient.intensity) };
  const bloom = table('bloom');
  if (bloom) look.bloom = { strength: num(bloom['strength'], `${at}.bloom.strength`, 0, 3, 0.8), threshold: num(bloom['threshold'], `${at}.bloom.threshold`, 0, 1, 0.8), radius: num(bloom['radius'], `${at}.bloom.radius`, 0, 1, 0.4) };
  const shafts = table('shafts');
  if (shafts) look.shafts = { strength: num(shafts['strength'], `${at}.shafts.strength`, 0, 2, 0.6) };
  const refl = table('reflections');
  if (refl) look.reflections = { strength: num(refl['strength'], `${at}.reflections.strength`, 0, 2, 0.5) };
  const filt = table('filters');
  if (filt) {
    look.filters = {
      crt: num(filt['crt'], `${at}.filters.crt`, 0, 1, 0),
      grain: num(filt['grain'], `${at}.filters.grain`, 0, 1, 0),
      vignette: num(filt['vignette'], `${at}.filters.vignette`, 0, 1, 0),
      saturation: num(filt['saturation'], `${at}.filters.saturation`, 0, 2, 1),
      contrast: num(filt['contrast'], `${at}.filters.contrast`, 0, 2, 1),
      exposure: num(filt['exposure'], `${at}.filters.exposure`, 0, 2, 1),
      tint: colour(filt['tint'], `${at}.filters.tint`, '#ffffff'),
    };
  }
  return { look, problems };
}

/** The keys a [look] table and its sub-tables take, for the manifest's unknown-key warnings. */
export const LOOK_TABLE_KEYS: Record<string, readonly string[]> = {
  look: LOOK_KEYS,
  'look.fog': ['colour', 'near', 'far'],
  'look.sun': ['colour', 'intensity', 'direction'],
  'look.ambient': ['sky', 'ground', 'intensity'],
  'look.bloom': ['strength', 'threshold', 'radius'],
  'look.shafts': ['strength'],
  'look.reflections': ['strength'],
  'look.filters': ['crt', 'grain', 'vignette', 'saturation', 'contrast', 'exposure', 'tint'],
};
