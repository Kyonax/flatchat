// SPDX-License-Identifier: MPL-2.0
// The world server: joins, the state tick, voice forwarding and chat, over any transport.
//
// A link must open with `hello` on the reliable channel within five seconds. The server checks the
// version (R-17), opens the connect token with the world's key without calling the core (sf-001),
// refuses a token it has seen before, then answers `welcome`, the full `roster`, and on the next
// tick the join snapshot. After that it applies poses (sf-004: the client moves, the server checks
// and corrects), sends snapshots at the tick rate, forwards voice every 20 ms, relays chat to the
// players nearby and answers pings. Anything malformed costs the sender its message, never the
// server its tick: decodeMessage refuses it with a ProtocolError.
//
// Joining (S1.07): after the version, the token, the replay check and the capacity, the world's
// entry rules decide (the built-in `open` rule admits everyone; Stage 3 moves rules into plugins).
// An account joins once: joining again from somewhere else ends the older connection. Chat (S1.10)
// is world-wide, cleaned of control and direction characters, at most 280 characters, and limited
// to a burst of 5 lines and then one every 1.5 s per player.
//
// Portals (S2.11): a built world's portal boxes; a player whose applied pose enters one gets
// `portal` (the world it leads to and a spawn group there) once, and again only after leaving it.
// The client gets its connect token for that world from the core, as for any join. A `hello` that
// names a spawn group lands on that group's spawn points, when the world has them.
//
// Heights (S2.07, Q-M30): a player chooses a height and the world fits it into its range
// (`[avatars]` in world.toml; 0.5 to 3 m by default); the roster carries the fitted height, and
// `appearance` changes it at most once a second. Seats and teleports (S2.06): `teleport` asks to be
// put on a seat within 3 m, or on a clicked spot within 40 m, at most once a second; a spot must be
// walkable (on a built world's navigation mesh, or above a code-made map's ground) unless the world
// allows flying. The answer is `placed`, accepted or not.
//
// Plugins (S3.01): the server is their PluginWorld (players' facts, world notices, kicks, bans kept
// in the world's database, force-mutes, a store per plugin). Their entry rules run after the
// built-in ones, a chat line starting with `/` is a command for them (never shown to everyone),
// and they hear joins, leaves, zones entered and left, and every tick.
import { performance } from 'node:perf_hooks';
import { type BuiltPortal, type BuiltZone, insideBox } from '@flatchat/content';
import {
  type Channel,
  checkVersion,
  decodeMessage,
  encodeMessage,
  type Message,
  type MessageBody,
  messageDef,
  type MessageName,
  type MessageOf,
  openToken,
  PROPORTIONS,
  PROTOCOL_VERSION,
  ProtocolError,
  type Refusal,
  ROLES,
  TokenError,
  toHex,
  type VersionPolicy,
  versionPolicy,
} from '@flatchat/protocol';
import { BODY, type Box, groundBelow, type WorldMap } from '@flatchat/sim';
import { memory, Samples, seededRandom, Tally } from './metrics.ts';
import type { Link, ServerTransport, TransportName } from './net/types.ts';
import { startTicker, type Ticker } from './ticker.ts';
import { boundsOf, type ContentServer, type ContentSink, type LoadedWorld } from './world/content.ts';
import type { PluginPlayer, Plugins, PluginWorld } from './plugins.ts';
import type { WalkableSurface } from './world/navigation.ts';
import { STORE_LIMITS } from './world/store-limits.ts';
import type { WorldStore } from './world/store.ts';
import { type BuildUploads, UploadError } from './world/uploads.ts';
import { GAIN_UNITY, MAX_RANGE_M, VoiceRouter, type VoiceConfig, type VoiceRules } from './world/voice.ts';
import { World, type WorldConfig } from './world/world.ts';

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export type Claims = Awaited<ReturnType<typeof openToken>>['claims'];

/** An entry rule (sf-006): admits a player from the token's facts, or refuses with a reason the
 *  player is shown (at most 160 characters). */
export type EntryRule = (claims: Claims, world: { players: number; capacity: number }) => { admit: true } | { admit: false; detail: string };

/** The built-in rule until plugins arrive (S3.05): everyone with a valid token gets in. */
export const OPEN_RULE: EntryRule = () => ({ admit: true });

/** A player's role in this world (S3.06). */
export type Role = (typeof ROLES)[number];

/** The lowest role holding each right (S3.06, Q-M7): replacing the world's files, kicking,
 *  banning and muting, and giving the roles below one's own. */
export const RIGHTS = { build: 'builder', moderate: 'moderator', roles: 'admin' } as const satisfies Record<string, Role>;

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function can(role: Role, right: keyof typeof RIGHTS): boolean {
  return roleRank(role) >= roleRank(RIGHTS[right]);
}

export interface WorldServerOptions {
  /** This world's ID (a UUID), the one its connect tokens name. */
  worldId: string;
  /** The world's 32-byte key, shared with the core at approval. Without one, nobody can join. */
  worldKey: Uint8Array | undefined;
  build: string;
  tickHz: number;
  voiceHz: number;
  capacity: number;
  /** Where the world drops off the public list (S2.09, Q-L19); the capacity when left out. */
  recommended?: number;
  /** The lowest protocol version the core allows (R-17). */
  coreMinimum: number;
  world: Partial<WorldConfig>;
  voice: Partial<VoiceConfig>;
  helloTimeoutMs: number;
  /** Seconds between metrics lines; 0 switches them off. */
  metricsEverySec: number;
  /** Seed for spawn positions. */
  seed: number;
  /** Where players appear: within `r` metres of (x, z), at height `y`, facing `yaw` (random when
   *  left out); anywhere in the world when left out. */
  spawn?: { x: number; z: number; r: number; y?: number; yaw?: number };
  /** Checked in order after the capacity; the first refusal wins. */
  entryRules: readonly EntryRule[];
  /** The built world players download (S2.04); none for a world made in code (flat, plaza). */
  content?: ContentServer;
  /** The world's database (S2.08): a persistent world puts a returning account where it left. */
  store?: WorldStore;
  /** Spawn points of a built world: each join picks one of the first scene's (`main`), or of the
   *  group its hello names (overrides `spawn`). */
  spawnPoints?: ReadonlyArray<{ x: number; y: number; z: number; yaw: number; group?: string; main?: boolean }>;
  /** A built world's portals (S2.11). */
  portals?: readonly BuiltPortal[];
  /** A built world's zones (voice, quiet, private; S3.01's hooks, S3.08's voice rules). */
  zones?: readonly BuiltZone[];
  /** The world's name, for plugins. */
  name?: string;
  /** The heights the world fits players into, in metres (S2.07). */
  heights?: { min: number; max: number };
  /** A built world's seats, in the built world's order (S2.06). */
  seats?: ReadonlyArray<{ position: [number, number, number]; yaw: number }>;
  /** A built world's walkable surface: where a teleport may land (S2.06). */
  walkable?: WalkableSurface;
  /** New builds from the people with build rights (S3.06); `onPublished` runs once one is in place,
   *  and the program restarts on it. */
  uploads?: BuildUploads;
  onPublished?: (world: { name: string; files: number }) => void;
  log: LogFn;
  /** Unix time in seconds, for token expiry. */
  unixNow: () => number;
  /** Called every 250 ms with every player's position and whether they spoke, for the devlog view. */
  trace?: (frame: TraceFrame) => void;
}

export interface TraceFrame {
  t: number;
  players: Array<[entity: number, x: number, z: number, speaking: 0 | 1]>;
}

