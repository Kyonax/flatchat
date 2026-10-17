// SPDX-License-Identifier: MPL-2.0
// WebRTC data channels through node-datachannel (libdatachannel): the transport DR-07 chose. Every
// peer shares one UDP port (ICE UDP multiplexing), and DTLS encrypts it with no certificate
// authority. Two pre-negotiated channels carry the protocol: id 0 reliable (ordered), id 1
// unreliable (unordered, no retransmits), so no in-band channel setup is needed.
//
// Signaling for the spike: the client POSTs its offer as JSON ({ type, sdp }) to the world
// server's HTTP endpoint and gets the answer back, with every candidate gathered first (no
// trickle). Production signaling goes through the core with the connect token (sf-001).
//
// Lesson (2026-10-16): the answering side must create its negotiated channels AFTER it sets the
// remote offer. Created before, libdatachannel negotiates on its own and makes a second offer;
// both ends then act as the DTLS client and the handshake fails with "unexpected message".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Channel } from '@flatchat/protocol';
import { type DataChannel, type IceServer, PeerConnection, type RtcConfig } from 'node-datachannel';
import { emptyStats, type Link, type LinkStats, type ServerTransport } from './types.ts';

const MAX_SIGNAL_BYTES = 64 * 1024;
const GATHER_MS = 5000;
const OPEN_MS = 15_000;
const DISCONNECT_GRACE_MS = 5000;
/** Above this many queued bytes an unreliable message is dropped instead of queued. */
const MAX_BUFFERED_UNRELIABLE = 256 * 1024;

let nextLinkId = 1;

function channels(pc: PeerConnection): { reliable: DataChannel; unreliable: DataChannel } {
  return {
    reliable: pc.createDataChannel('reliable', { negotiated: true, id: 0 }),
    unreliable: pc.createDataChannel('unreliable', { negotiated: true, id: 1, unordered: true, maxRetransmits: 0 }),
  };
}

function gathered(pc: PeerConnection, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pc.gatheringState() === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('ICE gathering did not finish')), ms);
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function opened(dcs: DataChannel[], ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let waiting = dcs.filter((dc) => !dc.isOpen()).length;
    if (waiting === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('data channels did not open')), ms);
    for (const dc of dcs) {
      if (dc.isOpen()) continue;
      dc.onOpen(() => {
        waiting -= 1;
        if (waiting === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });
}

function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array {
  if (typeof msg === 'string') return new TextEncoder().encode(msg);
  return msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
}

/** One peer connection, as the Link both the server and the client hand out. */
export class RtcLink implements Link {
  readonly id = nextLinkId++;
  readonly transport = 'rtc' as const;
  readonly remote: string;
  private readonly pc: PeerConnection;
  private readonly dc: Record<Channel, DataChannel>;
  private closed = false;
  private grace: NodeJS.Timeout | undefined;
  private messageHandler: ((channel: Channel, bytes: Uint8Array) => void) | undefined;
  /** Messages that arrived before anyone listened; handed over by onMessage. */
  private early: Array<[Channel, Uint8Array]> = [];
  private closeHandler: (reason: string) => void = () => {};
  private readonly counters: LinkStats = emptyStats();
  onEnded: () => void = () => {};

  constructor(pc: PeerConnection, dc: Record<Channel, DataChannel>, remote: string) {
    this.pc = pc;
    this.dc = dc;
    this.remote = remote;
    for (const channel of ['reliable', 'unreliable'] as const) {
      dc[channel].onMessage((msg) => {
        if (this.closed) return;
        const bytes = toBytes(msg);
        this.counters.receivedBytes[channel] += bytes.length;
        this.counters.receivedMessages[channel] += 1;
        if (this.messageHandler) this.messageHandler(channel, bytes);
        else this.early.push([channel, Uint8Array.from(bytes)]);
      });
      dc[channel].onClosed(() => this.end(`${channel} channel closed`));
    }
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') this.end(`connection ${state}`);
      else if (state === 'disconnected' && !this.grace) {
        this.grace = setTimeout(() => {
          if (this.pc.state() !== 'connected') this.end('connection disconnected');
          this.grace = undefined;
        }, DISCONNECT_GRACE_MS);
      }
    });
  }

  onMessage(handler: (channel: Channel, bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
    const early = this.early;
    this.early = [];
    for (const [channel, bytes] of early) handler(channel, bytes);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  stats(): LinkStats {
    return structuredClone(this.counters);
  }

  send(channel: Channel, bytes: Uint8Array): void {
    const dc = this.dc[channel];
    if (this.closed || !dc.isOpen() || (channel === 'unreliable' && dc.bufferedAmount() > MAX_BUFFERED_UNRELIABLE)) {
      this.counters.dropped += 1;
      return;
    }
    // libdatachannel throws (EPIPE) instead of returning false once the connection is going down.
    let queued: boolean;
    try {
      queued = dc.sendMessageBinary(bytes);
    } catch {
      this.counters.dropped += 1;
      this.end('send failed');
      return;
    }
    if (!queued) {
      this.counters.dropped += 1;
      return;
    }
    this.counters.sentBytes[channel] += bytes.length;
    this.counters.sentMessages[channel] += 1;
  }

  close(reason = 'closed'): void {
    this.end(reason);
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.grace) clearTimeout(this.grace);
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    this.onEnded();
    this.closeHandler(reason);
  }
}

