// SPDX-License-Identifier: MPL-2.0
// Raw UDP with our own encryption: the fallback transport that spike S0.07 measures against WebRTC
// data channels (DR-07). One server socket serves every client.
//
// Handshake, in the clear (the connect token travels later, encrypted, in the protocol's hello):
//   CONNECT    0x01 version, the client's X25519 key (32), zero padding to 256 bytes
//   CHALLENGE  0x02 version, the server's X25519 key (32), a cookie (16)   (smaller than CONNECT,
//              so the server never amplifies a spoofed request, and it keeps no state yet)
//   CONFIRM    0x03 version, the client's key, the cookie, zero padding to 256 bytes
// The server then derives the session keys and answers with an encrypted ACCEPT.
//
// Every later datagram: DATA 0x10, its sequence number (u64), then AES-256-GCM over the payload,
// with the 9-byte header as additional data and a 16-byte tag. Keys: HKDF-SHA256 of the X25519
// secret, salted with both keys, one key per direction. A 2,048-packet window refuses replays.
//
// Payload: the highest reliable segment received in order (u32) and a bitmap of the 32 after it
// (u32), then at most one frame: UNRELIABLE (one message), SEGMENT (a piece of the reliable byte
// stream, numbered from 1), PING, CLOSE (a reason) or ACCEPT. Reliable messages are written to the
// stream as LEB128 length + bytes and cut into segments of at most 1,000 bytes, resent after a
// timeout until acknowledged.
//
// Spike scope: the server's key is not authenticated (production would put session keys in the
// connect token, netcode.io-style, which needs a protocol version bump; see docs/spikes/s-net.md).
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import type { Channel } from '@flatchat/protocol';
import { emptyStats, type Link, type LinkStats, type ServerTransport } from './types.ts';

const VERSION = 0;
const CONNECT = 0x01;
const CHALLENGE = 0x02;
const CONFIRM = 0x03;
const DATA = 0x10;
const F_UNRELIABLE = 0x01;
const F_SEGMENT = 0x02;
const F_PING = 0x03;
const F_CLOSE = 0x04;
const F_ACCEPT = 0x05;

const HANDSHAKE_SIZE = 256;
const HEADER = 9;
const TAG = 16;
const ACK_FIELDS = 8;
const SEGMENT_MAX = 1000;
const WINDOW_SEGMENTS = 512;
const REPLAY_WINDOW = 2048;
const MAX_STREAM_MESSAGE = 65_536;
const KEEPALIVE_MS = 1000;
const TIMEOUT_MS = 10_000;
const ACK_DELAY_MS = 10;
const COOKIE_EPOCH_MS = 30_000;
const SERVICE_MS = 10;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const INFO = Buffer.from('flatchat-udp-0');

// ------------------------------------------------------------------ key material

interface KeyPair {
  privateKey: KeyObject;
  raw: Buffer;
}

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privateKey, raw: publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length) };
}

/** Session keys for both directions, or undefined for a key that gives a zero secret. */
function deriveKeys(own: KeyPair, peerRaw: Uint8Array, clientRaw: Uint8Array, serverRaw: Uint8Array): { c2s: Buffer; s2c: Buffer } | undefined {
  let secret: Buffer;
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519, peerRaw]), format: 'der', type: 'spki' });
    secret = diffieHellman({ privateKey: own.privateKey, publicKey });
  } catch {
    return undefined;
  }
  if (secret.every((b) => b === 0)) return undefined;
  const okm = Buffer.from(hkdfSync('sha256', secret, Buffer.concat([clientRaw, serverRaw]), INFO, 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

// -------------------------------------------------------------------- varuints

function varuintSize(n: number): number {
  let size = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 128);
    size += 1;
  }
  return size;
}

function writeVaruint(buf: Buffer, at: number, n: number): number {
  while (n >= 0x80) {
    buf[at++] = (n & 0x7f) | 0x80;
    n = Math.floor(n / 128);
  }
  buf[at++] = n;
  return at;
}

/** [value, next offset], or undefined when the bytes end first or run past 5 groups. */
function readVaruint(buf: Uint8Array, at: number): [number, number] | undefined {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 5; i++) {
    if (at >= buf.length) return undefined;
    const b = buf[at++] ?? 0;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [value, at];
    scale *= 128;
  }
  return undefined;
}

// --------------------------------------------------------------------- session

interface Segment {
  rseq: number;
  bytes: Buffer;
  sentAt: number;
  sends: number;
  sacked: boolean;
}

let nextLinkId = 1;

