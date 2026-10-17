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
  PROTOCOL_VERSION,
  ProtocolError,
  type Refusal,
  TokenError,
  toHex,
  type VersionPolicy,
  versionPolicy,
} from '@flatchat/protocol';
import { memory, Samples, seededRandom, Tally } from './metrics.ts';
import type { Link, ServerTransport, TransportName } from './net/types.ts';
import { startTicker, type Ticker } from './ticker.ts';
import { VoiceRouter, type VoiceConfig } from './world/voice.ts';
import { World, type WorldConfig } from './world/world.ts';

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface WorldServerOptions {
  /** This world's ID (a UUID), the one its connect tokens name. */
  worldId: string;
  /** The world's 32-byte key, shared with the core at approval. Without one, nobody can join. */
  worldKey: Uint8Array | undefined;
  build: string;
  tickHz: number;
  voiceHz: number;
  capacity: number;
  /** The lowest protocol version the core allows (R-17). */
  coreMinimum: number;
  world: Partial<WorldConfig>;
  voice: Partial<VoiceConfig>;
  /** Chat reaches players within this many metres. */
  chatRangeM: number;
  helloTimeoutMs: number;
  /** Seconds between metrics lines; 0 switches them off. */
  metricsEverySec: number;
  /** Seed for spawn positions. */
  seed: number;
  /** Where players appear: within `r` metres of (x, z); anywhere in the world when left out. */
  spawn?: { x: number; z: number; r: number };
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
  chatRangeM: 50,
  helloTimeoutMs: 5000,
  metricsEverySec: 5,
  seed: 1,
  unixNow: () => Math.floor(Date.now() / 1000),
};

interface Conn {
  readonly link: Link;
  state: 'hello' | 'joining' | 'joined' | 'closed';
  entity?: number;
  account?: string;
  name?: string;
  joinedAt?: number;
  helloTimer?: NodeJS.Timeout;
  voiceWindowStart: number;
  voiceInWindow: number;
  lastChatAt: number;
  spokeAt: number;
  badMessages: number;
}

type RosterPlayer = MessageBody<'roster'>['players'][number];

const MAX_ENTITY = 65_535;
const VOICE_FRAMES_PER_SECOND = 60;
const MAX_BAD_MESSAGES = 50;
const TRACE_MS = 250;

export class WorldServer {
  readonly options: WorldServerOptions;
  readonly world: World;
  private readonly voice: VoiceRouter;
  private readonly transports: ServerTransport[];
  private readonly policy: VersionPolicy;
  private readonly conns = new Set<Conn>();
  private readonly byEntity = new Map<number, Conn>();
  private readonly roster = new Map<number, RosterPlayer>();
  private readonly freeEntities: number[] = [];
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
    const conn: Conn = { link, state: 'hello', voiceWindowStart: -Infinity, voiceInWindow: 0, lastChatAt: -Infinity, spokeAt: -Infinity, badMessages: 0 };
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
        break;
      case 'voice':
        this.voiceIn(conn, message, now);
        break;
      case 'say':
        if (now - conn.lastChatAt >= 1000) {
          conn.lastChatAt = now;
          this.chat(conn.entity, message.text);
        } else {
          this.events.add('chat:throttled', 0);
        }
        break;
      case 'ping':
        this.send(conn, 'pong', encodeMessage({ type: 'pong', id: message.id, time: message.time }));
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
    if (this.byEntity.size >= this.options.capacity) return this.refuse(conn, { reason: 'full', ...base, detail: '' });
    const entity = this.allocate();
    if (entity === undefined) return this.refuse(conn, { reason: 'full', ...base, detail: '' });

    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.state = 'joined';
    conn.entity = entity;
    conn.account = opened.claims.account;
    conn.name = opened.claims.name;
    conn.joinedAt = performance.now();
    const size = this.world.config.size;
    const sp = this.options.spawn;
    const angle = this.random() * Math.PI * 2;
    const radius = sp ? Math.sqrt(this.random()) * sp.r : 0;
    const at = sp ? { x: sp.x + Math.cos(angle) * radius, y: 0, z: sp.z + Math.sin(angle) * radius } : { x: this.random() * size, y: 0, z: this.random() * size };
    this.world.add(entity, at, this.random() * Math.PI * 2 - Math.PI, performance.now());
    this.byEntity.set(entity, conn);
    const player: RosterPlayer = { entity, account: opened.claims.account, name: opened.claims.name, trust: opened.claims.trust };
    this.roster.set(entity, player);
    this.joinedThisTick.push(player);
    this.peakPlayers = Math.max(this.peakPlayers, this.byEntity.size);

    this.send(conn, 'welcome', encodeMessage({ type: 'welcome', protocol: PROTOCOL_VERSION, build: this.options.build, world: this.options.worldId, entity, tickHz: this.options.tickHz, tick: this.tickNo }));
    const roster = encodeMessage({ type: 'roster', full: true, players: [...this.roster.values()], left: [] });
    this.send(conn, 'roster', roster);
    this.rosterBytes.add(roster.length);
    this.joinMs.add(performance.now() - started);
    this.events.add('join', 0);
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
    this.byEntity.delete(entity);
    this.roster.delete(entity);
    this.world.remove(entity);
    this.voice.forget(entity);
    this.freeEntities.push(entity);
    this.leftThisTick.push(entity);
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
  }

  private voiceStep(): void {
    const { bundles } = this.voice.step(this.world);
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
    this.voice.push({ from: conn.entity!, seq: message.seq, start: message.start, mouth: message.mouth, opus: message.opus });
  }

  private chat(from: number, text: string): void {
    const speaker = this.world.players.get(from);
    if (!speaker) return;
    const bytes = encodeMessage({ type: 'chat', from, text });
    for (const { player } of this.world.near(speaker.x, speaker.z, this.options.chatRangeM)) {
      const conn = this.byEntity.get(player.entity);
      if (conn) this.send(conn, 'chat', bytes);
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
