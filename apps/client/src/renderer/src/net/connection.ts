// SPDX-License-Identifier: MPL-2.0
// The client's link to a world server: WebRTC data channels through Chromium's own RTCPeerConnection
// (DR-07), the two pre-negotiated channels of docs/protocol.md (id 0 reliable, id 1 unreliable),
// and the join: hello with a connect token, then welcome or refuse, then the spawn (the first
// snapshot's correction with sequence 0, sent once: the join waits for it, so no caller can miss it). Messages are decoded with
// decodeMessage(…, 'server'), so nothing malformed reaches the game; each is sent on the channel its
// type names. Signaling goes through the main process (the bridge's signal(): the page itself has no
// network permission), which allows only a world server on this machine or the local network in
// Stage 0; in Stage 1 it goes through the core. Offline (S2.13) the world runs in the client's own
// main process and the same messages travel over IPC (`joinLocal`); both joins share the handshake.
import {
  decodeMessage,
  encodeMessage,
  type Message,
  messageDef,
  type MessageName,
  type MessageOf,
  PROTOCOL_VERSION,
  ProtocolError,
  SCHEMA_FINGERPRINT,
} from '@flatchat/protocol';

export interface JoinOptions {
  /** The world server's signaling endpoint: http://127.0.0.1:PORT/rtc, or a LAN address, in Stage 0. */
  signalUrl: string;
  /** The connect token the core sealed for this world. */
  token: Uint8Array;
  /** STUN and TURN servers from the core (S1.13); none on a LAN or loopback. */
  iceServers?: RTCIceServer[];
  build?: string;
  /** The spawn group a portal named (S2.11); the world's own spawn points when left out. */
  spawn?: string;
  /** The player's chosen height in centimetres (S2.07); the platform's default when left out. */
  height?: number;
  /** Only TURN relay candidates (WebRTC's relay-only policy): a player behind a NAT that lets
   *  nothing else through (S2.12). */
  relayOnly?: boolean;
  timeoutMs?: number;
  /** Gets every message from the first one, the welcome, the join's roster and its snapshot included. */
  onMessage?: (m: Message) => void;
}

export interface ConnectionStats {
  sentBytes: number;
  receivedBytes: number;
  received: Record<string, number>;
  malformed: number;
}

