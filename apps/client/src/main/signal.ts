// SPDX-License-Identifier: MPL-2.0
// WebRTC signaling for the renderer, done by the main process: the page hands over its offer and a
// world server's /rtc URL through the preload bridge, and gets the answer back. The page therefore
// needs no network permission in its content security policy, and the URL is checked here: in
// Stage 0 only a world server on this machine, on the local network (RFC 1918 addresses) or on a
// private overlay network such as Tailscale (100.64.0.0/10), over HTTP or HTTPS, at /rtc. In
// Stage 1 signaling goes through the core.
const MAX_SDP = 64 * 1024;
const TIMEOUT_MS = 10_000;

/** The URL if it names an allowed world server, or undefined. */
export function signalTarget(text: unknown): URL | undefined {
  if (typeof text !== 'string' || text.length > 200) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/rtc' || url.search || url.username || url.password) return undefined;
  const parts = url.hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  const [a = 0, b = 0] = parts;
  const local = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  return local ? url : undefined;
}

export interface Description {
  type: string;
  sdp: string;
}

export async function signal(urlText: unknown, offer: unknown): Promise<Description> {
  const url = signalTarget(urlText);
  if (!url) throw new Error('signaling is allowed only to a world server on this machine or the local network, at /rtc');
  const o = offer as Partial<Description> | null;
  if (!o || o.type !== 'offer' || typeof o.sdp !== 'string' || o.sdp.length > MAX_SDP) throw new Error('not an offer');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'offer', sdp: o.sdp }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const answer = (await res.json()) as Partial<Description> & { error?: string };
  if (!res.ok || answer.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length > MAX_SDP) {
    throw new Error(`signaling refused: ${res.status} ${typeof answer.error === 'string' ? answer.error.slice(0, 80) : ''}`);
  }
  return { type: 'answer', sdp: answer.sdp };
}
