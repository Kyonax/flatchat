// SPDX-License-Identifier: MPL-2.0
// Signaling through the core (S1.13): a world on a home PC opens no TCP port. It keeps one
// WebSocket to the core (outbound, so any router lets it through), proves it holds the world's key,
// and answers the WebRTC offers the core relays from players; only the world's UDP port must be
// reachable (a mapped or forwarded port, or a TURN relay). The core also hands the world its STUN
// and TURN servers. JSON messages:
//
//   core → world   { type: 'challenge', nonce }   { type: 'offer', id, sdp }   { type: 'ice', iceServers }
//   world → core   { type: 'auth', proof }        { type: 'answer', id, sdp }  { type: 'error', id, error }
import { createHmac } from 'node:crypto';
import type { IceServerSpec } from './rtc.ts';

export const HOST_PROTOCOL = 'flatchat-host-1';
const MAX_MESSAGE = 128 * 1024;
const MAX_BACKOFF_MS = 30_000;

/** What the world sends to prove it holds the key: an HMAC of the core's nonce under the world key. */
export function hostProof(worldKey: Uint8Array, nonce: string): string {
  return createHmac('sha256', worldKey).update(`flatchat host v1 ${nonce}`, 'utf8').digest('base64url');
}

/** The host channel's address on the core: ws(s)://CORE/api/v1/worlds/ID/host. */
export function hostUrl(core: string, worldId: string): string {
  const url = new URL(`api/v1/worlds/${worldId}/host`, core.endsWith('/') ? core : `${core}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export interface Answerer {
  answer(sdp: string, label: string): Promise<{ type: string; sdp: string }>;
  setIceServers(specs: readonly IceServerSpec[]): void;
}

export interface RelayOptions {
  core: string;
  worldId: string;
  worldKey: Uint8Array;
  rtc: Answerer;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** For tests; the global WebSocket (Node.js 24 has one) otherwise. */
  socketFactory?: (url: string) => WebSocket;
}

export class CoreRelay {
  private readonly o: RelayOptions;
  private socket: WebSocket | undefined;
  private stopped = false;
  private backoffMs = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** True while the core has accepted this world's proof. */
  online = false;
  offers = 0;

  constructor(options: RelayOptions) {
    this.o = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1000, 'world stopping');
  }

  private connect(): void {
    const url = hostUrl(this.o.core, this.o.worldId);
    let ws: WebSocket;
    try {
      ws = this.o.socketFactory ? this.o.socketFactory(url) : new WebSocket(url, HOST_PROTOCOL);
    } catch (err) {
      this.retry(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = ws;
    ws.addEventListener('message', (ev) => void this.message(ws, ev.data));
    ws.addEventListener('close', (ev) => {
      if (this.socket !== ws) return;
      const was = this.online;
      this.online = false;
      if (was) this.o.log('relay-lost', { code: ev.code, reason: String(ev.reason).slice(0, 120) });
      this.retry(`closed ${ev.code}`);
    });
    ws.addEventListener('error', () => undefined);
  }

  private retry(why: string): void {
    if (this.stopped) return;
    if (this.backoffMs >= MAX_BACKOFF_MS) this.o.log('relay-retry', { why, inMs: this.backoffMs });
    this.timer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private async message(ws: WebSocket, data: unknown): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let m: { type?: unknown; nonce?: unknown; id?: unknown; sdp?: unknown; iceServers?: unknown };
    try {
      m = JSON.parse(data) as typeof m;
    } catch {
      return;
    }
    if (m.type === 'challenge' && typeof m.nonce === 'string') {
      this.send(ws, { type: 'auth', proof: hostProof(this.o.worldKey, m.nonce) });
    } else if (m.type === 'welcome') {
      this.online = true;
      this.backoffMs = 1000;
      this.o.log('relay-connected', { core: new URL(this.o.core).host });
    } else if (m.type === 'ice' && Array.isArray(m.iceServers)) {
      this.o.rtc.setIceServers(m.iceServers.filter((s): s is IceServerSpec => typeof s === 'object' && s !== null && 'urls' in s));
    } else if (m.type === 'offer' && typeof m.id === 'string' && typeof m.sdp === 'string') {
      this.offers += 1;
      try {
        const answer = await this.o.rtc.answer(m.sdp, `relay:${m.id.slice(0, 8)}`);
        this.send(ws, { type: 'answer', id: m.id, sdp: answer.sdp });
      } catch (err) {
        this.send(ws, { type: 'error', id: m.id, error: err instanceof Error ? err.message.slice(0, 80) : 'failed' });
      }
    }
  }
}