/** One end of an encrypted UDP session: the Link both the server and the client hand out. */
export class UdpSession implements Link {
  readonly id = nextLinkId++;
  readonly transport = 'udp' as const;
  readonly remote: string;
  private readonly sendDatagram: (packet: Buffer) => void;
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private sendSeq = 1;
  private recvMax = 0;
  private readonly recvSeen = new Uint8Array(REPLAY_WINDOW);
  // reliable, outgoing
  private readonly queue: Buffer[] = [];
  private queued = 0;
  private nextRseq = 1;
  private readonly inflight = new Map<number, Segment>();
  private srtt = 0;
  private rttvar = 0;
  private rto = 200;
  // reliable, incoming
  private delivered = 0;
  private readonly early = new Map<number, Buffer>();
  private stream: Buffer = Buffer.alloc(0);
  private ackOwed = false;
  private ackSince = 0;
  // liveness
  private lastSent = 0;
  private lastHeard: number;
  private closed = false;
  private messageHandler: (channel: Channel, bytes: Uint8Array) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};
  private readonly counters: LinkStats = { ...emptyStats(), datagramsSent: 0, datagramBytesSent: 0, datagramsReceived: 0, datagramBytesReceived: 0, retransmits: 0 };
  /** Called once when the session ends, so its owner can forget it. */
  onEnded: () => void = () => {};

  constructor(remote: string, sendDatagram: (packet: Buffer) => void, sendKey: Buffer, recvKey: Buffer, now: number) {
    this.remote = remote;
    this.sendDatagram = sendDatagram;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.lastHeard = now;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onMessage(handler: (channel: Channel, bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  stats(): LinkStats {
    return structuredClone(this.counters);
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (this.closed) {
      this.counters.dropped += 1;
      return;
    }
    this.counters.sentBytes[channel] += bytes.length;
    this.counters.sentMessages[channel] += 1;
    if (channel === 'unreliable') {
      const frame = Buffer.allocUnsafe(1 + varuintSize(bytes.length) + bytes.length);
      frame[0] = F_UNRELIABLE;
      const at = writeVaruint(frame, 1, bytes.length);
      frame.set(bytes, at);
      this.transmit(frame);
      return;
    }
    const framed = Buffer.allocUnsafe(varuintSize(bytes.length) + bytes.length);
    framed.set(bytes, writeVaruint(framed, 0, bytes.length));
    this.queue.push(framed);
    this.queued += framed.length;
    this.flush(performance.now());
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    const text = Buffer.from(reason.slice(0, 120), 'utf8');
    const frame = Buffer.allocUnsafe(2 + text.length);
    frame[0] = F_CLOSE;
    frame[1] = text.length;
    frame.set(text, 2);
    this.transmit(frame);
    this.end(reason);
  }

  /** Sends the ACCEPT frame (the server, after a CONFIRM). */
  accept(): void {
    this.transmit(Buffer.from([F_ACCEPT]));
  }

  /** A DATA datagram from the peer. Returns true when it carried ACCEPT. */
  receive(packet: Buffer, now: number): boolean {
    if (this.closed || packet.length < HEADER + TAG + ACK_FIELDS) return false;
    const seq = packet.readUInt32LE(1) + packet.readUInt32LE(5) * 2 ** 32;
    if (!this.fresh(seq)) return false;
    const nonce = Buffer.alloc(12);
    packet.copy(nonce, 4, 1, HEADER);
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.recvKey, nonce, { authTagLength: TAG });
      decipher.setAAD(packet.subarray(0, HEADER));
      decipher.setAuthTag(packet.subarray(packet.length - TAG));
      plain = Buffer.concat([decipher.update(packet.subarray(HEADER, packet.length - TAG)), decipher.final()]);
    } catch {
      return false;
    }
    this.mark(seq);
    this.lastHeard = now;
    this.counters.datagramsReceived! += 1;
    this.counters.datagramBytesReceived! += packet.length;
    this.takeAcks(plain.readUInt32LE(0), plain.readUInt32LE(4), now);
    if (plain.length <= ACK_FIELDS) return false;
    const kind = plain[ACK_FIELDS];
    let at = ACK_FIELDS + 1;
    if (kind === F_UNRELIABLE) {
      const len = readVaruint(plain, at);
      if (!len || len[1] + len[0] > plain.length) return false;
      this.counters.receivedBytes.unreliable += len[0];
      this.counters.receivedMessages.unreliable += 1;
      this.messageHandler('unreliable', plain.subarray(len[1], len[1] + len[0]));
    } else if (kind === F_SEGMENT) {
      if (plain.length < at + 4) return false;
      const rseq = plain.readUInt32LE(at);
      at += 4;
      const len = readVaruint(plain, at);
      if (!len || len[1] + len[0] > plain.length) return false;
      this.takeSegment(rseq, plain.subarray(len[1], len[1] + len[0]), now);
    } else if (kind === F_CLOSE) {
      const n = plain[at] ?? 0;
      this.end(`peer: ${plain.subarray(at + 1, at + 1 + n).toString('utf8')}`);
    } else if (kind === F_ACCEPT) {
      return true;
    }
    return false;
  }

  /** Retransmissions, owed acks, keepalives and the silence timeout; run every few ms. */
  service(now: number): void {
    if (this.closed) return;
    if (now - this.lastHeard > TIMEOUT_MS) {
      this.end('timeout');
      return;
    }
    for (const segment of this.inflight.values()) {
      if (segment.sacked) continue;
      const wait = Math.min(2000, this.rto * 2 ** (segment.sends - 1));
      if (now - segment.sentAt >= wait) {
        segment.sends += 1;
        segment.sentAt = now;
        this.counters.retransmits! += 1;
        this.transmitSegment(segment);
      }
    }
    this.flush(now);
    if (this.ackOwed && now - this.ackSince >= ACK_DELAY_MS) this.transmit(undefined);
    else if (now - this.lastSent >= KEEPALIVE_MS) this.transmit(Buffer.from([F_PING]));
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.inflight.clear();
    this.queue.length = 0;
    this.onEnded();
    this.closeHandler(reason);
  }

  private flush(now: number): void {
    while (this.queued > 0 && this.inflight.size < WINDOW_SEGMENTS) {
      const piece = this.take(SEGMENT_MAX);
      const segment: Segment = { rseq: this.nextRseq++, bytes: piece, sentAt: now, sends: 1, sacked: false };
      this.inflight.set(segment.rseq, segment);
      this.transmitSegment(segment);
    }
  }

  /** Up to `max` bytes from the front of the outgoing stream. */
  private take(max: number): Buffer {
    const parts: Buffer[] = [];
    let size = 0;
    while (size < max && this.queue.length > 0) {
      const head = this.queue[0]!;
      const want = max - size;
      if (head.length <= want) {
        parts.push(head);
        size += head.length;
        this.queue.shift();
      } else {
        parts.push(head.subarray(0, want));
        this.queue[0] = head.subarray(want);
        size += want;
      }
    }
    this.queued -= size;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
  }

  private transmitSegment(segment: Segment): void {
    const frame = Buffer.allocUnsafe(5 + varuintSize(segment.bytes.length) + segment.bytes.length);
    frame[0] = F_SEGMENT;
    frame.writeUInt32LE(segment.rseq, 1);
    frame.set(segment.bytes, writeVaruint(frame, 5, segment.bytes.length));
    this.transmit(frame);
  }

  /** Encrypts and sends one datagram: the acks, then the frame (none for an ack-only packet). */
  private transmit(frame: Buffer | undefined): void {
    const seq = this.sendSeq++;
    const header = Buffer.allocUnsafe(HEADER);
    header[0] = DATA;
    header.writeUInt32LE(seq % 2 ** 32, 1);
    header.writeUInt32LE(Math.floor(seq / 2 ** 32), 5);
    const nonce = Buffer.alloc(12);
    header.copy(nonce, 4, 1, HEADER);
    const plain = Buffer.allocUnsafe(ACK_FIELDS + (frame?.length ?? 0));
    plain.writeUInt32LE(this.delivered, 0);
    plain.writeUInt32LE(this.sackBits(), 4);
    if (frame) plain.set(frame, ACK_FIELDS);
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce, { authTagLength: TAG });
    cipher.setAAD(header);
    const packet = Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    this.ackOwed = false;
    this.lastSent = performance.now();
    this.counters.datagramsSent! += 1;
    this.counters.datagramBytesSent! += packet.length;
    this.sendDatagram(packet);
  }

  private sackBits(): number {
    let bits = 0;
    for (let i = 0; i < 32; i++) if (this.early.has(this.delivered + 2 + i)) bits |= 1 << i;
    return bits >>> 0;
  }

  private takeAcks(ack: number, bits: number, now: number): void {
    for (const [rseq, segment] of this.inflight) {
      if (rseq <= ack) {
        if (segment.sends === 1) this.sample(now - segment.sentAt);
        this.inflight.delete(rseq);
      } else if (rseq >= ack + 2 && rseq < ack + 34 && (bits >>> (rseq - ack - 2)) & 1) {
        segment.sacked = true;
      }
    }
  }

  private sample(rtt: number): void {
    if (this.srtt === 0) {
      this.srtt = rtt;
      this.rttvar = rtt / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rtt);
      this.srtt = 0.875 * this.srtt + 0.125 * rtt;
    }
    this.rto = Math.min(1000, Math.max(50, this.srtt + 4 * this.rttvar));
  }

  private takeSegment(rseq: number, bytes: Buffer, now: number): void {
    if (!this.ackOwed) {
      this.ackOwed = true;
      this.ackSince = now;
    }
    if (rseq <= this.delivered || rseq > this.delivered + WINDOW_SEGMENTS * 2) return;
    this.early.set(rseq, Buffer.from(bytes));
    const parts: Buffer[] = [this.stream];
    while (this.early.has(this.delivered + 1)) {
      parts.push(this.early.get(this.delivered + 1)!);
      this.early.delete(this.delivered + 1);
      this.delivered += 1;
    }
    if (parts.length === 1) return;
    this.stream = Buffer.concat(parts);
    let at = 0;
    for (;;) {
      const len = readVaruint(this.stream, at);
      if (!len) break;
      if (len[0] > MAX_STREAM_MESSAGE) {
        this.close('reliable message too long');
        return;
      }
      if (len[1] + len[0] > this.stream.length) break;
      const message = this.stream.subarray(len[1], len[1] + len[0]);
      at = len[1] + len[0];
      this.counters.receivedBytes.reliable += message.length;
      this.counters.receivedMessages.reliable += 1;
      this.messageHandler('reliable', message);
      if (this.closed) return;
    }
    this.stream = this.stream.subarray(at);
  }

  private fresh(seq: number): boolean {
    if (seq === 0) return false;
    if (seq > this.recvMax) return true;
    if (this.recvMax - seq >= REPLAY_WINDOW) return false;
    return this.recvSeen[seq % REPLAY_WINDOW] !== 1;
  }

  private mark(seq: number): void {
    if (seq > this.recvMax) {
      for (let s = Math.max(this.recvMax + 1, seq - REPLAY_WINDOW + 1); s < seq; s++) this.recvSeen[s % REPLAY_WINDOW] = 0;
      this.recvMax = seq;
    }
    this.recvSeen[seq % REPLAY_WINDOW] = 1;
  }
}

