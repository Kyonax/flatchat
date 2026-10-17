// SPDX-License-Identifier: MPL-2.0
// The host's account on the core, from a terminal: the same sign-in as the client (the system
// browser, a loopback port, a PKCE verifier; RFC 8252 and RFC 7636), the refresh token kept in
// ~/.config/flatchat/host.json (readable by the user only), and the core's API for hosts: their
// worlds, a request for approval, an approved world's key.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_DIR = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'flatchat');
const SESSION_FILE = join(CONFIG_DIR, 'host.json');

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class HostError extends Error {}

/** The core's address: https, or http on this machine. */
export function coreUrl(text: string): string {
  const url = new URL(text);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new HostError('the core is reached over https (http only on this machine)');
  return url.origin;
}

interface Saved {
  core: string;
  refresh: string;
}

export function loadSession(): Saved | undefined {
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Partial<Saved>;
    return typeof s.core === 'string' && typeof s.refresh === 'string' ? { core: s.core, refresh: s.refresh } : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(s: Saved | undefined, file = SESSION_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, s ? `${JSON.stringify(s)}\n` : '{}\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Opens a URL in the system browser. Only the core's own sign-in page is ever passed here. */
export function openBrowser(url: string): Promise<void> {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => execFile(cmd, args as string[], () => resolve()));
}

async function call<T>(fetchImpl: Fetch, core: string, method: string, path: string, body?: unknown, access?: string): Promise<T> {
  const res = await fetchImpl(`${core}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(access ? { authorization: `Bearer ${access}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new HostError(`${typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`}: ${typeof data['message'] === 'string' ? data['message'] : ''}`);
  return data as T;
}

/** The browser sign-in; resolves with a refresh token and an access token. */
export async function signIn(core: string, o: { fetchImpl?: Fetch; open?: (url: string) => Promise<void>; timeoutMs?: number } = {}): Promise<{ access: string; refresh: string; name: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let expected = '';
  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codeP = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code') ?? '';
    if (url.pathname !== '/callback' || !expected || url.searchParams.get('request') !== expected || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('This sign-in belongs to another window.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('You are signed in to the FlatChat host tool. You can close this tab.');
    settle.resolve(code);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => settle.reject(new HostError('the sign-in took too long')), o.timeoutMs ?? 600_000);
  try {
    const lr = await call<{ request: string; signinUrl: string }>(fetchImpl, core, 'POST', '/api/v1/login-requests', { challenge, port });
    if (new URL(lr.signinUrl).origin !== core) throw new HostError('the sign-in page is not on the core');
    expected = lr.request;
    process.stderr.write(`Opening ${lr.signinUrl} in your browser…\n`);
    await (o.open ?? openBrowser)(lr.signinUrl);
    const code = await codeP;
    const t = await call<{ access: string; refresh: string; account: { displayName: string } }>(fetchImpl, core, 'POST', '/api/v1/sessions', { request: lr.request, code, verifier });
    return { access: t.access, refresh: t.refresh, name: t.account.displayName };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

/** A fresh access token from the saved session (the refresh token rotates and is saved again). */
export async function access(fetchImpl: Fetch = fetch, file = SESSION_FILE): Promise<{ core: string; access: string }> {
  const saved = existsSync(file) ? loadSession() : undefined;
  if (!saved) throw new HostError('not signed in: run `host signin --core URL` first');
  const t = await call<{ access: string; refresh: string }>(fetchImpl, saved.core, 'POST', '/api/v1/sessions/refresh', { refresh: saved.refresh });
  saveSession({ core: saved.core, refresh: t.refresh }, file);
  return { core: saved.core, access: t.access };
}

export interface MyWorld {
  id: string;
  name: string;
  status: string;
  address: string;
  capacity: number;
}

export const api = {
  worlds: (f: Fetch, core: string, a: string): Promise<{ worlds: MyWorld[] }> => call(f, core, 'GET', '/api/v1/my/worlds', undefined, a),
  request: (f: Fetch, core: string, a: string, name: string, capacity: number): Promise<{ id: string; status: string }> => call(f, core, 'POST', '/api/v1/worlds', { name, address: 'relay', capacity }, a),
  key: (f: Fetch, core: string, a: string, id: string): Promise<{ key: string }> => call(f, core, 'GET', `/api/v1/worlds/${id}/key`, undefined, a),
};

/** Where an approved world's key and id live for `host run`: one env file per world, user-only. */
export function worldEnvFile(id: string): string {
  return join(CONFIG_DIR, 'worlds', `${id}.env`);
}

export function saveWorldKey(id: string, keyHex: string): string {
  const file = worldEnvFile(id);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `FLATCHAT_WORLD_ID=${id}\nFLATCHAT_WORLD_KEY=${keyHex}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
