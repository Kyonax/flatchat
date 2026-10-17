// SPDX-License-Identifier: MPL-2.0
// One headless player on the real protocol and a real transport. It seals its own connect token
// (in the spike the bots stand in for the core, holding the world's key), joins with hello, waits
// for its spawn, then sends its pose at 20 Hz, voice frames at 50 Hz while it talks, a chat line
// now and then and a ping every second. It decodes everything the server sends, as a client
// would, and counts it by message type.
import { randomUUID } from 'node:crypto';
import {
  decodeCellBlock,
  decodeMessage,
  encodeMessage,
  type Message,
  messageDef,
  PROTOCOL_VERSION,
  ProtocolError,
  SCHEMA_FINGERPRINT,
  sealToken,
} from '@flatchat/protocol';
import { type Summary, summarize } from '@flatchat/world-server/metrics';
import { connectRtc, connectUdp, type Link, type TransportName } from '@flatchat/world-server/net';
import { Brain, type BrainConfig } from './brain.ts';
import { Talker } from './talker.ts';

export interface BotTarget {
  transport: TransportName;
  host: string;
  udpPort: number;
  signalUrl: string;
  iceBind?: string;
  worldId: string;
  worldKey: Uint8Array;
}

export interface BotOptions {
  index: number;
  seed: number;
  target: BotTarget;
  brain: BrainConfig;
  voice: boolean;
  chat: boolean;
  /** The first voice burst starts within this many seconds (default 16). */
  firstTalkWithin?: number;
}

export type BotState = 'new' | 'connecting' | 'joined' | 'refused' | 'failed' | 'closed';

export interface Counters {
  down: Record<string, number>;
  downMessages: Record<string, number>;
  up: Record<string, number>;
  upMessages: Record<string, number>;
  rtt: number[];
  seenFull: number[];
  corrections: number;
  voiceFrames: number;
  chats: number;
  bad: number;
}

function counters(): Counters {
  return { down: {}, downMessages: {}, up: {}, upMessages: {}, rtt: [], seenFull: [], corrections: 0, voiceFrames: 0, chats: 0, bad: 0 };
}

function bump(map: Record<string, number>, key: string, by: number): void {
  map[key] = (map[key] ?? 0) + by;
}

export interface BotSummary {
  index: number;
  entity: number | undefined;
  state: BotState;
  /** Why the link closed, when it closed before the run asked it to. */
  lostReason: string;
  refuseReason: string;
  joinMs: number;
  joinedMs: number;
  down: Record<string, number>;
  downMessages: Record<string, number>;
  up: Record<string, number>;
  rtt: Summary;
  seenFull: Summary;
  corrections: number;
  voiceFrames: number;
  chats: number;
  bad: number;
  datagrams?: { sent: number; sentBytes: number; received: number; receivedBytes: number; retransmits: number };
}

const JOIN_TIMEOUT_MS = 10_000;

export class Bot {
  readonly options: BotOptions;
  state: BotState = 'new';
  entity: number | undefined;
  lostReason = '';
  refuseReason = '';
  joinMs = 0;
  private joinedAt = 0;
  private stoppedAt = 0;
  private link: Link | undefined;
  private readonly brain: Brain;
  private readonly talker: Talker;
  private placed = false;
  private stopping = false;
  private poseSeq = 0;
  private lastPoseAt = 0;
  private pingId = 0;
  private snapTick = -1;
  private snapFull = 0;
  private window = counters();
  private readonly total = counters();
  private settle: (() => void) | undefined;

  constructor(options: BotOptions) {
    this.options = options;
    const size = options.brain.size;
    this.brain = new Brain(options.seed, options.brain, { x: size / 2, z: size / 2 });
    this.talker = new Talker(options.seed, options.firstTalkWithin);
  }

  get speaking(): boolean {
    return this.state === 'joined' && this.talker.isTalking && this.options.voice;
  }