// ----------------------------------------------------------------------- server

export interface UdpServerOptions {
  port: number;
  host?: string;
  /** Refuse new sessions beyond this many (default 512). */
  maxSessions?: number;
}

export class UdpServer implements ServerTransport {
  readonly name = 'udp' as const;
  private readonly socket: Socket;
  private readonly key = keyPair();
  private readonly cookieSecret = randomBytes(32);
  private readonly sessions = new Map<string, { session: UdpSession; clientKey: Buffer }>();
  private readonly maxSessions: number;
  private linkHandler: (link: Link) => void = () => {};
  private readonly timer: NodeJS.Timeout;
  private boundPort = 0;
  /** Datagrams dropped before any session (bad size, bad cookie, unknown sender). */
  strays = 0;

  private constructor(socket: Socket, maxSessions: number) {
    this.socket = socket;
    this.maxSessions = maxSessions;
    this.socket.on('message', (msg, rinfo) => this.receive(msg, rinfo));
    this.timer = setInterval(() => {
      const now = performance.now();
      for (const { session } of this.sessions.values()) session.service(now);
    }, SERVICE_MS);
  }

  static listen(options: UdpServerOptions): Promise<UdpServer> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.bind(options.port, options.host, () => {
        socket.off('error', reject);
        const server = new UdpServer(socket, options.maxSessions ?? 512);
        server.boundPort = socket.address().port;
        resolve(server);
      });
    });
  }

  get address(): Record<string, string | number> {
    return { udpPort: this.boundPort };
  }

  get port(): number {
    return this.boundPort;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  onLink(handler: (link: Link) => void): void {
    this.linkHandler = handler;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const { session } of [...this.sessions.values()]) session.close('server closing');
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }

  private cookie(rinfo: RemoteInfo, clientKey: Uint8Array, epoch: number): Buffer {
    const mac = createHmac('sha256', this.cookieSecret);
    mac.update(`${rinfo.address}|${rinfo.port}|${epoch}|`);
    mac.update(clientKey);
    return mac.digest().subarray(0, 16);
  }

  private receive(msg: Buffer, rinfo: RemoteInfo): void {
    const where = `${rinfo.address}:${rinfo.port}`;
    const kind = msg[0];
    if (kind === DATA) {
      const entry = this.sessions.get(where);
      if (entry) entry.session.receive(msg, performance.now());
      else this.strays += 1;
      return;
    }
    if ((kind !== CONNECT && kind !== CONFIRM) || msg.length < HANDSHAKE_SIZE || msg[1] !== VERSION) {
      this.strays += 1;
      return;
    }
    const clientKey = msg.subarray(2, 34);
    const epoch = Math.floor(Date.now() / COOKIE_EPOCH_MS);
    if (kind === CONNECT) {
      const reply = Buffer.alloc(2 + 32 + 16);
      reply[0] = CHALLENGE;
      reply[1] = VERSION;
      this.key.raw.copy(reply, 2);
      this.cookie(rinfo, clientKey, epoch).copy(reply, 34);
      this.socket.send(reply, rinfo.port, rinfo.address);
      return;
    }
    const cookie = msg.subarray(34, 50);
    const valid = [epoch, epoch - 1].some((e) => timingSafeEqual(this.cookie(rinfo, clientKey, e), cookie));
    if (!valid) {
      this.strays += 1;
      return;
    }
    const existing = this.sessions.get(where);
    if (existing && existing.clientKey.equals(clientKey)) {
      existing.session.accept();
      return;
    }
    existing?.session.close('replaced');
    if (this.sessions.size >= this.maxSessions) {
      this.strays += 1;
      return;
    }
    const keys = deriveKeys(this.key, clientKey, clientKey, this.key.raw);
    if (!keys) {
      this.strays += 1;
      return;
    }
    const session = new UdpSession(
      where,
      (packet) => this.socket.send(packet, rinfo.port, rinfo.address),
      keys.s2c,
      keys.c2s,
      performance.now(),
    );
    session.onEnded = () => {
      if (this.sessions.get(where)?.session === session) this.sessions.delete(where);
    };
    this.sessions.set(where, { session, clientKey: Buffer.from(clientKey) });
    session.accept();
    this.linkHandler(session);
  }
}

