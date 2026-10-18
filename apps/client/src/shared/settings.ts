// SPDX-License-Identifier: MPL-2.0
// The player's settings, shared by the main process (which keeps them in a file) and the page (which
// shows and changes them). Pure: no Node.js, no Electron, no DOM. Anything malformed falls back to
// its default field by field, so a damaged file never stops the client.
import { fitWornAdjust, type WornAdjust } from '@flatchat/content';

export const ACTIONS = ['forward', 'back', 'left', 'right', 'run', 'jump', 'down', 'fly', 'sit', 'goto', 'teleport', 'view', 'chat', 'talk', 'mute', 'earmuffs', 'people', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'hands', 'outfits', 'emotes', 'menu'] as const;
export type Action = (typeof ACTIONS)[number];

/** Two bindings per action at most: a main key and a second one. */
export type Bindings = Record<Action, string[]>;

export const DEFAULT_KEYS: Bindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft'],
  jump: ['Space'],
  // Flying (where a world allows it): F turns it on and off, Space rises, C sinks (S2.06).
  down: ['KeyC'],
  fly: ['KeyF'],
  // Sit on the nearest seat or stand up; walk to, or teleport to, the spot under the crosshair.
  sit: ['KeyE'],
  goto: ['KeyG'],
  teleport: ['KeyH'],
  view: ['KeyV'],
  chat: ['Enter'],
  talk: ['KeyT'],
  mute: ['KeyM'],
  // Earmuffs (S3.08): voices farther than a couple of metres drop to a murmur.
  earmuffs: ['KeyN'],
  // Who is here, with their roles (S3.06), and later what one can do about them.
  people: ['Tab'],
  // The face (S4.07): an emotion until pressed again; the hands' poses in turn.
  happy: ['Digit1'],
  angry: ['Digit2'],
  sad: ['Digit3'],
  relaxed: ['Digit4'],
  surprised: ['Digit5'],
  hands: ['KeyR'],
  // The outfits quick menu (S5.05): saved outfits and the account's items, on and off.
  outfits: ['KeyO'],
  // The emotes menu (S5.07): the account's emotes and dances, played for everyone nearby.
  emotes: ['KeyB'],
  menu: ['Escape'],
};

/** Escape always opens the menu, so a player can never bind themselves out of it. */
export const FIXED: readonly Action[] = ['menu'];

// KeyboardEvent.code values (layout-independent: W is where W is on a US keyboard), and the mouse's
// buttons as Mouse0 to Mouse4.
const CODE =
  /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal|Enter)|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|(Shift|Control|Alt)(Left|Right)|Space|Enter|Escape|Tab|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|CapsLock|Backspace|Insert|Delete|Home|End|PageUp|PageDown|Mouse[0-4])$/;

export function validCode(code: unknown): code is string {
  return typeof code === 'string' && CODE.test(code);
}

export interface VoiceSettings {
  /** Open microphone with a voice gate (highlighted at first launch), or push-to-talk. */
  mode: 'open' | 'push';
  /** The first-launch question was answered. */
  asked: boolean;
  muted: boolean;
  /** A device id from the page's device list; empty for the system default. */
  inputDevice: string;
  /** Everyone else's voices, 0 to 1. */
  volume: number;
  /** One person's voice, by account, 0 to 2 (S3.08); 1 when not set. */
  volumes: Record<string, number>;
}

export interface ViewSettings {
  person: 'first' | 'third';
  /** Mouse look, degrees per 100 pixels. */
  sensitivity: number;
  invertY: boolean;
}

/** How tall the player is (S2.07, Q-M30): free within this range; each world fits it into its own. */
export const HEIGHT_RANGE = { min: 0.3, max: 5, default: 1.75 } as const;

/** The proportion sliders' range (S4.10): the protocol's PROPORTIONS, as shares. */
export const PROPORTION_RANGE = { min: 0.8, max: 1.25 } as const;

/** The ranks a viewer may set as the worst drawn in full (packages/content's RANKS). */
export const RANK_CHOICES = ['excellent', 'good', 'medium', 'poor', 'veryPoor'] as const;
/** This computer's hardware tier, measured on the first visit to a world (S4.05). */
export const TIERS = ['unset', 'low', 'medium', 'high'] as const;
export type Tier = (typeof TIERS)[number];

export interface AvatarSettings {
  /** Metres. */
  height: number;
  /** The tier the first visit measured; unset until then. */
  tier: Tier;
  /** The worst rank drawn in full (S4.09); worse avatars show lighter. */
  minRank: (typeof RANK_CHOICES)[number];
  /** How many avatars are drawn in full at most, nearest first (S4.09). */
  full: number;
  /** Strangers (not friends) below this trust level show as impostors; 0 for no shield (S4.09). */
  shield: number;
  /** Accounts whose avatars this player hides: they show as impostors (S4.09), 500 at most. */
  hidden: string[];
  /** While frames are slow, fewer avatars in full (S4.09). */
  autoTune: boolean;
  /** Creator shaders (S6.03, T-01): the viewer's own and friends' always; strangers' only when this
   *  is on (and never on the low tier); everyone else sees each material's own look. */
  shadersStrangers: boolean;
  /** The avatar's proportions (S4.10), each a share of the avatar as made, 0.8 to 1.25. */
  proportions: { width: number; arms: number; legs: number; head: number };
  /** What each account on this computer wears now (S5.05), by account id: sent to every world it
   *  joins. 20 accounts, 16 items each, at most. */
  worn: Record<string, WornItem[]>;
}

