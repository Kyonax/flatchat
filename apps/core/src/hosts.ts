// SPDX-License-Identifier: AGPL-3.0-or-later
// Worlds hosted from home (S1.13): each keeps one WebSocket to the core, proves it holds its world
// key (an HMAC of a fresh nonce), and receives players' WebRTC offers through it, so the host opens
// no TCP port. A player posts an offer to /api/v1/worlds/:id/signal; the core relays it to that
// world and returns the world's answer. One connection per world: a newer one replaces the older.
// The world also reports how many players it holds and the capacity its world.toml sets (S2.09),
// which the world browser shows; the core answers with the capacity the owner approved.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HOST_PROTOCOL = 'flatchat-host-1';
const AUTH_MS = 5000;
const MAX_SDP = 64 * 1024;

/** The minimal socket the registry needs (ws's WebSocket, or a test's fake). */
export interface HostSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
}

export function expectedProof(worldKey: Uint8Array, nonce: string): Buffer {
  return createHmac('sha256', worldKey).update(`flatchat host v1 ${nonce}`, 'utf8').digest();
}

/** What a world reports about itself (S2.09). */
export interface HostStatus {
  players: number;
  recommended: number;
  maximum: number;
}

interface Host {
  socket: HostSocket;
  pending: Map<string, { resolve: (sdp: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  status: HostStatus | undefined;
}

const count = (v: unknown, min: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 1000 ? v : undefined);

/** A status message's numbers, or undefined when one is missing or out of range. */
export function cleanStatus(m: { players?: unknown; recommended?: unknown; maximum?: unknown }): HostStatus | undefined {
  const players = count(m.players, 0);
  const recommended = count(m.recommended, 1);
  const maximum = count(m.maximum, 1);
  return players !== undefined && recommended !== undefined && maximum !== undefined ? { players, recommended: Math.min(recommended, maximum), maximum } : undefined;
}

export class RelayError extends Error {
  readonly code: 'world-offline' | 'world-timeout' | 'world-error';
  constructor(code: RelayError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export class HostRegistry {
  private readonly hosts = new Map<string, Host>();

  online(worldId: string): boolean {
    return this.hosts.has(worldId);
  }

  get count(): number {
    return this.hosts.size;
  }

  /** A world's live status: undefined while it is offline; no numbers until its first report. */
  status(worldId: string): { online: true; status: HostStatus | undefined } | undefined {
    const host = this.hosts.get(worldId);
    return host ? { online: true, status: host.status } : undefined;
  }

  /** Runs one host connection: the challenge, the proof, then relaying. `key` opens the world's key
   *  (undefined: the world is not approved). `onOnline` sends the world its ICE servers. */
  accept(worldId: string, socket: HostSocket, key: () => Promise<Uint8Array | undefined>, onOnline: (send: (m: Record<string, unknown>) => void) => Promise<void>): void {
    const nonce = randomBytes(18).toString('base64url');
    let authed = false;
    const send = (m: Record<string, unknown>): void => {
      try {
        socket.send(JSON.stringify(m));
      } catch {
        // the socket closed
      }
    };
    const timer = setTimeout(() => {
      if (!authed) socket.close(4001, 'no proof in time');
    }, AUTH_MS);
    socket.on('close', () => {
      clearTimeout(timer);
      const host = this.hosts.get(worldId);
      if (host?.socket === socket) {
        this.hosts.delete(worldId);
        for (const p of host.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new RelayError('world-offline', 'the world went offline'));
        }
      }
    });
    socket.on('message', (data) => {
      void (async () => {
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
        if (text.length === 0 || text.length > MAX_SDP * 2) return;
        let m: { type?: unknown; proof?: unknown; id?: unknown; sdp?: unknown; error?: unknown; players?: unknown; recommended?: unknown; maximum?: unknown };
        try {
          m = JSON.parse(text) as typeof m;
        } catch {
          return;
        }
        if (!authed) {
          if (m.type !== 'auth' || typeof m.proof !== 'string') return;
          const worldKey = await key();
          const given = Buffer.from(m.proof, 'base64url');
          const want = worldKey ? expectedProof(worldKey, nonce) : undefined;
          if (!want || given.length !== want.length || !timingSafeEqual(given, want)) {
            socket.close(4003, 'wrong proof');
            return;
          }
          authed = true;
          clearTimeout(timer);
          this.hosts.get(worldId)?.socket.close(4009, 'replaced by a newer connection');
          this.hosts.set(worldId, { socket, pending: new Map(), status: undefined });
          send({ type: 'welcome' });
          await onOnline(send);
          return;
        }
        const host = this.hosts.get(worldId);
        if (!host || host.socket !== socket) return;
        if (m.type === 'status') {
          host.status = cleanStatus(m) ?? host.status;
          return;
        }
        if (typeof m.id !== 'string') return;
        const p = host.pending.get(m.id);
        if (!p) return;
        host.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.type === 'answer' && typeof m.sdp === 'string' && m.sdp.length <= MAX_SDP) p.resolve(m.sdp);
        else p.reject(new RelayError('world-error', typeof m.error === 'string' ? m.error.slice(0, 80) : 'no answer'));
      })();
    });
    send({ type: 'challenge', nonce });
  }

  /** Relays an offer to a world and resolves with its answer. */
  relay(worldId: string, sdp: string, timeoutMs = 10_000): Promise<string> {
    const host = this.hosts.get(worldId);
    if (!host) return Promise.reject(new RelayError('world-offline', 'the world is not connected to the core'));
    const id = randomBytes(12).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new RelayError('world-timeout', 'the world did not answer'));
      }, timeoutMs);
      host.pending.set(id, { resolve, reject, timer });
      host.socket.send(JSON.stringify({ type: 'offer', id, sdp }));
    });
  }

  /** Tells a connected world the capacity its owner approved (after a change, S2.09). */
  limits(worldId: string, maximum: number): void {
    const host = this.hosts.get(worldId);
    if (host) {
      try {
        host.socket.send(JSON.stringify({ type: 'limits', maximum }));
      } catch {
        // the socket closed
      }
    }
  }

  /** Sends a message to every connected world (fresh ICE servers). */
  each(fn: (worldId: string, send: (m: Record<string, unknown>) => void) => void): void {
    for (const [id, host] of this.hosts) fn(id, (m) => host.socket.send(JSON.stringify(m)));
  }

  closeAll(): void {
    for (const host of this.hosts.values()) host.socket.close(1001, 'core stopping');
    this.hosts.clear();
  }
}
