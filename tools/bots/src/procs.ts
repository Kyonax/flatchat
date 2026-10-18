// SPDX-License-Identifier: MPL-2.0
// The child programs the end-to-end checks run (the database, the core, world servers): start one
// and wait for a JSON line, stop it through its standard input, poll for a condition; and an
// account made and signed in over HTTP, the way the client and its browser do it.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Every program started here, so a check can kill what is left when it fails. */
export const children: ChildProcess[] = [];

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

/** Runs a command to its end and returns its output. */
export function run(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd.slice(0, 3).join(' ')} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/** Starts a program that writes JSON lines; resolves with its lines once `event` appears. */
export function start(cmd: string[], env: Record<string, string>, event: string): Promise<{ proc: ChildProcess; lines: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(proc);
    const lines: Array<Record<string, unknown>> = [];
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`no ${event} line from ${cmd[1]}`)), 30_000);
    proc.stdout!.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const line = JSON.parse(text) as Record<string, unknown>;
          lines.push(line);
          if (line['event'] === event) {
            clearTimeout(timer);
            resolve({ proc, lines });
          }
        } catch {
          // not a JSON line
        }
      }
    });
    proc.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('exit', (code) => reject(new Error(`${cmd[1]} exited ${code} before ${event}`)));
  });
}

export function stop(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.on('exit', () => resolve());
    proc.stdin?.end('stop\n');
    setTimeout(() => proc.kill('SIGKILL'), 10_000).unref();
  });
}

export async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Signs up with an invitation and signs in the way the client does (a PKCE login request, the
 *  sign-in page's form, the code exchange), playing the browser over HTTP. Returns the access token;
 *  never print it. `extra` goes with every request (a forwarded address, for a core behind a tunnel). */
export async function signUpAndIn(coreUrl: string, invitation: string, email: string, password: string, displayName: string, extra: Record<string, string> = {}): Promise<string> {
  const form = { 'content-type': 'application/x-www-form-urlencoded', ...extra };
  const json = { 'content-type': 'application/json', ...extra };
  const signup = await fetch(`${coreUrl}/signup?lang=en`, {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({ invitation, email, password, displayName, birthMonth: '4', birthYear: '1994', country: 'CO', consent: 'yes' }),
  });
  if (signup.status !== 201) throw new Error(`sign-up answered ${signup.status}`);
  const verifier = randomBytes(48).toString('base64url');
  const lr = (await (await fetch(`${coreUrl}/api/v1/login-requests`, { method: 'POST', headers: json, body: JSON.stringify({ challenge: createHash('sha256').update(verifier).digest('base64url'), port: 50_000 }) })).json()) as { request: string };
  const posted = await fetch(`${coreUrl}/signin?lang=en`, { method: 'POST', headers: form, body: new URLSearchParams({ request: lr.request, email, password }), redirect: 'manual' });
  const code = new URL(posted.headers.get('location') ?? 'http://x/').searchParams.get('code') ?? '';
  const session = (await (await fetch(`${coreUrl}/api/v1/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ request: lr.request, code, verifier }) })).json()) as { access?: string };
  if (!session.access) throw new Error('no session');
  return session.access;
}

/** Whether a STUN server answers a binding request on this machine's UDP port (RFC 5389). */
export function stunAnswers(port: number, ms = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt32BE(0x2112a442, 4);
    randomBytes(12).copy(request, 8);
    const done = (answered: boolean): void => {
      clearTimeout(timer);
      socket.close();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), ms);
    socket.on('message', (msg) => done(msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.subarray(8, 20).equals(request.subarray(8, 20))));
    socket.on('error', () => done(false));
    socket.send(request, port, '127.0.0.1');
  });
}

/** Starts coturn (`turnserver` on the PATH) on this machine as "the relay we run": UDP on `port`,
 *  coturn's shared-secret credentials (the core's FLATCHAT_CORE_TURN_SECRET), loopback peers
 *  allowed, its files in `dir`; resolves once it answers STUN. */
export async function startTurn(port: number, secret: string, dir: string): Promise<ChildProcess> {
  const turn = spawn(
    'turnserver',
    [
      '-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${port}`, '--min-port=49800', '--max-port=49900',
      '--use-auth-secret', `--static-auth-secret=${secret}`, '--realm=flatchat.test', '--no-tls', '--no-dtls', '--no-tcp-relay', '--allow-loopback-peers',
      '--no-cli', '--log-file=stdout', '--simple-log', `--pidfile=${join(dir, 'turn.pid')}`, `--userdb=${join(dir, 'turndb')}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(turn);
  turn.stderr.on('data', (d: Buffer) => process.stderr.write(d));
  await waitFor('coturn to answer STUN', 15_000, async () => ((await stunAnswers(port)) ? true : undefined));
  return turn;
}

/** The client's flags for a run without a window (FLATCHAT_HEADLESS=1): Chromium's own headless
 *  platform, drawing in software as CI's virtual display does, so a local run never takes the
 *  desktop's keyboard and mouse (a person at the machine pressed keys into a test window once). */
export function headless(): string[] {
  return process.env['FLATCHAT_HEADLESS'] === '1' ? ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--enable-unsafe-swiftshader'] : [];
}