/** A worn item: its manifest's SHA-256, and a prop's adjustment (cm, degrees, percent). */
export interface WornItem {
  item: string;
  adjust?: WornAdjust;
}

/** A worn list made safe: well-formed entries, each once, adjustments within the limits, 16 at most. */
export function cleanWornItems(raw: unknown): WornItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WornItem[] = [];
  for (const e of raw.slice(0, 16)) {
    const v = obj(e);
    if (typeof v['item'] !== 'string' || !/^[0-9a-f]{64}$/.test(v['item']) || out.some((w) => w.item === v['item'])) continue;
    const a = v['adjust'];
    if (a && typeof a === 'object') {
      const x = obj(a);
      const n = (k: string, d: number): number => (typeof x[k] === 'number' ? (x[k] as number) : d);
      out.push({ item: v['item'], adjust: fitWornAdjust({ x: n('x', 0), y: n('y', 0), z: n('z', 0), rx: n('rx', 0), ry: n('ry', 0), rz: n('rz', 0), scale: n('scale', 100) }) });
    } else out.push({ item: v['item'] });
  }
  return out;
}



/** Volumes, 0 to 1 (S2.14): the world's sounds and footsteps, and the interface's clicks and chimes;
 *  and other players' emote and dance sounds (S5.07; 0 turns them off). */
export interface SoundSettings {
  world: number;
  ui: number;
  emotes: number;
}

/** Effects on avatars and in worlds (S6.01): whether they play at all, and whether strangers'
 *  (not friends) do; trust levels below the shield and hidden people never show theirs (Q-M10). */
export interface EffectSettings {
  show: boolean;
  strangers: boolean;
}

/** Screen overlays (S6.02, Q-M13, T-14): the viewer's own, worlds' (on until switched off), and
 *  the accounts whose overlays the viewer allowed, person by person. */
export interface ScreenOverlaySettings {
  mine: boolean;
  world: boolean;
  allowed: string[];
}

export interface Settings {
  version: 1;
  language: 'system' | 'en' | 'es';
  /** The core's address; empty for the built-in one. */
  core: string;
  keys: Bindings;
  voice: VoiceSettings;
  view: ViewSettings;
  avatar: AvatarSettings;
  sound: SoundSettings;
  effects: EffectSettings;
  overlays: ScreenOverlaySettings;
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    language: 'system',
    core: '',
    keys: Object.fromEntries(ACTIONS.map((a) => [a, [...DEFAULT_KEYS[a]]])) as Bindings,
    voice: { mode: 'open', asked: false, muted: false, inputDevice: '', volume: 1, volumes: {} },
    view: { person: 'third', sensitivity: 12, invertY: false },
    avatar: { height: HEIGHT_RANGE.default, tier: 'unset', minRank: 'poor', full: 8, shield: 0, hidden: [], autoTune: true, shadersStrangers: false, proportions: { width: 1, arms: 1, legs: 1, head: 1 }, worn: {} },
    sound: { world: 0.8, ui: 0.5, emotes: 0.6 },
    effects: { show: true, strangers: false },
    overlays: { mine: true, world: true, allowed: [] },
  };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const num = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Bindings from anything: unknown codes dropped, each code kept by its first action only. */
export function cleanKeys(raw: unknown): Bindings {
  const given = obj(raw);
  const used = new Set<string>();
  const out = {} as Bindings;
  // Fixed actions claim their keys first.
  const order = [...FIXED, ...ACTIONS.filter((a) => !FIXED.includes(a))];
  for (const action of order) {
    const list = FIXED.includes(action) ? DEFAULT_KEYS[action] : Array.isArray(given[action]) ? (given[action] as unknown[]) : DEFAULT_KEYS[action];
    out[action] = [];
    for (const c of list) {
      if (out[action].length === 2 || !validCode(c) || used.has(c)) continue;
      out[action].push(c);
      used.add(c);
    }
  }
  return out;
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Per-person volumes kept: 500 at most, by account id, 0 to 2, the plain 1s dropped. */
export function cleanVolumes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(raw)).slice(0, 500)) if (ACCOUNT_ID.test(k) && typeof v === 'number' && Number.isFinite(v) && v !== 1) out[k] = Math.min(2, Math.max(0, v));
  return out;
}