export const DEFAULT_SERVER: Omit<WorldServerOptions, 'worldId' | 'worldKey' | 'log'> = {
  build: 'flatchat-world 0.0.0',
  tickHz: 20,
  voiceHz: 50,
  capacity: 200,
  coreMinimum: 0,
  world: {},
  voice: {},
  helloTimeoutMs: 5000,
  entryRules: [OPEN_RULE],
  metricsEverySec: 5,
  seed: 1,
  unixNow: () => Math.floor(Date.now() / 1000),
};

interface Conn {
  readonly link: Link;
  /** Where content messages for this player go. */
  sink?: ContentSink;
  state: 'hello' | 'joining' | 'joined' | 'closed';
  entity?: number;
  account?: string;
  name?: string;
  joinedAt?: number;
  helloTimer?: NodeJS.Timeout;
  voiceWindowStart: number;
  voiceInWindow: number;
  /** Chat's token bucket: lines available, refilled over time. */
  chatTokens: number;
  chatAt: number;
  spokeAt: number;
  badMessages: number;
  /** The portal the player stands in (its index), -1 for none: `portal` goes out on entering. */
  portal: number;
  /** The player's height in centimetres, fitted to the world. */
  height: number;
  teleportAt: number;
  appearanceAt: number;
  /** When the player last changed avatar (S4.05) and face (S4.07). */
  wearAt: number;
  faceAt: number;
  /** The connect token's facts. */
  claims?: Claims;
  /** Silenced by a moderator or a plugin: the world forwards none of this player's voice. */
  forceMuted: boolean;
  /** The player's role here (S3.06): the owner from the token, the others from the world. */
  role: Role;
  /** The player's voice as the world carries it (S3.08): range in metres, gain in 64ths, whether
   *  a quiet zone silences it, and the private zone it shares (-1: none). */
  voiceRange: number;
  voiceGain: number;
  quiet: boolean;
  privateZone: number;
  /** Accounts kept apart from this player by a block either way (S3.11): the token's, and any
   *  block made during the visit. */
  blocks: Set<string>;
  /** The entities this player and the world keep apart, as last sent (`hidden`). */
  hidden: number[];
  /** The zones (their indices) the player stands in. */
  zones: Set<number>;
}

type RosterPlayer = MessageBody<'roster'>['players'][number];

const MAX_ENTITY = 65_535;
const VOICE_FRAMES_PER_SECOND = 60;
const MAX_BAD_MESSAGES = 50;
const TRACE_MS = 250;
const CHAT_BURST = 5;
const CHAT_EVERY_MS = 1500;
const CHAT_MAX = 280;
/** Heights (S2.07): the platform's default, and the range a world without its own uses. */
export const DEFAULT_HEIGHT_CM = Math.round(BODY.height * 100);
export const DEFAULT_HEIGHTS = { min: 0.5, max: 3 };
const APPEARANCE_EVERY_MS = 1000;
/** A new avatar at most every two seconds; a face change at most eight times a second. */
const WEAR_EVERY_MS = 2000;
const FACE_EVERY_MS = 125;
const NEUTRAL_FACE = { expression: 'neutral', left: 'relaxed', right: 'relaxed' } as const;
type Proportions = { width: number; arms: number; legs: number; head: number };
/** A player's proportions (S4.10) fitted into the platform's range, in percent; as made when left out. */
export function fitProportions(p: Proportions | undefined): Proportions {
  const fit = (v: number | undefined): number => Math.round(Math.min(PROPORTIONS.max, Math.max(PROPORTIONS.min, v ?? 100)));
  return { width: fit(p?.width), arms: fit(p?.arms), legs: fit(p?.legs), head: fit(p?.head) };
}
/** Teleports and seats (S2.06). */
export const TELEPORT = { range: 40, seatReach: 3, everyMs: 1000 };

/** A chat line as others may see it: no control or direction characters (C0, C1 and the bidi
 *  overrides and isolates), whitespace collapsed, at most 280 characters; empty means dropped. */
export function cleanChat(text: string): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...cleaned].slice(0, CHAT_MAX).join('');
}

/** Cuts text to at most `max` UTF-8 bytes, on a character boundary. */
export function fitBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  let out = text;
  while (encoder.encode(out).length > max) out = [...out].slice(0, -1).join('');
  return out;
}

/** A world server's options for a built world (S2.03): its bounds, solids, flying, capacity and
 *  spawn points, and the content players download. */
export function builtOptions(loaded: LoadedWorld, content: ContentServer): Pick<WorldServerOptions, 'world' | 'spawnPoints' | 'portals' | 'zones' | 'name' | 'seats' | 'heights' | 'content' | 'capacity' | 'recommended'> {
  const w = loaded.world;
  const size = Math.max(16, Math.ceil(Math.max(w.bounds.max[0], w.bounds.max[2])));
  return {
    world: { size, solids: boundsOf(loaded.colliders), flying: w.manifest.flying },
    spawnPoints: w.scenes.flatMap((scene, i) => scene.spawns.map((s) => ({ x: s.position[0], y: s.position[1], z: s.position[2], yaw: s.yaw, group: s.group, main: i === 0 }))),
    portals: w.scenes.flatMap((scene) => scene.portals),
    zones: w.scenes.flatMap((scene) => scene.zones),
    name: w.manifest.name,
    seats: w.scenes.flatMap((scene) => scene.seats),
    heights: { min: w.manifest.avatars.minHeight, max: w.manifest.avatars.maxHeight },
    content,
    capacity: w.manifest.capacity.maximum,
    recommended: w.manifest.capacity.recommended,
  };
}

/** A world server's options for one map: its size, solids, flying and spawn. */
export function mapOptions(map: WorldMap): Pick<WorldServerOptions, 'world' | 'spawn'> {
  return {
    world: { size: map.size, solids: map.solids, flying: map.flying },
    spawn: { x: map.spawn.x, z: map.spawn.z, r: map.spawn.radius, y: map.spawn.y, yaw: map.spawn.yaw },
  };
}

export class WorldServer implements PluginWorld {
  readonly options: WorldServerOptions;
  readonly world: World;
  private readonly voice: VoiceRouter;
  private readonly transports: ServerTransport[];
  private readonly policy: VersionPolicy;
  private readonly conns = new Set<Conn>();
  private readonly byEntity = new Map<number, Conn>();
  private readonly roster = new Map<number, RosterPlayer>();
  private readonly freeEntities: number[] = [];
  /** Freed this tick: reused only after the roster has said they left, so no id means two players at once. */
  private freedThisTick: number[] = [];
  private nextEntity = 1;
  private readonly seenNonces = new Map<string, number>();
  private readonly random: () => number;
  private joinedThisTick: RosterPlayer[] = [];
  private leftThisTick: number[] = [];
  private ticker: Ticker | undefined;
  private voiceTicker: Ticker | undefined;
  private metricsTimer: NodeJS.Timeout | undefined;
  private traceTimer: NodeJS.Timeout | undefined;
  private tickNo = 0;
  private readonly started = performance.now();
  // metrics
  private readonly tickMs = new Samples();
  private readonly voiceMs = new Samples();
  private readonly encodings = new Samples();
  private readonly busyCells = new Samples();
  private readonly joinSnapshotBytes = new Samples();
  private readonly rosterBytes = new Samples();
  private readonly joinMs = new Samples();
  private readonly sent = new Tally();
  private readonly received = new Tally();
  private readonly events = new Tally();
  private peakPlayers = 0;
  /** The capacity the world's owner approved on the core (S2.09); none until the core says. */
  private approved = Number.POSITIVE_INFINITY;
  private readonly memoryStart = memory();
  private memoryWarm: ReturnType<typeof memory> | undefined;
  // CPU of the whole process (every thread, so libdatachannel's too) and the main thread's busy share.
  private cpuMark = process.cpuUsage();
  private cpuAt = performance.now();
  private eluMark = performance.eventLoopUtilization();
  private readonly cpuPct = new Samples();
  private readonly eluPct = new Samples();

