// SPDX-License-Identifier: MPL-2.0
// The child programs the end-to-end checks run (the database, the core, world servers): start one
// and wait for a JSON line, stop it through its standard input, poll for a condition.
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

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