// ----------------------------------------------------------------------- client

const clients = new Set<UdpSession>();
let clientTimer: NodeJS.Timeout | undefined;

function serviceClients(): void {
  const now = performance.now();
  for (const session of clients) session.service(now);
}

export interface UdpConnectOptions {
  host: string;
  port: number;
  /** Give up after this long (default 10 s). */
  timeoutMs?: number;
}

/** Opens a session with a UdpServer; resolves once the server has accepted it. */
export function connectUdp(options: UdpConnectOptions): Promise<Link> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const own = keyPair();
    let session: UdpSession | undefined;
    let cookie: Buffer | undefined;
    let settled = false;
    const handshake = (kind: number): Buffer => {
      const packet = Buffer.alloc(HANDSHAKE_SIZE);
      packet[0] = kind;
      packet[1] = VERSION;
      own.raw.copy(packet, 2);
      if (kind === CONFIRM && cookie) cookie.copy(packet, 34);
      return packet;
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(retry);
      clearTimeout(giveUp);
      socket.close();
      reject(err);
    };
    const retry = setInterval(() => {
      socket.send(handshake(cookie ? CONFIRM : CONNECT), options.port, options.host);
    }, 250);
    const giveUp = setTimeout(() => fail(new Error(`no answer from ${options.host}:${options.port}`)), options.timeoutMs ?? 10_000);
    socket.on('error', (err) => fail(err));
    socket.on('message', (msg) => {
      const kind = msg[0];
      if (kind === CHALLENGE && !session && msg.length >= 50 && msg[1] === VERSION) {
        const serverKey = msg.subarray(2, 34);
        const keys = deriveKeys(own, serverKey, own.raw, serverKey);
        if (!keys) return fail(new Error('the server sent an unusable key'));
        cookie = Buffer.from(msg.subarray(34, 50));
        session = new UdpSession(`${options.host}:${options.port}`, (packet) => socket.send(packet, options.port, options.host), keys.c2s, keys.s2c, performance.now());
        socket.send(handshake(CONFIRM), options.port, options.host);
        return;
      }
      if (kind === DATA && session) {
        const accepted = session.receive(msg, performance.now());
        if (accepted && !settled) {
          settled = true;
          clearInterval(retry);
          clearTimeout(giveUp);
          const s = session;
          clients.add(s);
          if (!clientTimer) clientTimer = setInterval(serviceClients, SERVICE_MS);
          s.onEnded = () => {
            clients.delete(s);
            if (clients.size === 0 && clientTimer) {
              clearInterval(clientTimer);
              clientTimer = undefined;
            }
            // Leave time for the CLOSE datagram to go out before the socket goes.
            setTimeout(() => socket.close(), 50);
          };
          resolve(s);
        }
      }
    });
    socket.bind(0, () => socket.send(handshake(CONNECT), options.port, options.host));
  });
}
