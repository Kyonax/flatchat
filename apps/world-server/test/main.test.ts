// SPDX-License-Identifier: MPL-2.0
// Runs the real server process headless and reads its JSON lines.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Run {
  code: number | null;
  events: Array<Record<string, unknown>>;
}

function run(args: string[], onReady?: (pid: number) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        events.push(event);
        if (event['event'] === 'ready' && child.pid !== undefined) onReady?.(child.pid);
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not stop: ${JSON.stringify(events)}`));
    }, 10_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, events });
    });
  });
}

describe('world server process', () => {
  it('starts headless, ticks and stops at its tick limit', async () => {
    const { code, events } = await run(['--port', '0', '--tick-hz', '50', '--ticks', '10']);
    expect(code).toBe(0);
    expect(events.map((e) => e['event'])).toEqual(['ready', 'stopped']);
    const [ready, stopped] = events;
    expect(ready?.['tickHz']).toBe(50);
    expect(ready?.['port']).toBeGreaterThan(0);
    expect(stopped).toMatchObject({ reason: 'tick-limit', ticks: 10 });
  });

  it('stops cleanly on SIGTERM', async () => {
    const { code, events } = await run(['--port', '0'], (pid) => {
      setTimeout(() => process.kill(pid, 'SIGTERM'), 150);
    });
    expect(code).toBe(0);
    expect(events.at(-1)).toMatchObject({ event: 'stopped', reason: 'SIGTERM' });
    expect(events.at(-1)?.['ticks']).toBeGreaterThan(0);
  });

  it('refuses a bad port with exit code 2', async () => {
    const { code, events } = await run(['--port', '70000']);
    expect(code).toBe(2);
    expect(events[0]).toMatchObject({ event: 'error' });
  });
});
