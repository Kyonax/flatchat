// SPDX-License-Identifier: MPL-2.0
// The player's settings, shared by the main process (which keeps them in a file) and the page (which
// shows and changes them). Pure: no Node.js, no Electron, no DOM. Anything malformed falls back to
// its default field by field, so a damaged file never stops the client.

export const ACTIONS = ['forward', 'back', 'left', 'right', 'run', 'jump', 'view', 'chat', 'talk', 'mute', 'menu'] as const;
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
  view: ['KeyV'],
  chat: ['Enter'],
  talk: ['KeyT'],
  mute: ['KeyM'],
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
}

export interface ViewSettings {
  person: 'first' | 'third';
  /** Mouse look, degrees per 100 pixels. */
  sensitivity: number;
  invertY: boolean;
}

export interface Settings {
  version: 1;
  language: 'system' | 'en' | 'es';
  /** The core's address; empty for the built-in one. */
  core: string;
  keys: Bindings;
  voice: VoiceSettings;
  view: ViewSettings;
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    language: 'system',
    core: '',
    keys: Object.fromEntries(ACTIONS.map((a) => [a, [...DEFAULT_KEYS[a]]])) as Bindings,
    voice: { mode: 'open', asked: false, muted: false, inputDevice: '', volume: 1 },
    view: { person: 'third', sensitivity: 12, invertY: false },
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

export function cleanSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = obj(raw);
  const voice = obj(r['voice']);
  const view = obj(r['view']);
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
    },
    view: {
      person: pick(view['person'], ['first', 'third'] as const, d.view.person),
      sensitivity: num(view['sensitivity'], 1, 60, d.view.sensitivity),
      invertY: bool(view['invertY'], d.view.invertY),
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
