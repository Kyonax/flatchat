// SPDX-License-Identifier: MPL-2.0
// Stage 1's path end to end, with every real program: a private PostgreSQL, the core, an invited
// account, a world registered and approved through the admin command line, a world server on the
// plaza hosted the way a home PC hosts it (its WebRTC offers relayed by the core over the world's
// own WebSocket, S1.13; the plaza converted from kits/worlds/plaza and downloaded by the client
// over its connection, S2.03 and S2.04), and the packaged client driven by Playwright. The test plays the system browser over HTTP
// (it opens the sign-in page the client asked for, posts the form, and follows the redirect to the
// client's loopback port); everything else is the client's own: the world list, joining, the
// microphone question, walking, chat. It needs a display (Xvfb in CI) and PostgreSQL's programs.
//
//   node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--keep]
//
// One JSON line: { event: 'e2e', ok, steps, server } ; exit 0 when every step passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { children, freePort, run, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const CONVERT = join(ROOT, 'tools', 'converter', 'src', 'cli.ts');
const PLAZA_WORLD = join(ROOT, 'kits', 'worlds', 'plaza');
const EMAIL = 'e2e@example.org';
const PASSWORD = 'an end-to-end password';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { shot: { type: 'string' }, shots: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const client = positionals[0];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/e2e.ts -- CLIENT [--shot FILE]\n');
  process.exit(2);
}

const steps: Record<string, unknown> = {};
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

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
  const built = join(dir, 'built');
  await run([process.execPath, CONVERT, PLAZA_WORLD, built]);
  const worldId = (await admin('world', 'register', '--name', 'E2E Plaza', '--owner', EMAIL, '--address', 'relay')).match(/registered (\S+)/)?.[1];
  const approved = await admin('world', 'approve', worldId ?? '');
  const key = approved.match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1];
  if (!worldId || !key) throw new Error('no approved world');
  const world = await start(
    [process.execPath, SERVER_MAIN, '--transport', 'rtc', '--world', built, '--rtc-port', String(icePort), '--signal-port', String(signalPort), '--bind', '127.0.0.1', '--rtc-bind', '127.0.0.1', '--metrics-every', '0', '--world-id', worldId, '--core', coreUrl, '--relay', '--stop-on-stdin'],
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
    const snap = async (name: string): Promise<void> => {
      if (values.shots) await page.screenshot({ path: join(values.shots, `${name}.png`) });
    };
    // The client: signed in, the world browser (S2.09), join.
    await page.locator('[data-test=public] [data-test=join]').first().waitFor({ timeout: 20_000 });
    await snap('0-home');
    await page.locator('[data-test=public] [data-test=join]').first().click({ timeout: 20_000 });
    steps['joined'] = await page.locator('[data-test=mic-choose]').isVisible({ timeout: 20_000 }).catch(() => false);
    await page.locator('[data-test=mic-choose]').click({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 20_000 });
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
  const received = (serverSummary?.['received'] ?? {}) as Record<string, { messages: number }>;
  steps['server'] = { joins: events['join']?.messages ?? 0, poses: events['pose:applied']?.messages ?? 0, corrected: events['pose:corrected']?.messages ?? 0, chat: events['chat']?.messages ?? 0, fetches: received['fetch']?.messages ?? 0 };
  // The world's content came down: world.json, the scene, the collision file and the navigation mesh.
  ok = (events['join']?.messages ?? 0) === 1 && (events['pose:applied']?.messages ?? 0) > 10 && (events['chat']?.messages ?? 0) === 1 && (received['fetch']?.messages ?? 0) >= 3;
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