  constructor(options: WorldServerOptions, transports: ServerTransport[]) {
    this.options = options;
    this.world = new World(options.world);
    this.voice = new VoiceRouter(options.voice);
    this.transports = transports;
    this.policy = versionPolicy(options.coreMinimum);
    this.random = seededRandom(options.seed);
    for (const transport of transports) transport.onLink((link) => this.accept(link, transport.name));
  }

  get players(): number {
    return this.byEntity.size;
  }

  /** The most players the world takes: its own capacity, or less when the core approved less. */
  get capacity(): number {
    return Math.min(this.options.capacity, this.approved);
  }

  /** Where the world drops off the public list. */
  get recommended(): number {
    return Math.min(this.options.recommended ?? this.options.capacity, this.capacity);
  }

  /** The capacity the core approved, sent over the host channel. */
  setApprovedCapacity(maximum: number): void {
    if (!Number.isInteger(maximum) || maximum < 1) return;
    this.approved = maximum;
    this.options.log('capacity-approved', { maximum, capacity: this.capacity });
  }

  get ticks(): number {
    return this.tickNo;
  }

  start(maxTicks?: number): Ticker {
    this.ticker = startTicker({
      hz: this.options.tickHz,
      onTick: (tick) => this.tick(tick),
      onTiming: (ms) => this.tickMs.add(ms),
      ...(maxTicks !== undefined ? { maxTicks } : {}),
    });
    this.voiceTicker = startTicker({
      hz: this.options.voiceHz,
      onTick: () => this.voiceStep(),
      onTiming: (ms) => this.voiceMs.add(ms),
    });
    if (this.options.metricsEverySec > 0) {
      this.metricsTimer = setInterval(() => this.reportWindow(), this.options.metricsEverySec * 1000);
    }
    if (this.options.trace) this.traceTimer = setInterval(() => this.traceFrame(), TRACE_MS);
    // The first two minutes warm the heap; memory growth is measured from then.
    setTimeout(() => {
      this.memoryWarm = memory();
    }, 120_000).unref();
    return this.ticker;
  }