// ----------------------------------------------------------------------- server

export interface RtcServerOptions {
  /** The one UDP port every peer's ICE traffic shares. */
  icePort: number;
  /** The HTTP port for signaling (0 = any free port). */
  signalPort: number;
  /** Where the signaling endpoint listens (default all addresses). */
  host?: string;
  /** Restricts ICE to one local address, for example 127.0.0.1 in an isolated network. */
  iceBind?: string;
  maxSessions?: number;
  /** STUN and TURN servers, in the browser's RTCIceServer form: STUN finds the world's public
   *  address (a mapped port is announced that way), TURN relays when nothing else gets through. */
  iceServers?: IceServerSpec[];
}

/** One ICE server as browsers describe it (RTCIceServer). */
export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** The browser's form into node-datachannel's: one entry per URL; TURN credentials go as fields,
 *  so a username with colons (the core's time-limited ones) survives. */
export function toDatachannelIce(specs: readonly IceServerSpec[]): Array<string | IceServer> {
  const out: Array<string | IceServer> = [];
  for (const spec of specs) {
    for (const url of Array.isArray(spec.urls) ? spec.urls : [spec.urls]) {
      const m = /^(stun|stuns|turn|turns):([^:?/]+|\[[0-9a-f:]+\])(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
      if (!m) continue;
      const scheme = m[1]!.toLowerCase();
      const hostname = m[2]!.replace(/^\[|\]$/g, '');
      const port = Number(m[3] ?? (scheme.endsWith('s') ? 5349 : 3478));
      if (scheme.startsWith('stun')) {
        out.push(`stun:${hostname}:${port}`);
      } else {
        const relayType = scheme === 'turns' ? 'TurnTls' : m[4]?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp';
        out.push({ hostname, port, relayType, ...(spec.username ? { username: spec.username } : {}), ...(spec.credential ? { password: spec.credential } : {}) });
      }
    }
  }
  return out;
}

export class RtcServer implements ServerTransport {
  readonly name = 'rtc' as const;
  private readonly http: Server;
  private readonly options: RtcServerOptions;
  private readonly links = new Set<RtcLink>();
  private pending = 0;
  private linkHandler: (link: Link) => void = () => {};
  private signalPort = 0;
  /** Signaling requests refused (malformed, too large, full, failed). */
  refused = 0;

  private constructor(http: Server, options: RtcServerOptions) {
    this.http = http;
    this.options = options;
  }

  static listen(options: RtcServerOptions): Promise<RtcServer> {
    return new Promise((resolve, reject) => {
      const http = createServer();
      const server = new RtcServer(http, options);
      http.on('request', (req, res) => void server.request(req, res));
      http.once('error', reject);
      http.listen(options.signalPort, options.host, () => {
        http.off('error', reject);
        server.signalPort = (http.address() as AddressInfo).port;
        resolve(server);
      });
    });
  }

  get address(): Record<string, string | number> {
    return { rtcPort: this.options.icePort, signalPort: this.signalPort };
  }

  get port(): number {
    return this.signalPort;
  }

  get sessionCount(): number {
    return this.links.size;
  }

  onLink(handler: (link: Link) => void): void {
    this.linkHandler = handler;
  }

  async close(): Promise<void> {
    for (const link of [...this.links]) link.close('server closing');
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** New peer connections use these (the core hands out fresh TURN credentials now and then). */
  setIceServers(specs: readonly IceServerSpec[]): void {
    this.options.iceServers = [...specs];
  }

  private config(): RtcConfig {
    return {
      iceServers: toDatachannelIce(this.options.iceServers ?? []),
      enableIceUdpMux: true,
      portRangeBegin: this.options.icePort,
      portRangeEnd: this.options.icePort,
      ...(this.options.iceBind ? { bindAddress: this.options.iceBind } : {}),
    };
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/rtc') {
      this.refused += 1;
      reply(404, { error: 'not found' });
      return;
    }
    if (this.links.size + this.pending >= (this.options.maxSessions ?? 512)) {
      this.refused += 1;
      reply(503, { error: 'full' });
      return;
    }
    let offer: { type?: unknown; sdp?: unknown };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_SIGNAL_BYTES) throw new Error('too large');
        chunks.push(chunk);
      }
      offer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: unknown; sdp?: unknown };
    } catch {
      this.refused += 1;
      reply(400, { error: 'bad offer' });
      return;
    }
    if (offer.type !== 'offer' || typeof offer.sdp !== 'string') {
      this.refused += 1;
      reply(400, { error: 'bad offer' });
      return;
    }
    try {
      reply(200, await this.answer(offer.sdp, `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? 0}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed';
      if (!res.headersSent) reply(message === 'full' ? 503 : 500, { error: message });
    }
  }

  /** Answers one offer, from the signaling port or relayed by the core: resolves with the answer
   *  once ICE has gathered, and opens the link in the background (onLink when both channels open). */
  async answer(sdp: string, label: string): Promise<{ type: string; sdp: string }> {
    if (this.links.size + this.pending >= (this.options.maxSessions ?? 512)) {
      this.refused += 1;
      throw new Error('full');
    }
    this.pending += 1;
    let pc: PeerConnection | undefined;
    let dc: ReturnType<typeof channels> | undefined;
    let link: RtcLink | undefined;
    try {
      pc = new PeerConnection(`world-${nextLinkId}`, this.config());
      pc.setRemoteDescription(sdp, 'offer');
      dc = channels(pc);
      link = new RtcLink(pc, dc, label);
      await gathered(pc, GATHER_MS);
      const answer = pc.localDescription();
      if (!answer) throw new Error('no answer');
      void this.open(pc, dc, link);
      return { type: answer.type, sdp: answer.sdp };
    } catch (err) {
      this.refused += 1;
      this.pending -= 1;
      try {
        pc?.close();
      } catch {
        // already closed
      }
      throw err;
    }
  }

  private async open(pc: PeerConnection, dc: ReturnType<typeof channels>, link: RtcLink): Promise<void> {
    try {
      await opened([dc.reliable, dc.unreliable], OPEN_MS);
      this.links.add(link);
      link.onEnded = () => this.links.delete(link);
      this.linkHandler(link);
    } catch {
      this.refused += 1;
      try {
        pc.close();
      } catch {
        // already closed
      }
    } finally {
      this.pending -= 1;
    }
  }
}

// ----------------------------------------------------------------------- client

export interface RtcConnectOptions {
  /** The world server's signaling URL, for example http://127.0.0.1:7779/rtc. */
  signalUrl: string;
  iceBind?: string;
  timeoutMs?: number;
}

/** Connects to an RtcServer; resolves once both data channels are open. */
export async function connectRtc(options: RtcConnectOptions): Promise<Link> {
  const pc = new PeerConnection(`bot-${nextLinkId}`, { iceServers: [], ...(options.iceBind ? { bindAddress: options.iceBind } : {}) });
  try {
    const dc = channels(pc);
    const link = new RtcLink(pc, dc, new URL(options.signalUrl).host);
    if (!pc.localDescription()) pc.setLocalDescription('offer');
    await gathered(pc, GATHER_MS);
    const offer = pc.localDescription();
    if (!offer) throw new Error('no offer');
    const res = await fetch(options.signalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: offer.type, sdp: offer.sdp }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const answer = (await res.json()) as { type?: unknown; sdp?: unknown; error?: unknown };
    if (!res.ok || answer.type !== 'answer' || typeof answer.sdp !== 'string') {
      throw new Error(`signaling refused: ${res.status} ${String(answer.error ?? '')}`);
    }
    pc.setRemoteDescription(answer.sdp, 'answer');
    await opened([dc.reliable, dc.unreliable], options.timeoutMs ?? OPEN_MS);
    return link;
  } catch (err) {
    try {
      pc.close();
    } catch {
      // already closed
    }
    throw err;
  }
}
