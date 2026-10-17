// SPDX-License-Identifier: MPL-2.0
// Plugins (S3.01, ad-014, sf-006, T-04): a world's own code, run by its world server. A plugin is a
// folder: plugin.toml (its name, version, the host interface version it was written for, the
// permissions it asks for, the hooks it handles and its settings) and a module in the engine's
// language (TypeScript or JavaScript, as Node.js runs it) whose default export takes the host
// interface and returns its hooks. Plugins are code the host chose to run, but the interface is
// narrow and versioned, so a sandboxed runtime can offer the same calls later, and no call loosens
// a minor's protections (S3.10).
//
// A broken plugin is refused at start with one log line saying why; a hook that throws (or whose
// promise rejects) is logged, and a plugin whose hooks keep failing (20 errors in a minute) is
// switched off. An entry rule that fails refuses the join: a world's door stays shut when its lock
// breaks. Setup may be async; hooks that answer (entry rules, chat, voice) answer at once.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ROLES } from '@flatchat/protocol';
import { parse } from 'smol-toml';

export const HOST_API_VERSION = 1;
export const HOOKS = ['on_join_request', 'on_join', 'on_leave', 'on_chat', 'on_command', 'on_zone_enter', 'on_zone_exit', 'on_tick', 'on_voice_settings'] as const;
export const PERMISSIONS = ['chat', 'moderation', 'voice', 'store', 'timers'] as const;
export type HookName = (typeof HOOKS)[number];
export type Permission = (typeof PERMISSIONS)[number];

/** What each permission lets a plugin do, in the words the host tool shows when a host installs it. */
export const PERMISSION_MEANS: Record<Permission, string> = {
  chat: 'say things in the world’s chat, and change or stop players’ chat lines',
  moderation: 'kick, ban and force-mute players',
  voice: 'change players’ voice range and volume',
  store: 'keep data in the world between runs',
  timers: 'run its code on a timer',
};

/** Hooks that act on players' words or voices: a plugin handling one must ask for its permission. */
export const HOOK_NEEDS: Partial<Record<HookName, Permission>> = { on_chat: 'chat', on_voice_settings: 'voice' };

/** What a plugin knows about a player: the connect token's facts, never an email or a birth date. */
export interface PluginPlayer {
  entity: number;
  account: string;
  name: string;
  trust: number;
  tester: boolean;
  emailVerified: boolean;
  ageDays: number;
  under18: boolean;
  /** The player's role in this world (S3.06). */
  role: (typeof ROLES)[number];
}

export type JoinRequest = Omit<PluginPlayer, 'entity'> & { players: number; capacity: number };
export type Verdict = { admit: true } | { admit: false; reason: string };

export interface PluginHooks {
  on_join_request?(request: JoinRequest): Verdict;
  on_join?(player: PluginPlayer): void;
  on_leave?(player: PluginPlayer, why: string): void;
  /** Return `{ drop: true }` to stop a line, or `{ text }` to change it. */
  on_chat?(player: PluginPlayer, text: string): { text?: string; drop?: boolean } | void;
  /** A chat line starting with `/`: the command's name and its words. */
  on_command?(player: PluginPlayer, name: string, args: string[]): void;
  on_zone_enter?(player: PluginPlayer, zone: { index: number; kind: string }): void;
  on_zone_exit?(player: PluginPlayer, zone: { index: number; kind: string }): void;
  on_tick?(tick: number): void;
  /** A player's voice: `range` in metres (1 to 200), `gain` a multiplier (1 as spoken, up to 4).
   *  Asked at the join and whenever the player's zones change; a minor's stay within the world's
   *  defaults whatever this says (S3.10). */
  on_voice_settings?(player: PluginPlayer): { range?: number; gain?: number } | void;
}

/** What the world server offers plugins; WorldServer implements it. */
export interface PluginWorld {
  readonly id: string;
  readonly name: string;
  pluginPlayers(): PluginPlayer[];
  pluginSay(text: string, to?: number): void;
  pluginKick(entity: number, reason: string): void;
  pluginBan(account: string, minutes: number | undefined, reason: string): void;
  pluginUnban(account: string): void;
  pluginForceMute(entity: number, on: boolean): void;
  pluginStore(scope: string): { get(key: string): string | undefined; set(key: string, value: string): boolean; delete(key: string): void; keys(): string[] };
}

