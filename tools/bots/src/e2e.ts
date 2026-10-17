// SPDX-License-Identifier: MPL-2.0
// Stage 1's path end to end, with every real program: a private PostgreSQL, the core, an invited
// account, two worlds registered and approved through the admin command line, each world server on
// a plaza hosted the way a home PC hosts it (its WebRTC offers relayed by the core over the world's
// own WebSocket, S1.13; the plaza converted from kits/worlds/plaza and downloaded by the client
// over its connection, S2.03 and S2.04; each plaza with a portal to the other, S2.11), and the
// packaged client driven by Playwright. With --relay the client runs --relay-only, as a player behind
// a NAT that lets nothing through but a TURN relay (S2.12): its first join must fail while no relay
// runs, then coturn starts ("the relay we run", with the core's shared-secret credentials) and the
// same join goes through it. --relay needs coturn's turnserver on the PATH. The test plays the system browser over HTTP
// (it opens the sign-in page the client asked for, posts the form, and follows the redirect to the
// client's loopback port); everything else is the client's own: the world browser, joining, the
// microphone question, walking, chat, and walking through the portal into the second world. It needs a display (Xvfb in CI) and PostgreSQL's programs.
//
//   node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--shots DIR] [--relay] [--keep]
//
// One JSON line: { event: 'e2e', ok, steps, server } ; exit 0 when every step passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { children, freePort, run, start, startTurn, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const EMAIL = 'e2e@example.org';
const PASSWORD = 'an end-to-end password';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { shot: { type: 'string' }, shots: { type: 'string' }, relay: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } },
});
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
  // No STUN: the test stays on this machine. With --relay the core hands out credentials for a
  // TURN server that is not running yet.
  const turnPort = await freePort();
  const turnSecret = randomBytes(24).toString('hex');
  const coreEnv = {
    FLATCHAT_CORE_DB: db,
    FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'),
    FLATCHAT_CORE_URL: coreUrl,
    FLATCHAT_CORE_STUN: 'none',
    ...(values.relay ? { FLATCHAT_CORE_TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=udp`, FLATCHAT_CORE_TURN_SECRET: turnSecret } : {}),
  };
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

  // 2. Two plazas whose portals lead to each other, registered and approved, taking their offers
  //    through the core.
  const register = async (name: string): Promise<{ id: string; key: string }> => {
    const id = (await admin('world', 'register', '--name', name, '--owner', EMAIL, '--address', 'relay')).match(/registered (\S+)/)?.[1];
    const key = (await admin('world', 'approve', id ?? '')).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1];
    if (!id || !key) throw new Error(`no approved world ${name}`);
    return { id, key };
  };
  const plaza = await register('E2E Plaza');
  const garden = await register('E2E Garden');
  // The garden is the park, made only of base library parts (S2.05): it sends nothing but its plan.
  await run([process.execPath, MAKE_TRAVEL, join(dir, 'travel'), '--worlds', `${plaza.id},${garden.id}`, '--names', 'E2E Plaza,E2E Garden', '--kits', 'plaza,park']);
  const host = async (w: { id: string; key: string }, built: string): Promise<Awaited<ReturnType<typeof start>>> => {
    const [icePort, signalPort] = [await freePort(), await freePort()];
    const s = await start(
      [
        process.execPath, SERVER_MAIN, '--transport', 'rtc', '--world', built, '--rtc-port', String(icePort), '--signal-port', String(signalPort), '--bind', '127.0.0.1', '--rtc-bind', '127.0.0.1',
        '--metrics-every', '0', '--world-id', w.id, '--data', join(dir, `${w.id}.db`), '--core', coreUrl, '--relay', '--stop-on-stdin',
      ],
      { FLATCHAT_WORLD_KEY: w.key },
      'ready',
    );
    // The world is online once the core has accepted its proof.
    await waitFor('the world to reach the core', 15_000, async () => (s.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
    return s;
  };
  const world = await host(plaza, join(dir, 'travel', 'a.built'));
  const second = await host(garden, join(dir, 'travel', 'b.built'));
  steps['world'] = 'relayed';

  // 3. The client, with its own empty profile; the system browser is replaced by this test.
  const app = await electron.launch({
    executablePath: client,
    args: [`--core=${coreUrl}`, ...(values.relay ? ['--relay-only'] : []), ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : [])],
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
    const joinPlaza = page.locator(`[data-test=public] [data-world="${plaza.id}"] [data-test=join]`);
    await joinPlaza.waitFor({ timeout: 20_000 });
    await snap('0-home');
    if (values.relay) {
      // Relay only, and no relay yet: the join cannot reach the world.
      await joinPlaza.click({ timeout: 20_000 });
      await page.locator('[data-test=world-back]').waitFor({ timeout: 45_000 });
      steps['withoutRelay'] = 'no connection';
      await page.locator('[data-test=world-back]').click();
      await startTurn(turnPort, turnSecret, dir);
      steps['relay'] = 'coturn running';
    }
    await joinPlaza.click({ timeout: 20_000 });
    steps['joined'] = await page.locator('[data-test=mic-choose]').isVisible({ timeout: 20_000 }).catch(() => false);
    await page.locator('[data-test=mic-choose]').click({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 20_000 });
    // The fountain's sound plays (S2.14): one emitter, from the downloaded world.
    steps['sounds'] = await page.locator('[data-test=sounds]').getAttribute('data-playing', { timeout: 10_000 }).catch(() => null);
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
    // The People panel (S3.06): this account owns the world, and the token says so.
    await page.keyboard.press('Tab');
    steps['people'] = await page.locator('[data-test=people] [data-test=person]').first().getAttribute('data-role', { timeout: 10_000 }).catch(() => null);
    await snap('2b-people');
    await page.keyboard.press('Tab');
    if (values.shot) await page.screenshot({ path: values.shot });
    // Back through the portal south of the spawn (S2.11): the world says so, the client asks the
    // core for the garden and joins it at its arrival spawn.
    await page.keyboard.down('KeyS');
    await page.locator('[data-test=travel]').waitFor({ timeout: 15_000 }).catch(() => undefined);
    await page.keyboard.up('KeyS');
    await page.locator('.whud.top strong', { hasText: 'E2E Garden' }).waitFor({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 20_000 });
    steps['travelled'] = true;
    steps['gardenParts'] = await page.locator('[data-test=sounds]').getAttribute('data-parts', { timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(500);
    await snap('3-travelled');
  } finally {
    await app.close();
  }

  // 4. What the worlds saw.
  await stop(world.proc);
  await stop(second.proc);
  serverSummary = world.lines.find((l) => l['event'] === 'stopped')?.['summary'] as Record<string, unknown> | undefined;
  const events = (serverSummary?.['events'] ?? {}) as Record<string, { messages: number }>;
  const received = (serverSummary?.['received'] ?? {}) as Record<string, { messages: number }>;
  const gardenSummary = second.lines.find((l) => l['event'] === 'stopped')?.['summary'] as Record<string, unknown> | undefined;
  const garden2 = (gardenSummary?.['events'] ?? {}) as Record<string, { messages: number }>;
  const gardenSent = (gardenSummary?.['sent'] ?? {}) as Record<string, { bytes: number }>;
  steps['server'] = {
    joins: events['join']?.messages ?? 0,
    poses: events['pose:applied']?.messages ?? 0,
    corrected: events['pose:corrected']?.messages ?? 0,
    chat: events['chat']?.messages ?? 0,
    fetches: received['fetch']?.messages ?? 0,
    portals: events['portal']?.messages ?? 0,
    travelled: events['leave:travel']?.messages ?? 0,
    gardenJoins: garden2['join']?.messages ?? 0,
    gardenContentBytes: gardenSent['chunk']?.bytes ?? 0,
  };
  // The world's content came down: world.json, the scenes, the collision file and the navigation mesh.
  ok =
    (events['join']?.messages ?? 0) === 1 &&
    (events['pose:applied']?.messages ?? 0) > 10 &&
    (events['chat']?.messages ?? 0) === 1 &&
    (received['fetch']?.messages ?? 0) >= 3 &&
    (events['portal']?.messages ?? 0) >= 1 &&
    (events['leave:travel']?.messages ?? 0) === 1 &&
    (garden2['join']?.messages ?? 0) === 1 &&
    steps['sounds'] === '1' &&
    steps['people'] === 'owner' &&
    Number(steps['gardenParts']) > 60 &&
    (gardenSent['chunk']?.bytes ?? Infinity) < 64 * 1024;
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