export class JoinRefused extends Error {
  readonly reason: string;
  /** The world's own words, for a rule's refusal; shown as text. */
  readonly detail: string;
  constructor(reason: string, detail: string) {
    super(`refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export type Spawn = NonNullable<MessageOf<'snapshot'>['correction']>;

function within<T>(what: string, ms: number, start: (resolve: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
    start((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

type ChannelName = 'reliable' | 'unreliable';

export class WorldConnection {
  /** Sends on a channel; false when that channel is not open. */
  private readonly out: (channel: ChannelName, bytes: Uint8Array<ArrayBuffer>) => boolean;
  private readonly shut: () => void;
  private readonly handlers = new Set<(m: Message) => void>();
  private readonly counters: ConnectionStats = { sentBytes: 0, receivedBytes: 0, received: {}, malformed: 0 };
  /** Set once the server has welcomed this client. */
  entity = -1;
  welcome: MessageOf<'welcome'> | undefined;
  /** Where the server placed this client at the join. */
  spawn: Spawn | undefined;
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private ended = false;

  private constructor(out: (channel: ChannelName, bytes: Uint8Array<ArrayBuffer>) => boolean, shut: () => void) {
    this.out = out;
    this.shut = shut;
  }

  /** A WebRTC connection's two channels feed and carry this connection. */
  private static overRtc(pc: RTCPeerConnection, reliable: RTCDataChannel, unreliable: RTCDataChannel): WorldConnection {
    const conn = new WorldConnection(
      (channel, bytes) => {
        const dc = channel === 'reliable' ? reliable : unreliable;
        if (dc.readyState !== 'open') return false;
        dc.send(bytes);
        return true;
      },
      () => pc.close(),
    );
    for (const dc of [reliable, unreliable]) {
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (ev: MessageEvent<ArrayBuffer>) => conn.receive(new Uint8Array(ev.data));
    }
    reliable.addEventListener('close', () => conn.end('closed'));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') conn.end(pc.connectionState);
    });
    return conn;
  }

  /** Called once when the connection ends: the server left, the network failed, or close() was called. */
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const h of [...this.closeHandlers]) h(reason);
  }

  /** Signals, opens both channels and joins; resolves once welcomed and placed (`spawn`), rejects with JoinRefused or a timeout. */
  static async join(options: JoinOptions): Promise<WorldConnection> {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const bridge = window.flatchat;
    if (!bridge) throw new Error('no preload bridge');
    const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [], iceTransportPolicy: options.relayOnly ? 'relay' : 'all' });
    try {
      const reliable = pc.createDataChannel('reliable', { negotiated: true, id: 0 });
      const unreliable = pc.createDataChannel('unreliable', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
      const conn = WorldConnection.overRtc(pc, reliable, unreliable);
      if (options.onMessage) conn.onMessage(options.onMessage);
      await pc.setLocalDescription(await pc.createOffer());
      await within<void>('ICE gathering', 5000, (resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        });
      });
      const offer = pc.localDescription;
      if (!offer) throw new Error('no local offer');
      const answer = await bridge.signal(options.signalUrl, { type: offer.type, sdp: offer.sdp });
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await Promise.all(
        [reliable, unreliable].map((dc) =>
          within<void>(`${dc.label} channel`, timeout, (resolve) => {
            if (dc.readyState === 'open') resolve();
            dc.addEventListener('open', () => resolve());
          }),
        ),
      );
      await WorldConnection.handshake(conn, options, timeout);
      return conn;
    } catch (err) {
      pc.close();
      throw err;
    }
  }

  /** Offline mode (S2.13): the world in the client's main process, over IPC. */
  static async joinLocal(options: Omit<JoinOptions, 'signalUrl' | 'iceServers' | 'relayOnly'>): Promise<WorldConnection> {
    const bridge = window.flatchat;
    if (!bridge) throw new Error('no preload bridge');
    const offs: Array<() => void> = [];
    const conn = new WorldConnection(
      (channel, bytes) => {
        bridge.localSend(channel, bytes);
        return true;
      },
      () => {
        for (const off of offs) off();
        void bridge.localClose();
      },
    );
    offs.push(bridge.onLocal((_channel, bytes) => conn.receive(bytes)));
    offs.push(bridge.onLocalEnd((reason) => conn.end(reason)));
    if (options.onMessage) conn.onMessage(options.onMessage);
    if (!(await bridge.localOpen())) throw new Error('no offline world is running');
    try {
      await WorldConnection.handshake(conn, options, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return conn;
    } catch (err) {
      conn.shut();
      throw err;
    }
  }

  /** hello with the connect token, then welcome or refuse, then the spawn. */
  private static async handshake(conn: WorldConnection, options: Pick<JoinOptions, 'token' | 'build' | 'spawn' | 'height'>, timeout: number): Promise<void> {
    const reply = Promise.race([conn.next('welcome', () => true, timeout), conn.next('refuse', () => true, timeout)]);
    const placed = conn.next('snapshot', (s) => s.correction?.seq === 0, timeout);
    placed.catch(() => undefined); // a refused join never gets one
    conn.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: options.build ?? 'flatchat-client 0.0.0', token: options.token, spawn: options.spawn ?? '', height: Math.max(0, Math.min(1023, Math.round(options.height ?? 0))) });
    const first = await reply;
    if (first.type === 'refuse') throw new JoinRefused(first.reason, first.detail);
    conn.welcome = first;
    conn.entity = first.entity;
    conn.spawn = (await placed).correction;
  }

  send(message: Message): void {
    const bytes = encodeMessage(message);
    if (this.out(messageDef(message.type).channel, bytes)) this.counters.sentBytes += bytes.length;
  }

  onMessage(handler: (m: Message) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** The next message of a type to arrive from now on (one received earlier does not count), within `ms`. */
  next<K extends MessageName>(type: K, where: (m: MessageOf<K>) => boolean = () => true, ms = DEFAULT_TIMEOUT_MS): Promise<MessageOf<K>> {
    return within(type, ms, (resolve) => {
      const off = this.onMessage((m) => {
        if (m.type === type && where(m as MessageOf<K>)) {
          off();
          resolve(m as MessageOf<K>);
        }
      });
    });
  }

  stats(): ConnectionStats {
    return structuredClone(this.counters);
  }

  /** Leaves: `travel` when the player went through a portal, `quit` otherwise. */
  close(detail = 'quit', reason: 'quit' | 'travel' = 'quit'): void {
    this.send({ type: 'leave', reason, detail });
    setTimeout(() => this.shut(), 200);
  }

  private receive(bytes: Uint8Array): void {
    let m: Message;
    try {
      m = decodeMessage(bytes, 'server');
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.counters.malformed += 1;
      return;
    }
    this.counters.receivedBytes += bytes.length;
    this.counters.received[m.type] = (this.counters.received[m.type] ?? 0) + 1;
    for (const h of [...this.handlers]) h(m);
  }
}
