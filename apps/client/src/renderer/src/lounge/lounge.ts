// SPDX-License-Identifier: MPL-2.0
// The voice lounge (spike S0.08's listening test, --lounge): the smallest place where two people on
// different machines can stand, walk and talk. It joins a world server, sends the player's pose at
// 20 Hz from WASD, reads everyone's positions from the snapshots, and runs the voice chain with
// the real microphone (Chromium's echo cancellation, noise suppression and gain control on) and
// the heard voices placed in 3D. M mutes the microphone. Everything the HUD shows comes from here.
import { decodeCellBlock, fromHex, type Message, type MessageOf } from '@flatchat/protocol';
import { WorldConnection } from '../net/connection';
import { VoiceChain, type VoiceStats } from '../voice/chain';

export interface Body {
  entity: number;
  name: string;
  x: number;
  z: number;
  yaw: number;
  speaking: number;
  seenAt: number;
}

export interface LoungeState {
  status: string;
  entity: number;
  me: { x: number; z: number; yaw: number };
  others: Body[];
  muted: boolean;
  micLevel: number;
  rttMs: number;
  voice: VoiceStats | undefined;
  /** This machine's audio devices, as Chromium reports them: mouth to ear is the chain plus these. */
  audio: { outputMs: number; inputMs: number | undefined } | undefined;
  error?: string;
}

const SPEED = 4;
const CELL = 32;

export class Lounge {
  readonly state: LoungeState = { status: 'joining', entity: -1, me: { x: 0, z: 0, yaw: 0 }, others: [], muted: false, micLevel: 0, rttMs: 0, voice: undefined, audio: undefined };
  private conn: WorldConnection | undefined;
  private chain: VoiceChain | undefined;
  private readonly bodies = new Map<number, Body>();
  private readonly names = new Map<number, string>();
  private readonly keys = new Set<string>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private seq = 0;
  private pingId = 0;
  private lastMove = performance.now();
  private inputLatencyS: number | undefined;

  async start(signalUrl: string, tokenHex: string): Promise<void> {
    try {
      // The handler is in place before the join, so the join's roster and first snapshot reach it.
      this.conn = await WorldConnection.join({ signalUrl, token: fromHex(tokenHex), onMessage: (m) => this.message(m) });
      this.state.status = 'joined';
      const spawn = this.conn.spawn!;
      this.state.me = { x: spawn.position.x, z: spawn.position.z, yaw: spawn.yaw };
      this.timers.push(setInterval(() => this.tick(), 50));
      this.timers.push(setInterval(() => this.conn?.send({ type: 'ping', id: (this.pingId = (this.pingId + 1) & 0xffff), time: Math.floor(performance.now()) >>> 0 }), 1000));
      await this.startVoice();
    } catch (err) {
      this.state.status = 'failed';
      this.state.error = err instanceof Error ? err.message : String(err);
    }
  }

  key(code: string, down: boolean): void {
    if (code === 'KeyM' && down) {
      this.state.muted = !this.state.muted;
      if (this.chain) this.chain.muted = this.state.muted;
    }
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.conn?.close('left the lounge');
    this.chain?.close();
  }

  private async startVoice(): Promise<void> {
    this.chain = await VoiceChain.create();
    await this.chain.ctx.resume();
    this.chain.muted = this.state.muted;
    this.chain.output.connect(this.chain.ctx.destination);
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const settings = mic.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    this.inputLatencyS = settings?.latency;
    const source = this.chain.ctx.createMediaStreamSource(mic);
    await this.chain.startSending(source, (f) => this.conn?.send({ type: 'voice', ...f }));
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.lastMove) / 1000);
    this.lastMove = now;
    let dx = 0;
    let dz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dz -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dz += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      this.state.me.x += (dx / len) * SPEED * dt;
      this.state.me.z += (dz / len) * SPEED * dt;
      this.state.me.yaw = Math.atan2(dx, dz);
    }
    this.seq = (this.seq + 1) & 0xffff;
    const me = this.state.me;
    this.conn?.send({ type: 'pose', seq: this.seq, position: { x: me.x, y: 0, z: me.z }, yaw: me.yaw, look: 0, stance: 'standing' });
    for (const [id, b] of this.bodies) if (now - b.seenAt > 3000) this.bodies.delete(id);
    const speakers = new Map<number, { x: number; y: number; z: number }>();
    for (const b of this.bodies.values()) {
      b.speaking = this.chain?.mouthOf(b.entity)?.level ?? 0;
      speakers.set(b.entity, { x: b.x, y: 1.6, z: b.z });
    }
    this.chain?.place({ x: me.x, y: 1.6, z: me.z }, me.yaw, speakers);
    this.state.others = [...this.bodies.values()];
    this.state.micLevel = this.chain?.micLevel ?? 0;
    if (this.chain) {
      const ctx = this.chain.ctx;
      this.state.audio = {
        outputMs: Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000),
        inputMs: this.inputLatencyS === undefined ? undefined : Math.round(this.inputLatencyS * 1000),
      };
    }
    this.state.voice = this.chain?.stats();
  }

  private message(m: Message): void {
    if (m.type === 'welcome') this.state.entity = m.entity;
    else if (m.type === 'snapshot') this.snapshot(m);
    else if (m.type === 'roster') this.roster(m);
    else if (m.type === 'voiceBundle') this.chain?.receive(m);
    else if (m.type === 'pong') this.state.rttMs = (Math.floor(performance.now()) >>> 0) - m.time;
    else if (m.type === 'leave') this.state.status = `the world closed: ${m.reason}`;
  }

  private snapshot(s: MessageOf<'snapshot'>): void {
    if (s.correction && s.correction.seq !== 0) this.state.me = { x: s.correction.position.x, z: s.correction.position.z, yaw: s.correction.yaw };
    const now = performance.now();
    for (const bytes of s.blocks) {
      const block = decodeCellBlock(bytes);
      for (const e of [...block.full, ...block.coarse]) {
        if (e.id === this.state.entity) continue;
        this.bodies.set(e.id, { entity: e.id, name: this.names.get(e.id) ?? `#${e.id}`, x: block.cx * CELL + e.x, z: block.cz * CELL + e.z, yaw: e.yaw, speaking: 0, seenAt: now });
      }
    }
  }

  private roster(r: MessageOf<'roster'>): void {
    if (r.full) this.names.clear();
    for (const p of r.players) this.names.set(p.entity, p.name);
    for (const id of r.left) {
      this.names.delete(id);
      this.bodies.delete(id);
    }
  }
}
