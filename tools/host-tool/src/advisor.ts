// SPDX-License-Identifier: MPL-2.0
// The capacity advisor (S2.02, Q-L12): how many players a home connection can host. A world server
// sends each player about 0.25 Mbps on the wire with players spread out, and up to 0.75 Mbps with
// everyone in one place (S0.07, measured at 200 players), so the advice keeps a margin: the
// recommended count fills 60 % of the measured upload at the spread rate, the maximum 80 %.
// Measuring sends data to Cloudflare's public speed test, so it runs only when the host asks.

export const PER_PLAYER_MBPS = 0.25;
export const CROWDED_MBPS = 0.75;

export interface Advice {
  uploadMbps: number;
  recommended: number;
  maximum: number;
  /** Players if everyone gathers in one place. */
  crowded: number;
}

export function advise(uploadMbps: number): Advice {
  const clamp = (n: number): number => Math.max(1, Math.min(200, Math.floor(n)));
  return {
    uploadMbps: Math.round(uploadMbps * 10) / 10,
    recommended: clamp((uploadMbps * 0.6) / PER_PLAYER_MBPS),
    maximum: clamp((uploadMbps * 0.8) / PER_PLAYER_MBPS),
    crowded: clamp((uploadMbps * 0.8) / CROWDED_MBPS),
  };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Upload speed in Mbps: a few posts of 4 MB to Cloudflare's speed test, the best one counted. */
export async function measureUpload(rounds = 3, bytes = 4_000_000, fetchImpl: Fetch = fetch): Promise<number> {
  const body = new Uint8Array(bytes);
  let best = 0;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    const res = await fetchImpl('https://speed.cloudflare.com/__up', { method: 'POST', body, signal: AbortSignal.timeout(60_000) });
    await res.arrayBuffer();
    const seconds = (performance.now() - started) / 1000;
    best = Math.max(best, (bytes * 8) / 1e6 / seconds);
  }
  return best;
}