export function cleanSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = obj(raw);
  const voice = obj(r['voice']);
  const view = obj(r['view']);
  const avatar = obj(r['avatar']);
  const sound = obj(r['sound']);
  const effects = obj(r['effects']);
  const overlays = obj(r['overlays']);
  const core = typeof r['core'] === 'string' && r['core'].length <= 200 ? r['core'] : '';
  return {
    version: 1,
    language: pick(r['language'], ['system', 'en', 'es'] as const, d.language),
    core,
    keys: r['keys'] === undefined ? d.keys : cleanKeys(r['keys']),
    voice: {
      mode: pick(voice['mode'], ['open', 'push'] as const, d.voice.mode),
      asked: bool(voice['asked'], d.voice.asked),
      muted: bool(voice['muted'], d.voice.muted),
      inputDevice: typeof voice['inputDevice'] === 'string' && voice['inputDevice'].length <= 200 ? voice['inputDevice'] : '',
      volume: num(voice['volume'], 0, 1, d.voice.volume),
      volumes: cleanVolumes(voice['volumes']),
    },
    view: {
      person: pick(view['person'], ['first', 'third'] as const, d.view.person),
      sensitivity: num(view['sensitivity'], 1, 60, d.view.sensitivity),
      invertY: bool(view['invertY'], d.view.invertY),
    },
    avatar: {
      // Centimetre steps, as the protocol carries it.
      height: Math.round(num(avatar['height'], HEIGHT_RANGE.min, HEIGHT_RANGE.max, d.avatar.height) * 100) / 100,
      tier: pick(avatar['tier'], TIERS, d.avatar.tier),
      minRank: pick(avatar['minRank'], RANK_CHOICES, d.avatar.minRank),
      full: Math.round(num(avatar['full'], 0, 24, d.avatar.full)),
      shield: Math.round(num(avatar['shield'], 0, 4, d.avatar.shield)),
      hidden: Array.isArray(avatar['hidden']) ? [...new Set(avatar['hidden'].filter((a): a is string => typeof a === 'string' && ACCOUNT_ID.test(a)))].slice(0, 500) : [],
      autoTune: bool(avatar['autoTune'], d.avatar.autoTune),
      shadersStrangers: bool(avatar['shadersStrangers'], d.avatar.shadersStrangers),
      proportions: (() => {
        const p = obj(avatar['proportions']);
        const share = (v: unknown): number => Math.round(num(v, PROPORTION_RANGE.min, PROPORTION_RANGE.max, 1) * 100) / 100;
        return { width: share(p['width']), arms: share(p['arms']), legs: share(p['legs']), head: share(p['head']) };
      })(),
      worn: Object.fromEntries(
        Object.entries(obj(avatar['worn']))
          .filter(([account]) => ACCOUNT_ID.test(account))
          .slice(0, 20)
          .map(([account, items]) => [account, cleanWornItems(items)]),
      ),
    },
    sound: { world: num(sound['world'], 0, 1, d.sound.world), ui: num(sound['ui'], 0, 1, d.sound.ui), emotes: num(sound['emotes'], 0, 1, d.sound.emotes) },
    effects: { show: bool(effects['show'], d.effects.show), strangers: bool(effects['strangers'], d.effects.strangers) },
    overlays: {
      mine: bool(overlays['mine'], d.overlays.mine),
      world: bool(overlays['world'], d.overlays.world),
      allowed: Array.isArray(overlays['allowed']) ? [...new Set(overlays['allowed'].filter((a): a is string => typeof a === 'string' && ACCOUNT_ID.test(a)))].slice(0, 500) : [],
    },
  };
}

/** Applies a change from the page: the result is cleaned like a file read. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const p = obj(patch);
  return cleanSettings({
    ...current,
    ...p,
    voice: { ...current.voice, ...obj(p['voice']) },
    view: { ...current.view, ...obj(p['view']) },
    avatar: { ...current.avatar, ...obj(p['avatar']) },
    sound: { ...current.sound, ...obj(p['sound']) },
    effects: { ...current.effects, ...obj(p['effects']) },
    overlays: { ...current.overlays, ...obj(p['overlays']) },
    keys: p['keys'] === undefined ? current.keys : p['keys'],
  });
}

/** Puts `code` in an action's slot; whatever else held that code loses it. Fixed actions and
 *  their keys cannot be taken. */
export function bind(keys: Bindings, action: Action, slot: 0 | 1, code: string): Bindings {
  if (!validCode(code) || FIXED.includes(action) || FIXED.some((a) => keys[a].includes(code))) return keys;
  const out = Object.fromEntries(ACTIONS.map((a) => [a, keys[a].filter((c) => c !== code)])) as Bindings;
  const list = [...out[action]];
  if (slot === 0) list.unshift(code);
  else list.splice(1, 0, code);
  out[action] = list.slice(0, 2);
  return out;
}

export function unbind(keys: Bindings, action: Action, slot: 0 | 1): Bindings {
  if (FIXED.includes(action)) return keys;
  return { ...keys, [action]: keys[action].filter((_, i) => i !== slot) };
}

/** The action a key or mouse button triggers, if any. */
export function actionFor(keys: Bindings, code: string): Action | undefined {
  return ACTIONS.find((a) => keys[a].includes(code));
}