export interface HostApi {
  readonly version: typeof HOST_API_VERSION;
  readonly plugin: { name: string; version: string };
  readonly settings: Readonly<Record<string, unknown>>;
  readonly world: { id: string; name: string };
  log(event: string, fields?: Record<string, unknown>): void;
  players(): PluginPlayer[];
  say(text: string, to?: number): void;
  kick(entity: number, reason: string): void;
  ban(account: string, minutes: number | undefined, reason: string): void;
  unban(account: string): void;
  forceMute(entity: number, on: boolean): void;
  readonly store: { get(key: string): string | undefined; set(key: string, value: string): boolean; delete(key: string): void; keys(): string[] };
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
}

export interface PluginManifest {
  name: string;
  version: string;
  api: number;
  description: string;
  permissions: Permission[];
  hooks: HookName[];
  main: string;
  settings: Record<string, unknown>;
}

export class PluginError extends Error {}

/** Reads and checks plugin.toml. */
export function parseManifest(text: string): PluginManifest {
  let t: Record<string, unknown>;
  try {
    t = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(`plugin.toml does not parse: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  const name = t['name'];
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new PluginError('name: lowercase letters, digits and dashes, 40 at most');
  const version = typeof t['version'] === 'string' && /^\d+\.\d+\.\d+$/.test(t['version']) ? t['version'] : undefined;
  if (!version) throw new PluginError('version: three numbers, like 1.0.0');
  if (t['api'] !== HOST_API_VERSION) throw new PluginError(`api: this world server offers host interface ${HOST_API_VERSION}`);
  const list = <T extends string>(key: string, known: readonly T[]): T[] => {
    const v = t[key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new PluginError(`${key}: a list of names`);
    const unknown = v.filter((x) => !known.includes(x as T));
    if (unknown.length) throw new PluginError(`${key}: unknown ${unknown.join(', ')}`);
    return v as T[];
  };
  const permissions = list('permissions', PERMISSIONS);
  const hooks = list('hooks', HOOKS);
  for (const h of hooks) {
    const need = HOOK_NEEDS[h];
    if (need && !permissions.includes(need)) throw new PluginError(`hooks: ${h} needs the "${need}" permission`);
  }
  const main = typeof t['main'] === 'string' ? t['main'] : 'index.ts';
  if (!/^[A-Za-z0-9_.-]+\.(ts|js|mjs)$/.test(main)) throw new PluginError('main: a file in the plugin folder (.ts, .js or .mjs)');
  const settings = t['settings'] ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new PluginError('settings: a table');
  return { name, version, api: HOST_API_VERSION, description: typeof t['description'] === 'string' ? t['description'] : '', permissions, hooks, main, settings: settings as Record<string, unknown> };
}

interface Loaded {
  manifest: PluginManifest;
  hooks: PluginHooks;
  errors: number[];
  off: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const MAX_ERRORS = 20;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

export class Plugins {
  private readonly world: PluginWorld;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly loaded: Loaded[] = [];

  constructor(world: PluginWorld, log: (event: string, fields?: Record<string, unknown>) => void) {
    this.world = world;
    this.log = log;
  }

  /** The plugins running, in load order. */
  get names(): string[] {
    return this.loaded.filter((p) => !p.off).map((p) => p.manifest.name);
  }

  /** Loads every plugin folder inside each of `dirs`, in name order; a broken one is refused. */
  async load(dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        this.log('plugin-refused', { folder: dir, why: 'no such folder' });
        continue;
      }
      for (const entry of readdirSync(dir).sort()) {
        const folder = join(dir, entry);
        if (!statSync(folder).isDirectory()) continue;
        try {
          await this.loadOne(folder);
        } catch (err) {
          this.log('plugin-refused', { folder: entry, why: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        }
      }
    }
  }

  private async loadOne(folder: string): Promise<void> {
    const tomlPath = join(folder, 'plugin.toml');
    if (!existsSync(tomlPath)) throw new PluginError('no plugin.toml');
    const manifest = parseManifest(readFileSync(tomlPath, 'utf8'));
    if (this.loaded.some((p) => p.manifest.name === manifest.name)) throw new PluginError(`a plugin named ${manifest.name} is already loaded`);
    const file = join(folder, manifest.main);
    if (!existsSync(file)) throw new PluginError(`no ${manifest.main}`);
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') throw new PluginError(`${manifest.main} has no default export taking the host interface`);
    const entry: Loaded = { manifest, hooks: {}, errors: [], off: false, timers: new Set() };
    let hooks: unknown;
    try {
      hooks = await (mod.default as (host: HostApi) => unknown)(this.host(entry));
    } catch (err) {
      throw new PluginError(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof hooks !== 'object' || hooks === null) throw new PluginError('setup returned no hooks');
    for (const name of Object.keys(hooks)) {
      if (!manifest.hooks.includes(name as HookName)) throw new PluginError(`it handles ${name} but plugin.toml does not list it`);
      if (typeof (hooks as Record<string, unknown>)[name] !== 'function') throw new PluginError(`${name} is not a function`);
    }
    entry.hooks = hooks as PluginHooks;
    this.loaded.push(entry);
    this.log('plugin-loaded', { name: manifest.name, version: manifest.version, hooks: manifest.hooks, permissions: manifest.permissions });
  }

  private host(entry: Loaded): HostApi {
    const { manifest } = entry;
    const need = (p: Permission): void => {
      if (!manifest.permissions.includes(p)) throw new PluginError(`${manifest.name} did not ask for the "${p}" permission`);
    };
    const timer = (ms: number, fn: () => void, repeat: boolean): (() => void) => {
      need('timers');
      const wrapped = (): void => {
        if (entry.off) return;
        this.guard(entry, 'timer', () => fn());
      };
      const t = repeat ? setInterval(wrapped, Math.max(50, ms)) : setTimeout(wrapped, Math.max(0, ms));
      entry.timers.add(t);
      return () => {
        clearTimeout(t);
        clearInterval(t);
        entry.timers.delete(t);
      };
    };
    let store: HostApi['store'] | undefined;
    const world = this.world;
    return {
      version: HOST_API_VERSION,
      plugin: { name: manifest.name, version: manifest.version },
      settings: Object.freeze({ ...manifest.settings }),
      world: { id: this.world.id, name: this.world.name },
      log: (event, fields = {}) => this.log('plugin-log', { plugin: manifest.name, event: String(event).slice(0, 64), ...fields }),
      players: () => this.world.pluginPlayers(),
      say: (text, to) => {
        need('chat');
        this.world.pluginSay(String(text), to);
      },
      kick: (entity, reason) => {
        need('moderation');
        this.world.pluginKick(entity, String(reason));
      },
      ban: (account, minutes, reason) => {
        need('moderation');
        this.world.pluginBan(String(account), minutes, String(reason));
      },
      unban: (account) => {
        need('moderation');
        this.world.pluginUnban(String(account));
      },
      forceMute: (entity, on) => {
        need('moderation');
        this.world.pluginForceMute(entity, on === true);
      },
      get store() {
        need('store');
        return (store ??= world.pluginStore(`plugin:${manifest.name}`));
      },
      every: (ms, fn) => timer(ms, fn, true),
      after: (ms, fn) => timer(ms, fn, false),
    };
  }

  /** Runs a plugin's code; an error is logged and counted, and too many switch the plugin off. A
   *  promise it returns is watched the same way: a rejection left alone would stop the process. */
  private guard<T>(entry: Loaded, hook: string, run: () => T): T | undefined {
    if (entry.off) return undefined;
    let result: T;
    try {
      result = run();
    } catch (err) {
      this.failed(entry, hook, err);
      throw err;
    }
    if (isThenable(result)) result.then(undefined, (err: unknown) => this.failed(entry, hook, err));
    return result;
  }

  private failed(entry: Loaded, hook: string, err: unknown): void {
    const now = Date.now();
    entry.errors = entry.errors.filter((t) => now - t < 60_000);
    entry.errors.push(now);
    this.log('plugin-error', { name: entry.manifest.name, hook, why: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    if (entry.errors.length >= MAX_ERRORS && !entry.off) {
      entry.off = true;
      for (const t of entry.timers) clearTimeout(t);
      entry.timers.clear();
      this.log('plugin-disabled', { name: entry.manifest.name, why: `${MAX_ERRORS} errors in a minute` });
    }
  }

  /** A hook that must answer at once gave a promise: logged as its error. */
  private notAtOnce(entry: Loaded, hook: string): void {
    this.failed(entry, hook, new PluginError(`${hook} answers at once: host interface ${HOST_API_VERSION} does not wait for a promise`));
  }

  private each<K extends HookName>(hook: K): Array<{ entry: Loaded; fn: NonNullable<PluginHooks[K]> }> {
    return this.loaded.filter((e) => !e.off && typeof e.hooks[hook] === 'function').map((entry) => ({ entry, fn: entry.hooks[hook]! }));
  }

  /** Every entry rule in turn; the first refusal wins, and a rule that fails refuses. */
  joinRequest(request: JoinRequest): Verdict {
    for (const { entry, fn } of this.each('on_join_request')) {
      let verdict: Verdict | undefined;
      try {
        verdict = this.guard(entry, 'on_join_request', () => fn.call(entry.hooks, { ...request }));
      } catch {
        return { admit: false, reason: 'the world’s entry rule failed' };
      }
      if (isThenable(verdict)) {
        this.notAtOnce(entry, 'on_join_request');
        return { admit: false, reason: 'the world’s entry rule failed' };
      }
      if (!verdict || typeof verdict !== 'object') return { admit: false, reason: 'the world’s entry rule gave no answer' };
      if (verdict.admit !== true) return { admit: false, reason: typeof (verdict as { reason?: unknown }).reason === 'string' ? (verdict as { reason: string }).reason.slice(0, 160) : 'the world’s rules do not let you in' };
    }
    return { admit: true };
  }

  /** A hook whose answer does not matter; errors are logged and the world goes on. */
  notify<K extends 'on_join' | 'on_leave' | 'on_command' | 'on_zone_enter' | 'on_zone_exit' | 'on_tick'>(hook: K, ...args: Parameters<NonNullable<PluginHooks[K]>>): void {
    for (const { entry, fn } of this.each(hook)) {
      try {
        this.guard(entry, hook, () => (fn as (...a: unknown[]) => unknown).apply(entry.hooks, args));
      } catch {
        // logged by guard
      }
    }
  }

  /** A chat line through every on_chat in turn: dropped, changed or passed on. */
  chat(player: PluginPlayer, text: string): string | undefined {
    let line = text;
    for (const { entry, fn } of this.each('on_chat')) {
      let r: { text?: string; drop?: boolean } | void;
      try {
        r = this.guard(entry, 'on_chat', () => fn.call(entry.hooks, { ...player }, line));
      } catch {
        continue;
      }
      if (isThenable(r)) {
        this.notAtOnce(entry, 'on_chat');
        continue;
      }
      if (r?.drop) return undefined;
      if (typeof r?.text === 'string') line = r.text;
    }
    return line;
  }

  /** A player's voice settings as the plugins set them (the last one wins). */
  voiceSettings(player: PluginPlayer): { range?: number; gain?: number } {
    let out: { range?: number; gain?: number } = {};
    for (const { entry, fn } of this.each('on_voice_settings')) {
      try {
        const r = this.guard(entry, 'on_voice_settings', () => fn.call(entry.hooks, { ...player }));
        if (isThenable(r)) this.notAtOnce(entry, 'on_voice_settings');
        else if (r && typeof r === 'object') out = { ...out, ...r };
      } catch {
        // logged by guard
      }
    }
    return out;
  }

  close(): void {
    for (const e of this.loaded) {
      for (const t of e.timers) clearTimeout(t);
      e.timers.clear();
    }
  }
}

