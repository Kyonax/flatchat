// SPDX-License-Identifier: AGPL-3.0-or-later
// STUN and TURN for joining a world on a home PC (S1.13, DR-08): STUN lets both ends find their
// public addresses; TURN relays the traffic when no direct path exists (carrier-grade NAT on both
// sides, a blocking firewall). The core mints short-lived TURN credentials, so none is ever built
// into a client: coturn's shared-secret scheme (its REST API) for "the relay we run", or Cloudflare
// Realtime's TURN through its API. TURN usernames carry an account id, never an email.
import { createHmac } from 'node:crypto';

/** One ICE server, as browsers take it (RTCIceServer). */
export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  stun: string[];
  /** coturn with `use-auth-secret`: its URLs and its static-auth-secret. */
  turnUrls: string[];
  turnSecret?: string;
  /** Cloudflare Realtime TURN: a TURN key's id and its API token. */
  cloudflare?: { keyId: string; token: string };
}

export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478'];

/** coturn's REST credentials: username "expiry:user", password base64(HMAC-SHA1(secret, username)). */
export function coturnCredentials(secret: string, user: string, now: Date, ttlS: number): { username: string; credential: string } {
  const username = `${Math.floor(now.getTime() / 1000) + ttlS}:${user}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class IceServers {
  private readonly config: IceConfig;
  private readonly fetchImpl: Fetch;
  private cloudflare: { servers: IceServerSpec[]; until: number } | undefined;

  constructor(config: IceConfig, fetchImpl: Fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /** The servers for one user (a player's account id, or a world's id) for `ttlS` seconds. */
  async for(user: string, now: Date, ttlS: number): Promise<IceServerSpec[]> {
    const out: IceServerSpec[] = this.config.stun.length > 0 ? [{ urls: this.config.stun }] : [];
    if (this.config.turnSecret && this.config.turnUrls.length > 0) {
      out.push({ urls: this.config.turnUrls, ...coturnCredentials(this.config.turnSecret, user, now, ttlS) });
    }
    if (this.config.cloudflare) out.push(...(await this.fromCloudflare(now)));
    return out;
  }

  /** Cloudflare's credentials last a day here and are shared until half of that has passed. */
  private async fromCloudflare(now: Date): Promise<IceServerSpec[]> {
    if (this.cloudflare && this.cloudflare.until > now.getTime()) return this.cloudflare.servers;
    const { keyId, token } = this.config.cloudflare!;
    try {
      const res = await this.fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86_400 }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as { iceServers?: IceServerSpec[] | IceServerSpec };
      const servers = (Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : []).filter((s) => s && s.urls);
      // Cloudflare's own STUN entry duplicates ours; keep only the TURN ones.
      const turn = servers.map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u.startsWith('turn')) })).filter((s) => s.urls.length > 0);
      if (!res.ok || turn.length === 0) return [];
      this.cloudflare = { servers: turn, until: now.getTime() + 43_200_000 };
      return turn;
    } catch {
      return [];
    }
  }
}