  async join(): Promise<void> {
    const t = this.options.target;
    this.state = 'connecting';
    const started = performance.now();
    try {
      this.link = t.transport === 'udp' ? await connectUdp({ host: t.host, port: t.udpPort }) : await connectRtc({ signalUrl: t.signalUrl, ...(t.iceBind ? { iceBind: t.iceBind } : {}) });
    } catch (err) {
      this.state = 'failed';
      this.lostReason = err instanceof Error ? err.message : String(err);
      return;
    }
    this.link.onMessage((_channel, bytes) => this.receive(bytes));
    this.link.onClose((reason) => {
      if (!this.stopping && this.state === 'joined') this.lostReason = reason;
      if (this.state === 'joined' || this.state === 'connecting') this.state = 'closed';
      this.stoppedAt ||= performance.now();
      this.settle?.();
    });
    const token = await sealToken(
      { account: randomUUID(), name: `bot-${this.options.index}`, trust: 1, tester: true, emailVerified: true, under18: false, ageDays: 30 },
      { key: t.worldKey, world: t.worldId, expiresAt: Math.floor(Date.now() / 1000) + 60 },
    );
    const answered = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'flatchat-bots 0.0.0', token });
    const timer = setTimeout(() => this.settle?.(), JOIN_TIMEOUT_MS);
    await answered;
    clearTimeout(timer);
    this.settle = undefined;
    // The message handler changed the state while this waited; TypeScript cannot see that.
    const state = this.state as BotState;
    if (state === 'joined') {
      this.joinMs = performance.now() - started;
      this.joinedAt = performance.now();
    } else if (state === 'connecting') {
      this.state = 'failed';
      this.lostReason = 'no answer to hello';
      this.link.close('no answer');
    }
  }

  /** Called by the swarm 100 times a second; `slot` counts those calls. */
  tick(slot: number, now: number): void {
    if (this.state !== 'joined' || !this.placed || this.stopping) return;
    const s = slot + this.options.index;
    if (s % 5 === 0) {
      const dt = this.lastPoseAt === 0 ? 0.05 : Math.min(0.5, (now - this.lastPoseAt) / 1000);
      this.lastPoseAt = now;
      const p = this.brain.step(dt);
      this.poseSeq = (this.poseSeq + 1) & 0xffff;
      this.send({ type: 'pose', seq: this.poseSeq, position: { x: p.x, y: p.y, z: p.z }, yaw: p.yaw, look: p.look, stance: p.stance });
    }
    if (this.options.voice && s % 2 === 0) {
      const frame = this.talker.slot();
      if (frame) this.send({ type: 'voice', ...frame });
    }
    if (s % 10 === 0) {
      const line = this.talker.advance(0.1);
      if (line && this.options.chat) this.send({ type: 'say', text: line });
    }
    if (s % 100 === 0) {
      this.pingId = (this.pingId + 1) & 0xffff;
      this.send({ type: 'ping', id: this.pingId, time: Math.floor(now) >>> 0 });
    }
  }

  /** Leaves the world (the run is over). */
  stop(): void {
    this.stopping = true;
    this.stoppedAt ||= performance.now();
    if (this.state === 'joined') this.send({ type: 'leave', reason: 'quit', detail: 'bot run over' });
    const link = this.link;
    if (link) setTimeout(() => link.close('bot stopped'), 200);
  }

  takeWindow(): Counters {
    const w = this.window;
    this.window = counters();
    return w;
  }

  summary(): BotSummary {
    const end = this.stoppedAt || performance.now();
    const s = this.link?.stats();
    return {
      index: this.options.index,
      entity: this.entity,
      state: this.state,
      lostReason: this.lostReason,
      refuseReason: this.refuseReason,
      joinMs: Math.round(this.joinMs),
      joinedMs: this.joinedAt ? Math.round(end - this.joinedAt) : 0,
      down: { ...this.total.down },
      downMessages: { ...this.total.downMessages },
      up: { ...this.total.up },
      rtt: summarize(this.total.rtt),
      seenFull: summarize(this.total.seenFull),
      corrections: this.total.corrections,
      voiceFrames: this.total.voiceFrames,
      chats: this.total.chats,
      bad: this.total.bad,
      ...(s?.datagramsSent !== undefined
        ? { datagrams: { sent: s.datagramsSent, sentBytes: s.datagramBytesSent ?? 0, received: s.datagramsReceived ?? 0, receivedBytes: s.datagramBytesReceived ?? 0, retransmits: s.retransmits ?? 0 } }
        : {}),
    };
  }

  private send(message: Message): void {
    if (!this.link) return;
    const bytes = encodeMessage(message);
    this.link.send(messageDef(message.type).channel, bytes);
    for (const c of [this.window, this.total]) {
      bump(c.up, message.type, bytes.length);
      bump(c.upMessages, message.type, 1);
    }
  }

  private receive(bytes: Uint8Array): void {
    let m: Message;
    try {
      m = decodeMessage(bytes, 'server');
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.window.bad += 1;
      this.total.bad += 1;
      return;
    }
    for (const c of [this.window, this.total]) {
      bump(c.down, m.type, bytes.length);
      bump(c.downMessages, m.type, 1);
    }
    switch (m.type) {
      case 'welcome':
        this.entity = m.entity;
        this.state = 'joined';
        this.settle?.();
        break;
      case 'refuse':
        this.refuseReason = m.reason;
        this.state = 'refused';
        this.settle?.();
        break;
      case 'snapshot': {
        // The spawn (sequence 0) repeats until the server has a pose; only the first one places the bot.
        if (m.correction && (m.correction.seq !== 0 || !this.placed)) {
          this.brain.teleport(m.correction.position.x, m.correction.position.z, m.correction.yaw);
          if (m.correction.seq !== 0) {
            this.window.corrections += 1;
            this.total.corrections += 1;
          }
          this.placed = true;
        }
        let full = 0;
        for (const block of m.blocks) full += decodeCellBlock(block).full.length;
        if (m.tick !== this.snapTick) {
          if (this.snapTick >= 0) {
            this.window.seenFull.push(this.snapFull);
            // Every tenth tick for the run's total, so a 30-minute run keeps 3,600 numbers a bot.
            if (this.snapTick % 10 === 0) this.total.seenFull.push(this.snapFull);
          }
          this.snapTick = m.tick;
          this.snapFull = 0;
        }
        this.snapFull += full;
        break;
      }
      case 'voiceBundle':
        this.window.voiceFrames += m.frames.length;
        this.total.voiceFrames += m.frames.length;
        break;
      case 'chat':
        this.window.chats += 1;
        this.total.chats += 1;
        break;
      case 'pong': {
        const rtt = ((Math.floor(performance.now()) >>> 0) - m.time) >>> 0;
        this.window.rtt.push(rtt);
        this.total.rtt.push(rtt);
        break;
      }
      case 'leave':
        if (!this.stopping) this.lostReason = `server: ${m.reason}`;
        break;
      default:
        break;
    }
  }
}