  async stop(reason: string): Promise<Record<string, unknown>> {
    const ticks = (await this.ticker?.stop()) ?? 0;
    await this.voiceTicker?.stop();
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.traceTimer) clearInterval(this.traceTimer);
    const leave = encodeMessage({ type: 'leave', reason: 'closing', detail: reason });
    for (const conn of this.conns) {
      if (conn.state === 'joined') conn.link.send('reliable', leave);
    }
    await new Promise((r) => setTimeout(r, 50));
    for (const transport of this.transports) await transport.close();
    return this.summary(ticks);
  }

  // ------------------------------------------------------------------ links

  private accept(link: Link, transport: TransportName): void {
    const conn: Conn = {
      link,
      state: 'hello',
      voiceWindowStart: -Infinity,
      voiceInWindow: 0,
      chatTokens: CHAT_BURST,
      chatAt: performance.now(),
      spokeAt: -Infinity,
      badMessages: 0,
      portal: -1,
      height: DEFAULT_HEIGHT_CM,
      teleportAt: -Infinity,
      appearanceAt: -Infinity,
      wearAt: -Infinity,
      faceAt: -Infinity,
      forceMuted: false,
      role: 'visitor',
      voiceRange: this.voice.config.rangeM,
      voiceGain: GAIN_UNITY,
      quiet: false,
      privateZone: -1,
      blocks: new Set(),
      hidden: [],
      zones: new Set(),
    };
    conn.sink = { send: (type, m) => this.send(conn, type, encodeMessage({ type, ...m } as Message)) };
    this.conns.add(conn);
    this.events.add(`link:${transport}`, 0);
    conn.helloTimer = setTimeout(() => {
      if (conn.state === 'hello') this.refuse(conn, { reason: 'error', protocolMin: this.policy.min, protocolMax: this.policy.max, detail: 'no hello in time' });
    }, this.options.helloTimeoutMs);
    link.onMessage((channel, bytes) => this.receive(conn, channel, bytes));
    link.onClose((reason) => this.closed(conn, reason));
  }

  private receive(conn: Conn, channel: Channel, bytes: Uint8Array): void {
    if (conn.state === 'closed') return;
    let message: Message;
    try {
      message = decodeMessage(bytes, 'client');
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.events.add(`bad:${err.code}`, bytes.length);
      conn.badMessages += 1;
      if (conn.badMessages > MAX_BAD_MESSAGES) conn.link.close('too many malformed messages');
      return;
    }
    if (messageDef(message.type).channel !== channel) {
      this.events.add('bad:wrong-channel', bytes.length);
      return;
    }
    this.received.add(message.type, bytes.length);
    if (conn.state === 'hello') {
      if (message.type === 'hello') void this.join(conn, message);
      return;
    }
    if (conn.state !== 'joined' || conn.entity === undefined) return;
    const now = performance.now();
    switch (message.type) {
      case 'pose':
        this.events.add(`pose:${this.world.applyPose(conn.entity, message, now)}`, 0);
        if (this.options.portals?.length) this.portalCheck(conn);
        if (this.options.zones?.length) this.zoneCheck(conn);
        break;
      case 'voice':
        this.voiceIn(conn, message, now);
        break;
      case 'say': {
        conn.chatTokens = Math.min(CHAT_BURST, conn.chatTokens + (now - conn.chatAt) / CHAT_EVERY_MS);
        conn.chatAt = now;
        if (conn.chatTokens < 1) {
          this.events.add('chat:throttled', 0);
          break;
        }
        conn.chatTokens -= 1;
        const text = cleanChat(message.text);
        if (!text) break;
        const player = this.pluginPlayer(conn);
        if (text.startsWith('/') && player) {
          // A command for the world's plugins, never shown to everyone.
          const [name = '', ...args] = text.slice(1).split(/\s+/).filter(Boolean);
          if (name) this.plugins?.notify('on_command', player, name.toLowerCase().slice(0, 32), args.slice(0, 16));
          this.events.add('command', 0);
          break;
        }
        const line = player && this.plugins ? this.plugins.chat(player, text) : text;
        if (line) this.chat(conn.entity, cleanChat(line));
        break;
      }
      case 'ping':
        this.send(conn, 'pong', encodeMessage({ type: 'pong', id: message.id, time: message.time }));
        break;
      case 'fetch':
        if (this.options.content && conn.sink) this.options.content.fetch(conn.sink, message.hash, message.from);
        else if (conn.sink) conn.sink.send('notFound', { hash: message.hash });
        break;
      case 'unfetch':
        if (conn.sink) this.options.content?.unfetch(conn.sink, message.hash);
        break;
      case 'appearance':
        this.appearance(conn, message.height, now, message.proportions);
        break;
      case 'wear':
        void this.wear(conn, message.token, now);
        break;
      case 'face':
        this.face(conn, message, now);
        break;
      case 'teleport':
        this.events.add(`teleport:${this.teleport(conn, message, now)}`, 0);
        break;
      case 'role':
        this.events.add(`role:${this.giveRole(conn, message.account, message.role) ? 'given' : 'refused'}`, 0);
        break;
      case 'moderate':
        this.events.add(`moderate:${this.moderate(conn, message) ? message.action : 'refused'}`, 0);
        break;
      case 'block':
        // The player blocked or unblocked someone here; the core keeps it for every other world.
        if (message.on) conn.blocks.add(message.account);
        else conn.blocks.delete(message.account);
        this.events.add(`block:${message.on ? 'on' : 'off'}`, 0);
        this.updateHidden();
        break;
      case 'put':
        this.put(conn, message);
        break;
      case 'publish':
        void this.publish(conn, message.world);
        break;
      case 'leave':
        conn.link.close(`leave: ${message.reason}`);
        break;
      default:
        break;
    }
  }

  private async join(conn: Conn, hello: MessageOf<'hello'>): Promise<void> {
    conn.state = 'joining';
    const started = performance.now();
    const version = checkVersion(hello, this.policy);
    if (version) return this.refuse(conn, version);
    const base = { protocolMin: this.policy.min, protocolMax: this.policy.max };
    const key = this.options.worldKey;
    if (!key) return this.refuse(conn, { reason: 'error', ...base, detail: 'this world takes no joins' });
    let opened: Awaited<ReturnType<typeof openToken>>;
    try {
      opened = await openToken(hello.token, { key, world: this.options.worldId, now: this.options.unixNow() });
    } catch (err) {
      if (!(err instanceof TokenError)) throw err;
      const reason: Refusal['reason'] = err.code === 'expired' ? 'token-expired' : err.code === 'wrong-world' ? 'wrong-world' : 'token-invalid';
      return this.refuse(conn, { reason, ...base, detail: '' });
    }
    if (conn.state !== 'joining') return;
    const nonce = toHex(opened.header.nonce);
    this.dropExpiredNonces();
    if (this.seenNonces.has(nonce)) return this.refuse(conn, { reason: 'token-replayed', ...base, detail: '' });
    this.seenNonces.set(nonce, opened.header.expiresAt);
    // An account already here (another window, a lost connection) makes room for itself.
    const earlier = [...this.byEntity.values()].find((c) => c.account === opened.claims.account);
    if (this.byEntity.size - (earlier ? 1 : 0) >= this.capacity) return this.refuse(conn, { reason: 'full', ...base, detail: '' });
    // The owner is never banned from its own world (S3.07); the world remembers who it is.
    if (opened.claims.owner && this.owner !== opened.claims.account) {
      this.ownerAccount = opened.claims.account;
      this.options.store?.setOwner(opened.claims.account);
    }
    const ban = opened.claims.owner ? undefined : this.banOf(opened.claims.account);
    if (ban !== undefined) return this.refuse(conn, { reason: 'banned', ...base, detail: fitBytes(ban, 160) });
    const role: Role = opened.claims.owner ? 'owner' : this.storedRole(opened.claims.account);
    for (const rule of this.options.entryRules) {
      const verdict = rule(opened.claims, { players: this.byEntity.size, capacity: this.capacity });
      if (!verdict.admit) return this.refuse(conn, { reason: 'rule', ...base, detail: verdict.detail.slice(0, 160) });
    }
    if (this.plugins) {
      const c = opened.claims;
      const verdict = this.plugins.joinRequest({ account: c.account, name: c.name, trust: c.trust, tester: c.tester, emailVerified: c.emailVerified, ageDays: c.ageDays, under18: c.under18, role, players: this.byEntity.size, capacity: this.capacity });
      if (!verdict.admit) return this.refuse(conn, { reason: 'rule', ...base, detail: verdict.reason.slice(0, 160) });
    }
    if (earlier) this.kick(earlier, 'kicked', 'joined again from somewhere else');
    const entity = this.allocate();
    if (entity === undefined) return this.refuse(conn, { reason: 'full', ...base, detail: '' });

    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.state = 'joined';
    conn.entity = entity;
    conn.account = opened.claims.account;
    conn.name = opened.claims.name;
    conn.claims = opened.claims;
    conn.role = role;
    conn.blocks = new Set(opened.claims.blocks);
    conn.joinedAt = performance.now();
    const size = this.world.config.size;
    const sp = this.options.spawn;
    const angle = this.random() * Math.PI * 2;
    const radius = sp ? Math.sqrt(this.random()) * sp.r : 0;
    const points = this.spawnChoices(hello.spawn);
    const returning = hello.spawn ? undefined : this.options.store?.place(opened.claims.account);
    const point = returning ?? (points.length > 0 ? points[Math.floor(this.random() * points.length)] : undefined);
    const at = point
      ? { x: point.x, y: point.y, z: point.z }
      : sp
        ? { x: sp.x + Math.cos(angle) * radius, y: sp.y ?? 0, z: sp.z + Math.sin(angle) * radius }
        : { x: this.random() * size, y: 0, z: this.random() * size };
    const yaw = point?.yaw ?? sp?.yaw ?? this.random() * Math.PI * 2 - Math.PI;
    this.world.add(entity, at, yaw, performance.now());
    // Arriving inside a portal does not send the player straight back: only entering one counts.
    conn.portal = this.options.portals?.findIndex((b) => insideBox(b, at)) ?? -1;
    conn.height = this.fitHeight(hello.height);
    this.byEntity.set(entity, conn);
    const player: RosterPlayer = {
      entity,
      account: opened.claims.account,
      name: opened.claims.name,
      trust: opened.claims.trust,
      height: conn.height,
      role,
      face: { ...NEUTRAL_FACE },
      proportions: fitProportions(hello.proportions),
      // The avatar the core vouches the account wears (S4.05): clients fetch it from the core by hash.
      ...(opened.claims.avatar ? { avatar: opened.claims.avatar } : {}),
    };
    this.roster.set(entity, player);
    this.joinedThisTick.push(player);
    this.peakPlayers = Math.max(this.peakPlayers, this.byEntity.size);

    this.send(conn, 'welcome', encodeMessage({ type: 'welcome', protocol: PROTOCOL_VERSION, build: this.options.build, world: this.options.worldId, entity, tickHz: this.options.tickHz, tick: this.tickNo }));
    const roster = encodeMessage({ type: 'roster', full: true, players: [...this.roster.values()], left: [] });
    this.send(conn, 'roster', roster);
    // A moderator's mute outlasts leaving and coming back (S3.07).
    const mute = opened.claims.owner ? undefined : this.muteOf(opened.claims.account);
    if (mute !== undefined) {
      conn.forceMuted = true;
      this.send(conn, 'muted', encodeMessage({ type: 'muted', on: true, reason: fitBytes(mute, 160) }));
    }
    this.rosterBytes.add(roster.length);
    if (conn.sink) this.options.content?.announce(conn.sink);
    this.joinMs.add(performance.now() - started);
    this.events.add('join', 0);
    const joined = this.pluginPlayer(conn);
    if (joined) this.plugins?.notify('on_join', joined);
    // The zones it arrives in count from the first step, not from its first pose (S3.08).
    if (this.options.zones?.length) this.zoneCheck(conn);
    this.updateVoice(conn);
    this.updateHidden();
  }

  /** A chosen height in centimetres (0: the platform's default) fitted into the world's range. */
  fitHeight(cm: number): number {
    const range = this.options.heights ?? DEFAULT_HEIGHTS;
    const wanted = cm > 0 ? cm : DEFAULT_HEIGHT_CM;
    return Math.round(Math.min(range.max * 100, Math.max(range.min * 100, wanted)));
  }

  /** A new height: fitted, then announced as a roster change (at most once a second). */
  private appearance(conn: Conn, cm: number, now: number, proportions?: Proportions): void {
    if (conn.entity === undefined || now - conn.appearanceAt < APPEARANCE_EVERY_MS) return;
    conn.appearanceAt = now;
    const height = this.fitHeight(cm);
    const player = this.roster.get(conn.entity);
    if (!player) return;
    const shaped = proportions ? fitProportions(proportions) : player.proportions;
    const same = (a: Proportions, b: Proportions): boolean => a.width === b.width && a.arms === b.arms && a.legs === b.legs && a.head === b.head;
    if (height === conn.height && same(shaped, player.proportions)) return;
    conn.height = height;
    player.height = height;
    player.proportions = shaped;
    this.joinedThisTick.push(player);
    this.events.add('appearance', 0);
  }

  /** A new avatar during the visit (S4.05): a fresh connect token for this world, of this same
   *  account, whose `avatar` replaces the roster's; a replayed or someone else's token is refused. */
  private async wear(conn: Conn, token: Uint8Array, now: number): Promise<void> {
    const key = this.options.worldKey;
    if (!key || conn.entity === undefined || now - conn.wearAt < WEAR_EVERY_MS) return;
    conn.wearAt = now;
    let opened: Awaited<ReturnType<typeof openToken>>;
    try {
      opened = await openToken(token, { key, world: this.options.worldId, now: this.options.unixNow() });
    } catch (err) {
      if (!(err instanceof TokenError)) throw err;
      this.events.add('wear:refused', 0);
      return;
    }
    const nonce = toHex(opened.header.nonce);
    if (this.seenNonces.has(nonce) || opened.claims.account !== conn.account || conn.entity === undefined) {
      this.events.add('wear:refused', 0);
      return;
    }
    this.seenNonces.set(nonce, opened.header.expiresAt);
    const player = this.roster.get(conn.entity);
    if (!player) return;
    if (opened.claims.avatar) player.avatar = opened.claims.avatar;
    else delete player.avatar;
    this.joinedThisTick.push(player);
    this.events.add('wear', 0);
  }

  /** The player's face and hands (S4.07), kept in the roster and announced as a change. */
  private face(conn: Conn, m: MessageOf<'face'>, now: number): void {
    if (conn.entity === undefined || now - conn.faceAt < FACE_EVERY_MS) return;
    const player = this.roster.get(conn.entity);
    if (!player) return;
    if (player.face.expression === m.expression && player.face.left === m.left && player.face.right === m.right) return;
    conn.faceAt = now;
    player.face = { expression: m.expression, left: m.left, right: m.right };
    this.joinedThisTick.push(player);
    this.events.add('face', 0);
  }

  /** Puts the player on a seat or a clicked spot when the world's rules allow it, and answers
   *  `placed` either way. */
  private teleport(conn: Conn, m: MessageOf<'teleport'>, now: number): 'placed' | 'refused' {
    const p = conn.entity === undefined ? undefined : this.world.players.get(conn.entity);
    if (!p) return 'refused';
    const answer = (accepted: boolean): 'placed' | 'refused' => {
      this.send(conn, 'placed', encodeMessage({ type: 'placed', position: { x: p.x, y: p.y, z: p.z }, yaw: p.yaw, stance: p.stance, accepted }));
      return accepted ? 'placed' : 'refused';
    };
    if (now - conn.teleportAt < TELEPORT.everyMs) return answer(false);
    let to: { x: number; y: number; z: number } | undefined;
    let yaw = m.yaw;
    let stance: 'standing' | 'sitting' = 'standing';
    if (m.seat !== undefined) {
      const seat = this.options.seats?.[m.seat];
      if (!seat || Math.hypot(seat.position[0] - p.x, seat.position[2] - p.z) > TELEPORT.seatReach) return answer(false);
      to = { x: seat.position[0], y: seat.position[1], z: seat.position[2] };
      yaw = seat.yaw;
      stance = 'sitting';
    } else {
      if (!Number.isFinite(m.position.x) || Math.hypot(m.position.x - p.x, m.position.z - p.z) > TELEPORT.range) return answer(false);
      to = this.landing(m.position);
    }
    if (!to) return answer(false);
    conn.teleportAt = now;
    this.world.place(conn.entity!, to, yaw, stance, now);
    if (this.options.portals?.length) conn.portal = this.options.portals.findIndex((b) => insideBox(b, to));
    return answer(true);
  }

  /** Where a clicked spot lands: in the world, and walkable unless the world allows flying. */
  private landing(at: { x: number; y: number; z: number }): { x: number; y: number; z: number } | undefined {
    const size = this.world.config.size;
    if (at.x < 0 || at.z < 0 || at.x > size || at.z > size || at.y < -100 || at.y > 500) return undefined;
    if (this.world.config.flying) return { ...at };
    if (this.options.walkable) return this.options.walkable.nearest(at);
    // A code-made map: its boxes are its real solids. Not inside one, and standing on one (or on
    // the ground at 0 in a map without a floor).
    const solids: readonly Box[] = this.world.config.solids ?? [];
    const inside = solids.some((b) => at.x > b.min.x && at.x < b.max.x && at.z > b.min.z && at.z < b.max.z && at.y + 0.05 > b.min.y && at.y + 0.05 < b.max.y);
    const ground = Math.max(0, groundBelow(at.x, at.y + 0.3, at.z, solids));
    if (inside || at.y - ground > 0.6 || at.y < ground - 0.3) return undefined;
    return { x: at.x, y: ground, z: at.z };
  }

  // ------------------------------------------------------------------ plugins (S3.01)

  private plugins: Plugins | undefined;
  /** Bans kept in memory when the world has no database. */
  private readonly bans = new Map<string, { until: number | undefined; reason: string }>();

  /** Runs these plugins' hooks from now on. */
  usePlugins(plugins: Plugins): void {
    this.plugins = plugins;
  }

  get id(): string {
    return this.options.worldId;
  }

  get name(): string {
    return this.options.name ?? 'A world';
  }

  private pluginPlayer(conn: Conn): PluginPlayer | undefined {
    const c = conn.claims;
    if (conn.entity === undefined || !c) return undefined;
    return { entity: conn.entity, account: c.account, name: c.name, trust: c.trust, tester: c.tester, emailVerified: c.emailVerified, ageDays: c.ageDays, under18: c.under18, role: conn.role };
  }

  pluginPlayers(): PluginPlayer[] {
    return [...this.byEntity.values()].flatMap((c) => this.pluginPlayer(c) ?? []);
  }

  pluginSay(text: string, to?: number): void {
    const line = cleanChat(text);
    if (!line) return;
    const bytes = encodeMessage({ type: 'chat', text: line });
    const targets = to === undefined ? [...this.byEntity.values()] : [this.byEntity.get(to)].filter((c): c is Conn => c !== undefined);
    for (const conn of targets) this.send(conn, 'chat', bytes);
  }

  pluginKick(entity: number, reason: string): void {
    const conn = this.byEntity.get(entity);
    if (conn) this.kick(conn, 'kicked', reason);
  }

  /** Bans an account here (for `minutes`, or until lifted) and ends its connection. */
  pluginBan(account: string, minutes: number | undefined, reason: string): void {
    this.ban(account, minutes === undefined || !(minutes > 0) ? undefined : Date.now() + minutes * 60_000, reason);
  }

  pluginUnban(account: string): void {
    this.unban(account);
  }

  private ownerAccount: string | undefined;
  private readonly mutes = new Map<string, { until: number | undefined; reason: string }>();

  /** The world's owner once it has joined (S3.07): nobody bans or mutes it here. */
  get owner(): string | undefined {
    return this.options.store?.owner() ?? this.ownerAccount;
  }

  private ban(account: string, until: number | undefined, reason: string): void {
    if (account === this.owner) return;
    if (this.options.store) this.options.store.ban(account, until, reason);
    else this.bans.set(account, { until, reason });
    for (const conn of this.byEntity.values()) if (conn.account === account) this.kick(conn, 'banned', reason);
    this.events.add('ban', 0);
  }

  private unban(account: string): void {
    this.options.store?.unban(account);
    this.bans.delete(account);
  }

  /** Lifts a ban the world's owner reversed on appeal, through the core (S3.07). */
  liftBanOnAppeal(account: string): void {
    this.unban(account);
    this.options.store?.logModeration({ actor: 'appeal', target: account, action: 'unban', minutes: 0, reason: 'reversed on appeal' });
    this.events.add('appeal:unban', 0);
  }

  /** A mute's reason while an account is muted here; a lapsed one is lifted. */
  private muteOf(account: string): string | undefined {
    const stored = this.options.store?.muted(account);
    if (stored !== undefined) return stored;
    const m = this.mutes.get(account);
    if (!m) return undefined;
    if (m.until !== undefined && m.until <= Date.now()) {
      this.mutes.delete(account);
      return undefined;
    }
    return m.reason;
  }

  /** Mutes or unmutes an account here; it is told, with the reason. */
  private mute(account: string, on: boolean, until: number | undefined, reason: string): void {
    if (on) {
      if (this.options.store) this.options.store.mute(account, until, reason);
      else this.mutes.set(account, { until, reason });
    } else {
      this.options.store?.unmute(account);
      this.mutes.delete(account);
    }
    for (const conn of this.byEntity.values()) {
      if (conn.account !== account) continue;
      conn.forceMuted = on;
      this.send(conn, 'muted', encodeMessage({ type: 'muted', on, reason: on ? fitBytes(reason, 160) : '' }));
    }
  }

  /** A moderator's action on an account here (S3.07): only from someone holding the moderate
   *  right, over someone below them, never the owner, never oneself; a kick, ban or mute needs a
   *  reason, which the player is told (the statement of reasons), and every action goes into the
   *  world's record. */
  private moderate(by: Conn, m: MessageOf<'moderate'>): boolean {
    const here = [...this.byEntity.values()].filter((c) => c.account === m.account);
    const current = here[0]?.role ?? this.storedRole(m.account);
    if (!can(by.role, 'moderate') || by.account === undefined || m.account === by.account || m.account === this.owner || roleRank(current) >= roleRank(by.role)) return false;
    const reason = cleanChat(m.reason);
    if (!reason && (m.action === 'kick' || m.action === 'ban' || m.action === 'mute')) return false;
    const until = m.minutes > 0 ? Date.now() + Math.min(m.minutes, 525_600) * 60_000 : undefined;
    switch (m.action) {
      case 'kick':
        if (here.length === 0) return false;
        for (const c of here) this.kick(c, 'kicked', reason);
        break;
      case 'ban':
        this.ban(m.account, until, reason);
        break;
      case 'unban':
        this.unban(m.account);
        break;
      case 'mute':
        this.mute(m.account, true, until, reason);
        break;
      case 'unmute':
        this.mute(m.account, false, undefined, '');
        break;
    }
    this.options.store?.logModeration({ actor: by.account, target: m.account, action: m.action, minutes: m.minutes, reason });
    return true;
  }

  private readonly roles = new Map<string, Role>();

  /** An account's role as this world keeps it (the owner's comes from its token). */
  private storedRole(account: string): Role {
    return this.options.store?.role(account) ?? this.roles.get(account) ?? 'visitor';
  }

  /** Gives an account a role here (S3.06): only someone holding the roles right, only a role below
   *  their own, never over someone at or above it, never to themselves; the owner is the core's. */
  private giveRole(by: Conn, account: string, role: Role): boolean {
    const here = [...this.byEntity.values()].filter((c) => c.account === account);
    const current = here[0]?.role ?? this.storedRole(account);
    const mine = roleRank(by.role);
    if (!can(by.role, 'roles') || account === by.account || role === 'owner' || current === 'owner' || roleRank(role) >= mine || roleRank(current) >= mine) return false;
    if (this.options.store) this.options.store.setRole(account, role);
    else if (role === 'visitor') this.roles.delete(account);
    else this.roles.set(account, role);
    for (const c of here) {
      c.role = role;
      const player = c.entity === undefined ? undefined : this.roster.get(c.entity);
      if (!player) continue;
      player.role = role;
      this.joinedThisTick.push(player);
    }
    return true;
  }

  /** A piece of a new build, from someone with build rights (S3.06). */
  private put(conn: Conn, m: MessageOf<'put'>): void {
    const uploads = this.options.uploads;
    if (!uploads || conn.entity === undefined) return this.published(conn, false, 'this world takes no builds: it was not started from a built folder');
    if (!can(conn.role, 'build')) return this.published(conn, false, 'only a builder, an admin or the owner may change this world');
    try {
      const at = uploads.put(conn.entity, m.hash, m.offset, m.total, m.data);
      this.send(conn, 'got', encodeMessage({ type: 'got', hash: m.hash, offset: at }));
    } catch (err) {
      if (!(err instanceof UploadError)) throw err;
      uploads.forget(conn.entity);
      this.published(conn, false, err.message);
    }
  }

  /** Checks an uploaded build and puts it in place; the program then restarts on it. */
  private async publish(conn: Conn, world: Uint8Array): Promise<void> {
    const uploads = this.options.uploads;
    if (!uploads || conn.entity === undefined) return this.published(conn, false, 'this world takes no builds: it was not started from a built folder');
    if (!can(conn.role, 'build')) return this.published(conn, false, 'only a builder, an admin or the owner may change this world');
    const entity = conn.entity;
    try {
      const built = await uploads.publish(entity, world);
      this.published(conn, true, '');
      this.options.log('build-published', { name: built.name, files: built.files, role: conn.role });
      this.events.add('build:published', 0);
      this.options.onPublished?.(built);
    } catch (err) {
      if (!(err instanceof UploadError)) throw err;
      uploads.forget(entity);
      this.published(conn, false, err.message);
    }
  }

  private published(conn: Conn, ok: boolean, detail: string): void {
    this.events.add(`build:${ok ? 'ok' : 'refused'}`, 0);
    this.send(conn, 'published', encodeMessage({ type: 'published', ok, detail: fitBytes(detail, 160) }));
  }

  /** Why an account is banned here, if it is. */
  private banOf(account: string): string | undefined {
    const stored = this.options.store?.banned(account);
    if (stored !== undefined) return stored;
    const b = this.bans.get(account);
    if (!b) return undefined;
    if (b.until !== undefined && b.until <= Date.now()) {
      this.bans.delete(account);
      return undefined;
    }
    return b.reason;
  }

  pluginForceMute(entity: number, on: boolean): void {
    const conn = this.byEntity.get(entity);
    if (!conn || conn.forceMuted === on) return;
    conn.forceMuted = on;
    this.send(conn, 'muted', encodeMessage({ type: 'muted', on, reason: '' }));
  }

  private readonly scopes = new Map<string, Map<string, string>>();

  pluginStore(scope: string): { get(key: string): string | undefined; set(key: string, value: string): boolean; delete(key: string): void; keys(): string[] } {
    const store = this.options.store;
    if (store) {
      return {
        get: (key) => {
          const v = store.get(scope, key);
          return v ? new TextDecoder().decode(v) : undefined;
        },
        set: (key, value) => store.set(scope, key, new TextEncoder().encode(String(value))),
        delete: (key) => store.delete(scope, key),
        keys: () => store.keys(scope),
      };
    }
    let m = this.scopes.get(scope);
    if (!m) this.scopes.set(scope, (m = new Map()));
    const map = m;
    return {
      get: (key) => map.get(key),
      set: (key, value) => {
        // The same limits as the world's database, so a plugin behaves alike with and without one.
        const text = String(value);
        if (key.length === 0 || key.length > STORE_LIMITS.key || Buffer.byteLength(text) > STORE_LIMITS.value) return false;
        if (map.size >= STORE_LIMITS.keys && !map.has(key)) return false;
        map.set(key, text);
        return true;
      },
      delete: (key) => void map.delete(key),
      keys: () => [...map.keys()].sort(),
    };
  }

  /** Zones entered and left since the last pose, for the plugins (and S3.08's voice rules). */
  private zoneCheck(conn: Conn): void {
    const p = conn.entity === undefined ? undefined : this.world.players.get(conn.entity);
    const player = this.pluginPlayer(conn);
    if (!p || !player) return;
    const zones = this.options.zones!;
    const now = new Set<number>();
    zones.forEach((z, i) => {
      if (insideBox(z, p)) now.add(i);
    });
    const changed = now.size !== conn.zones.size || [...now].some((i) => !conn.zones.has(i));
    for (const i of now) if (!conn.zones.has(i)) this.plugins?.notify('on_zone_enter', player, { index: i, kind: zones[i]!.kind });
    for (const i of conn.zones) if (!now.has(i)) this.plugins?.notify('on_zone_exit', player, { index: i, kind: zones[i]!.kind });
    conn.zones = now;
    if (changed) this.updateVoice(conn);
  }

  /** Who hears whom, how far and how loud (S3.08): each speaker's range and gain, and quiet and
   *  private zones (S3.10's minors and S3.11's blocks join here). */
  private readonly voiceRules: VoiceRules = {
    rangeOf: (entity) => this.byEntity.get(entity)?.voiceRange ?? this.voice.config.rangeM,
    gainOf: (entity) => this.byEntity.get(entity)?.voiceGain ?? GAIN_UNITY,
    canHear: (listener, speaker) => {
      const l = this.byEntity.get(listener);
      const s = this.byEntity.get(speaker);
      if (!l || !s || l.quiet || s.quiet) return false;
      return l.privateZone === s.privateZone && !this.apart(l, s) && this.mayReach(l, s);
    },
  };

  /** A player's voice from the zones it stands in (a voice zone's range and gain; quiet; private),
   *  then the plugins' `on_voice_settings`; a minor's carries no farther and no louder than the
   *  world's default, whatever a zone or a plugin says (S3.10). */
  private updateVoice(conn: Conn): void {
    const zones = this.options.zones ?? [];
    let range = this.voice.config.rangeM;
    let gain = 1;
    let quiet = false;
    let privateZone = -1;
    for (const i of [...conn.zones].sort((a, b) => a - b)) {
      const z = zones[i];
      if (!z) continue;
      if (z.kind === 'quiet') quiet = true;
      else if (z.kind === 'private') privateZone = privateZone === -1 ? i : privateZone;
      else {
        if (z.range !== undefined) range = z.range;
        if (z.gain !== undefined) gain = z.gain;
      }
    }
    const player = this.pluginPlayer(conn);
    const set = player && this.plugins ? this.plugins.voiceSettings(player) : {};
    if (typeof set.range === 'number' && Number.isFinite(set.range)) range = set.range;
    if (typeof set.gain === 'number' && Number.isFinite(set.gain)) gain = set.gain;
    if (conn.claims?.under18) {
      range = Math.min(range, this.voice.config.rangeM);
      gain = Math.min(gain, 1);
    }
    conn.voiceRange = Math.min(MAX_RANGE_M, Math.max(1, range));
    conn.voiceGain = Math.min(255, Math.max(0, Math.round(gain * GAIN_UNITY)));
    conn.quiet = quiet;
    conn.privateZone = privateZone;
  }

  /** The spawn points a join may use: the named group's when it has any, else the main ones. */
  private spawnChoices(group: string): ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> {
    const all = this.options.spawnPoints ?? [];
    const named = group ? all.filter((p) => p.group === group) : [];
    if (named.length > 0) return named;
    const main = all.filter((p) => p.main !== false);
    return main.length > 0 ? main : all;
  }

  /** Sends `portal` when the player's position has just entered a portal's box. */
  private portalCheck(conn: Conn): void {
    const p = conn.entity === undefined ? undefined : this.world.players.get(conn.entity);
    if (!p) return;
    const portals = this.options.portals!;
    const inside = portals.findIndex((b) => insideBox(b, p));
    if (inside === conn.portal) return;
    conn.portal = inside;
    if (inside < 0) return;
    const to = portals[inside]!;
    this.send(conn, 'portal', encodeMessage({ type: 'portal', world: to.world, spawn: fitBytes(to.spawn, 32) }));
    this.events.add('portal', 0);
  }

  /** Ends a joined player's connection with a reason it is shown. */
  kick(conn: Conn, reason: MessageBody<'leave'>['reason'], detail: string): void {
    if (conn.state !== 'joined') return;
    this.send(conn, 'leave', encodeMessage({ type: 'leave', reason, detail: detail.slice(0, 160) }));
    this.events.add(`kick:${reason}`, 0);
    const link = conn.link;
    this.closed(conn, `kicked: ${reason}`);
    setTimeout(() => link.close(`kicked: ${reason}`), 100);
  }

  private refuse(conn: Conn, refusal: Refusal): void {
    this.events.add(`refuse:${refusal.reason}`, 0);
    this.send(conn, 'refuse', encodeMessage({ type: 'refuse', ...refusal }));
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    setTimeout(() => conn.link.close(`refused: ${refusal.reason}`), 100);
    conn.state = 'closed';
  }

  private closed(conn: Conn, reason: string): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    this.conns.delete(conn);
    const entity = conn.entity;
    conn.state = 'closed';
    if (entity === undefined || this.byEntity.get(entity) !== conn) return;
    const leaving = this.pluginPlayer(conn);
    this.byEntity.delete(entity);
    this.roster.delete(entity);
    if (leaving) this.plugins?.notify('on_leave', leaving, reason.startsWith('leave: ') ? reason.slice(7) : reason);
    if (conn.sink) this.options.content?.forget(conn.sink);
    this.options.uploads?.forget(entity);
    const p = this.world.players.get(entity);
    if (p && conn.account) this.options.store?.savePlace(conn.account, { x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    this.world.remove(entity);
    this.voice.forget(entity);
    this.freedThisTick.push(entity);
    this.leftThisTick.push(entity);
    // An entity number comes back for someone else: nobody keeps it hidden.
    this.updateHidden();
    this.events.add(`leave:${reason.startsWith('leave: ') ? reason.slice(7) : reason}`, 0);
  }

  private allocate(): number | undefined {
    const reused = this.freeEntities.shift();
    if (reused !== undefined) return reused;
    if (this.nextEntity > MAX_ENTITY) return undefined;
    return this.nextEntity++;
  }

  private dropExpiredNonces(): void {
    const now = this.options.unixNow();
    for (const [nonce, expiresAt] of this.seenNonces) if (expiresAt <= now) this.seenNonces.delete(nonce);
  }

  private send(conn: Conn, type: MessageName, bytes: Uint8Array): void {
    conn.link.send(messageDef(type).channel, bytes);
    this.sent.add(type, bytes.length);
  }

  // ------------------------------------------------------------------- loops

  private tick(tick: number): void {
    this.tickNo = tick;
    this.plugins?.notify('on_tick', tick);
    const { snapshots, stats } = this.world.tick(tick);
    for (const [entity, messages] of snapshots) {
      const conn = this.byEntity.get(entity);
      if (!conn) continue;
      for (const m of messages) this.send(conn, 'snapshot', m);
    }
    this.encodings.add(stats.encodings);
    this.busyCells.add(stats.busyCells);
    for (const join of stats.joins) this.joinSnapshotBytes.add(join.bytes);
    if (this.joinedThisTick.length > 0 || this.leftThisTick.length > 0) {
      const delta = encodeMessage({ type: 'roster', full: false, players: this.joinedThisTick.slice(0, 256), left: this.leftThisTick.slice(0, 256) });
      this.joinedThisTick = this.joinedThisTick.slice(256);
      this.leftThisTick = this.leftThisTick.slice(256);
      for (const conn of this.byEntity.values()) this.send(conn, 'roster', delta);
    }
    if (this.leftThisTick.length === 0 && this.freedThisTick.length > 0) {
      this.freeEntities.push(...this.freedThisTick);
      this.freedThisTick = [];
    }
  }

  private contentBusy = false;

  private voiceStep(): void {
    // Downloads move on at the voice ticker's 50 Hz, one step at a time.
    if (this.options.content && !this.contentBusy && this.options.content.pending > 0) {
      this.contentBusy = true;
      void this.options.content.step().finally(() => {
        this.contentBusy = false;
      });
    }
    const { bundles } = this.voice.step(this.world, this.voiceRules);
    for (const [entity, bytes] of bundles) {
      const conn = this.byEntity.get(entity);
      if (conn) this.send(conn, 'voiceBundle', bytes);
    }
  }

  private voiceIn(conn: Conn, message: MessageOf<'voice'>, now: number): void {
    if (now - conn.voiceWindowStart >= 1000) {
      conn.voiceWindowStart = now;
      conn.voiceInWindow = 0;
    }
    conn.voiceInWindow += 1;
    if (conn.voiceInWindow > VOICE_FRAMES_PER_SECOND) {
      this.events.add('voice:throttled', 0);
      return;
    }
    conn.spokeAt = now;
    if (conn.forceMuted) {
      this.events.add('voice:muted', 0);
      return;
    }
    this.voice.push({ from: conn.entity!, seq: message.seq, start: message.start, mouth: message.mouth, opus: message.opus });
  }

  /** World-wide (S1.10): everyone here reads it, except across a block (S3.11) and a minor's
   *  strangers (S3.10), both ways. */
  private chat(from: number, text: string): void {
    const bytes = encodeMessage({ type: 'chat', from, text });
    const speaker = this.byEntity.get(from);
    for (const conn of this.byEntity.values()) {
      if (speaker && conn !== speaker && (this.apart(speaker, conn) || !this.mayReach(speaker, conn))) continue;
      this.send(conn, 'chat', bytes);
    }
    this.events.add('chat', bytes.length);
  }

  /** Two players kept apart by a block, made by either (S3.11). */
  private apart(a: Conn, b: Conn): boolean {
    return (b.account !== undefined && a.blocks.has(b.account)) || (a.account !== undefined && b.blocks.has(a.account));
  }

  /** Whether two players may reach each other by voice and text (S3.10): a player aged 13 to 17
   *  only with its accepted friends, unless its guardian widened it (or narrowed it to nobody). */
  private mayReach(a: Conn, b: Conn): boolean {
    const allows = (x: Conn, y: Conn): boolean => {
      const c = x.claims;
      if (!c?.under18) return true;
      if (c.contact === 'everyone') return true;
      if (c.contact === 'none') return false;
      return y.account !== undefined && c.friends.includes(y.account);
    };
    return allows(a, b) && allows(b, a);
  }

  /** Tells every player whose list changed which entities it is kept apart from (S3.11). */
  private updateHidden(): void {
    const all = [...this.byEntity.values()];
    for (const conn of all) {
      const hidden = all.filter((o) => o !== conn && o.entity !== undefined && this.apart(conn, o)).map((o) => o.entity!).sort((x, y) => x - y);
      if (hidden.length === conn.hidden.length && hidden.every((e, i) => e === conn.hidden[i])) continue;
      conn.hidden = hidden;
      this.send(conn, 'hidden', encodeMessage({ type: 'hidden', entities: hidden.slice(0, 256) }));
    }
  }

  private traceFrame(): void {
    const now = performance.now();
    const players: TraceFrame['players'] = [];
    for (const [entity, conn] of this.byEntity) {
      const p = this.world.players.get(entity);
      if (p) players.push([entity, Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10, now - conn.spokeAt < TRACE_MS ? 1 : 0]);
    }
    this.options.trace?.({ t: Math.round(now - this.started), players });
  }

  // ----------------------------------------------------------------- metrics

  private linkTotals(): Record<string, number> {
    const totals = { links: 0, dropped: 0, datagramsSent: 0, datagramBytesSent: 0, datagramsReceived: 0, datagramBytesReceived: 0, retransmits: 0 };
    for (const conn of this.conns) {
      const s = conn.link.stats();
      totals.links += 1;
      totals.dropped += s.dropped;
      totals.datagramsSent += s.datagramsSent ?? 0;
      totals.datagramBytesSent += s.datagramBytesSent ?? 0;
      totals.datagramsReceived += s.datagramsReceived ?? 0;
      totals.datagramBytesReceived += s.datagramBytesReceived ?? 0;
      totals.retransmits += s.retransmits ?? 0;
    }
    return totals;
  }

  private reportWindow(): void {
    const now = performance.now();
    const cpu = process.cpuUsage(this.cpuMark);
    const cpuPct = ((cpu.user + cpu.system) / 1000 / (now - this.cpuAt)) * 100;
    const elu = performance.eventLoopUtilization(this.eluMark);
    this.cpuMark = process.cpuUsage();
    this.cpuAt = now;
    this.eluMark = performance.eventLoopUtilization();
    this.cpuPct.add(cpuPct);
    this.eluPct.add(elu.utilization * 100);
    this.options.log('metrics', {
      cpuPct: Math.round(cpuPct * 10) / 10,
      mainThreadPct: Math.round(elu.utilization * 1000) / 10,
      uptimeS: Math.round((performance.now() - this.started) / 1000),
      tick: this.tickNo,
      players: this.byEntity.size,
      tickMs: this.tickMs.takeWindow(),
      voiceMs: this.voiceMs.takeWindow(),
      encodings: this.encodings.takeWindow(),
      busyCells: this.busyCells.takeWindow(),
      joinSnapshotBytes: this.joinSnapshotBytes.takeWindow(),
      rosterBytes: this.rosterBytes.takeWindow(),
      joinMs: this.joinMs.takeWindow(),
      sent: this.sent.takeWindow(),
      received: this.received.takeWindow(),
      events: this.events.takeWindow(),
      links: this.linkTotals(),
      memory: memory(),
    });
  }

  private summary(ticks: number): Record<string, unknown> {
    return {
      ticks,
      uptimeS: Math.round((performance.now() - this.started) / 1000),
      peakPlayers: this.peakPlayers,
      tickMs: this.tickMs.total(),
      voiceMs: this.voiceMs.total(),
      encodings: this.encodings.total(),
      busyCells: this.busyCells.total(),
      joinSnapshotBytes: this.joinSnapshotBytes.total(),
      rosterBytes: this.rosterBytes.total(),
      joinMs: this.joinMs.total(),
      cpuPct: this.cpuPct.total(),
      mainThreadPct: this.eluPct.total(),
      sent: this.sent.total(),
      received: this.received.total(),
      events: this.events.total(),
      memoryStart: this.memoryStart,
      memoryWarm: this.memoryWarm ?? null,
      memoryEnd: memory(),
    };
  }
}
