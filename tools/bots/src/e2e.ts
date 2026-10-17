// SPDX-License-Identifier: MPL-2.0
// Stage 1's path end to end, with every real program: a private PostgreSQL, the core, an invited
// account, a world registered and approved through the admin command line, a world server on the
// plaza hosted the way a home PC hosts it (its WebRTC offers relayed by the core over the world's
// own WebSocket, S1.13), and the packaged client driven by Playwright. The test plays the system browser over HTTP
// (it opens the sign-in page the client asked for, posts the form, and follows the redirect to the
// client's loopback port); everything else is the client's own: the world list, joining, the
// microphone question, walking, chat. It needs a display (Xvfb in CI) and PostgreSQL's programs.
//
//   node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--keep]
//
// One JSON line: { event: 'e2e', ok, steps, server } ; exit 0 when every step passed.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const EMAIL = 'e2e@example.org';
const PASSWORD = 'an end-to-end password';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { shot: { type: 'string' }, shots: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const client = positionals[0];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/e2e.ts -- CLIENT [--shot FILE]\n');
  process.exit(2);
}

const steps: Record<string, unknown> = {};
const children: ChildProcess[] = [];
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

function freePort(): Promise<number> {
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
function run(cmd: string[], env: Record<string, string> = {}): Promise<string> {
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
function start(cmd: string[], env: Record<string, string>, event: string): Promise<{ proc: ChildProcess; lines: Array<Record<string, unknown>> }> {
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

function stop(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.on('exit', () => resolve());
    proc.stdin?.end('stop\n');
    setTimeout(() => proc.kill('SIGKILL'), 10_000).unref();
  });
}

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const dir = mkdtempSync('/tmp/fce2e-');
let ok = false;
let serverSummary: Record<string, unknown> | undefined;
try {
  // 1. The database, the core, an account.
  const db = (await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'start', '--dir', join(dir, 'pg')])).match(/FLATCHAT_CORE_DB=(\S+)/)?.[1];
  if (!db) throw new Error('no database');
  const corePort = await freePort();
  const coreUrl = `http://127.0.0.1:${corePort}`;
  // No STUN: the test stays on this machine.
  const coreEnv = { FLATCHAT_CORE_DB: db, FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'), FLATCHAT_CORE_URL: coreUrl, FLATCHAT_CORE_STUN: 'none' };
  const core = await start([process.execPath, join(CORE, 'src', 'main.ts'), '--port', String(corePort), '--stop-on-stdin'], coreEnv, 'ready');
  const admin = (...args: string[]): Promise<string> => run([process.execPath, join(CORE, 'src', 'admin.ts'), ...args], coreEnv);
  const invite = (await admin('invite', '--email', EMAIL, '--note', 'e2e')).match(/invite=(\S+)/)?.[1];
  const signup = await fetch(`${coreUrl}/signup?lang=en`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ invitation: invite ?? '', email: EMAIL, password: PASSWORD, displayName: 'Tester One', birthMonth: '4', birthYear: '1994', country: 'CO', consent: 'yes' }),
  });
  steps['signup'] = signup.status;
  if (signup.status !== 201) throw new Error(`sign-up answered ${signup.status}`);

  // 2. A world on the plaza, registered and approved, taking its offers through the core.
  const [icePort, signalPort] = [await freePort(), await freePort()];
  const worldId = (await admin('world', 'register', '--name', 'E2E Plaza', '--owner', EMAIL, '--address', 'relay')).match(/registered (\S+)/)?.[1];
  const approved = await admin('world', 'approve', worldId ?? '');
  const key = approved.match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1];
  if (!worldId || !key) throw new Error('no approved world');
  const world = await start(
    [process.execPath, SERVER_MAIN, '--transport', 'rtc', '--map', 'plaza', '--rtc-port', String(icePort), '--signal-port', String(signalPort), '--bind', '127.0.0.1', '--rtc-bind', '127.0.0.1', '--metrics-every', '0', '--world-id', worldId, '--core', coreUrl, '--relay', '--stop-on-stdin'],
    { FLATCHAT_WORLD_KEY: key },
    'ready',
  );
  // The world is online once the core has accepted its proof.
  await waitFor('the world to reach the core', 15_000, async () => (world.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
  steps['world'] = 'relayed';

  // 3. The client, with its own empty profile; the system browser is replaced by this test.
  const app = await electron.launch({
    executablePath: client,
    args: [`--core=${coreUrl}`, ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : [])],
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), APPDATA: join(dir, 'config') },
    timeout: 60_000,
  });
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __opened?: string[] }).__opened = opened;
      shell.openExternal = async (url: string): Promise<void> => {
        opened.push(url);
      };
    });
    const page = await app.firstWindow();
    await page.locator('[data-test=sign-in]').click({ timeout: 30_000 });
    const signinUrl = await waitFor('the sign-in page to open', 10_000, async () => (await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened?.[0])) ?? undefined);
    // The browser: the page, the form, the redirect to the client's loopback port.
    const pageRes = await fetch(signinUrl);
    steps['signinPage'] = pageRes.status;
    const request = new URL(signinUrl).searchParams.get('request') ?? '';
    const posted = await fetch(`${coreUrl}/signin?lang=en`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request, email: EMAIL, password: PASSWORD }),
      redirect: 'manual',
    });
    const callback = posted.headers.get('location') ?? '';
    steps['redirect'] = callback.replace(/code=[^&]+/, 'code=…');
    const back = await fetch(callback);
    steps['callback'] = back.status;
    // The client: signed in, the world list, join.
    await page.locator('[data-test=join]').first().click({ timeout: 20_000 });
    steps['joined'] = await page.locator('[data-test=mic-choose]').isVisible({ timeout: 20_000 }).catch(() => false);
    await page.locator('[data-test=mic-choose]').click({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 20_000 });
    const snap = async (name: string): Promise<void> => {
      if (values.shots) await page.screenshot({ path: join(values.shots, `${name}.png`) });
    };
    await page.waitForTimeout(500);
    await snap('1-joined');
    // Walk forward for a second and jump, then chat.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Space');
    await page.keyboard.up('KeyW');
    await snap('2-walked');
    await page.keyboard.press('Enter');
    await page.locator('[data-test=chat-input]').fill('hola desde la prueba');
    await page.keyboard.press('Enter');
    await page.locator('[data-test=chat-line]', { hasText: 'Tester One: hola desde la prueba' }).waitFor({ timeout: 10_000 });
    steps['chat'] = true;
    if (values.shot) await page.screenshot({ path: values.shot });
  } finally {
    await app.close();
  }

  // 4. What the world saw.
  await stop(world.proc);
  serverSummary = world.lines.find((l) => l['event'] === 'stopped')?.['summary'] as Record<string, unknown> | undefined;
  const events = (serverSummary?.['events'] ?? {}) as Record<string, { messages: number }>;
  steps['server'] = { joins: events['join']?.messages ?? 0, poses: events['pose:applied']?.messages ?? 0, corrected: events['pose:corrected']?.messages ?? 0, chat: events['chat']?.messages ?? 0 };
  ok = (events['join']?.messages ?? 0) === 1 && (events['pose:applied']?.messages ?? 0) > 10 && (events['chat']?.messages ?? 0) === 1;
  await stop(core.proc);
} catch (err) {
  steps['error'] = err instanceof Error ? err.message : String(err);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('e2e', { ok, steps });
process.exit(ok ? 0 : 1);
