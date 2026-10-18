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
// client's loopback port); everything else is the client's own: an avatar uploaded, a standard body
// taken and worn, the test tee uploaded (S5.05) and published to the free gallery (S5.06), the world
// browser, joining, the microphone question, the tee put on from the outfits menu and drawn on the
// body, an outfit saved, a dance uploaded with its sound and played from the emotes menu, the
// sound with it, until walking ends it (S5.07), walking, chat, and walking through the portal into the second world, the outfit still on. It needs a display (Xvfb in CI) and PostgreSQL's programs.
//
//   node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--shots DIR] [--relay] [--keep]
//
// One JSON line: { event: 'e2e', ok, steps, server } ; exit 0 when every step passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sampleBvh, sampleSong } from '@flatchat/converter/animation-samples';
import { sampleAvatar } from '@flatchat/converter/samples';
import { _electron as electron } from 'playwright-core';
import { children, freePort, run, start, startTurn, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const TEE = join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb');
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
    // Avatars (S4.05): the store in the test's folder. Textures in KTX2, as every real upload
    // (S4.12): the client then decodes them in its Basis worker under the page's policy, which
    // hung every textured level until the transcoder's embind helpers stopped building code from text.
    FLATCHAT_CORE_STORE: join(dir, 'store'),
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
  // A tester may upload an avatar (S4.01); the reference VRM 1.0 avatar stands in for one of theirs.
  await admin('account', EMAIL, '--tester', 'on');
  const avatarFile = join(dir, 'sample.vrm');
  writeFileSync(avatarFile, await sampleAvatar('vrm1'));
  // A dance (S5.07): the converter's sample motion as BVH.
  const danceFile = join(dir, 'wave.bvh');
  writeFileSync(danceFile, sampleBvh());
  // Its sound: the converter's sung vowels.
  const songFile = join(dir, 'song.wav');
  writeFileSync(songFile, sampleSong());

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
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), APPDATA: join(dir, 'config'), FLATCHAT_E2E_AVATAR: avatarFile, FLATCHAT_E2E_ITEM: TEE, FLATCHAT_E2E_ANIMATION: danceFile, FLATCHAT_E2E_AUDIO: songFile },
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
    // An avatar (S4.01): uploaded from the home screen, converted by the core, worn.
    await page.locator('[data-test=upload-avatar]').click({ timeout: 10_000 });
    await page.locator('[data-test=avatar][data-status=ready]').waitFor({ timeout: 90_000 });
    await page.locator('[data-test=wear-avatar]').click({ timeout: 10_000 });
    await page.locator('[data-test=wear-avatar]').waitFor({ state: 'detached', timeout: 10_000 });
    steps['avatar'] = 'worn';
    // A standard body (S5.05): taken with no upload, converted by the core, worn once ready; then
    // the test tee, uploaded and converted with the bodies at hand.
    await page.locator('[data-test=kit-feminine]').click({ timeout: 10_000 });
    steps['kit'] = await page
      .locator('[data-test=avatar][data-kit=feminine][data-wearing=true]')
      .waitFor({ timeout: 150_000 })
      .then(() => 'worn')
      .catch(() => 'not worn');
    await page.locator('[data-test=upload-item]').click({ timeout: 10_000 });
    steps['item'] = await page
      .locator('[data-test=item][data-status=ready]')
      .waitFor({ timeout: 120_000 })
      .then(() => 'ready')
      .catch(async () => (await page.locator('[data-test=item]').first().getAttribute('data-status').catch(() => null)) ?? 'none');
    // The starter wardrobe (P.08): the grey fedora taken with no upload, converted by the core.
    await page.locator('[data-test=starter][data-id=grey-fedora] [data-test=take-starter]').click({ timeout: 10_000 });
    steps['starter'] = await page
      .locator('[data-test=item][data-status=ready]', { hasText: 'Grey fedora' })
      .waitFor({ timeout: 120_000 })
      .then(async () => ((await page.locator('[data-test=starter][data-id=grey-fedora]').getAttribute('data-taken')) === 'true' ? 'ready' : 'not marked taken'))
      .catch(async () => (await page.locator('[data-test=item]', { hasText: 'Grey fedora' }).first().getAttribute('data-status').catch(() => null)) ?? 'none');
    // The free gallery (S5.06): the tee published under the strictest licence (the tester may
    // publish), then found among the gallery's items with its makers.
    await page.locator('[data-test=publish-item]').first().click({ timeout: 10_000 });
    await page.locator('[data-test=publish-affirm]').check({ timeout: 10_000 });
    await page.locator('[data-test=publish-send]').click({ timeout: 10_000 });
    await page.locator('[data-test=item-published]').waitFor({ timeout: 15_000 });
    await page.locator('[data-test=gallery-items]').click({ timeout: 10_000 });
    steps['published'] = await page
      .locator('[data-test=gallery-entry]', { hasText: 'Tee' })
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    // An emote or a dance (S5.07): the sample uploaded as a dance and converted into VRMA.
    await page.locator('[data-test=upload-with-sound]').check({ timeout: 10_000 });
    await page.locator('[data-test=upload-dance]').click({ timeout: 10_000 });
    steps['animation'] = await page
      .locator('[data-test=animation][data-status=ready]')
      .waitFor({ timeout: 90_000 })
      .then(() => 'ready')
      .catch(async () => (await page.locator('[data-test=animation]').first().getAttribute('data-status').catch(() => null)) ?? 'none');
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
    // isVisible() answers at once (Playwright ignores its timeout): wait for the chooser instead.
    steps['joined'] = await page
      .locator('[data-test=mic-choose]')
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    await page.locator('[data-test=mic-choose]').click({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 20_000 });
    // The worn avatar drawn in the world (S4.05): this player's own, in full (the view starts in
    // third person, so '1-joined' shows it from behind).
    steps['avatarDrawn'] = await page
      .locator('[data-test=avatar-counts][data-lod0="1"]')
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    // The outfits menu (S5.05): the tee put on; the world sends the outfit back in the roster and
    // the client draws the tee's fit on the body it wears. Then the look saved as an outfit.
    await page.keyboard.press('KeyO');
    await page.locator('[data-test=outfit-menu]').waitFor({ timeout: 10_000 });
    await page.locator('[data-test=outfit-item]').first().click({ timeout: 10_000 });
    steps['dressed'] = await page
      .locator('[data-test=outfit][data-items="1"][data-dressed="1"]')
      .waitFor({ state: 'attached', timeout: 45_000 })
      .then(() => true)
      .catch(async () => `${await page.locator('[data-test=outfit]').getAttribute('data-items').catch(() => '?')} worn, ${await page.locator('[data-test=outfit]').getAttribute('data-dressed').catch(() => '?')} drawn`);
    await page.locator('[data-test=outfit-name]').fill('E2E look');
    await page.locator('[data-test=outfit-save]').click({ timeout: 10_000 });
    steps['outfitSaved'] = await page
      .locator('[data-test=outfit-saved]', { hasText: 'E2E look' })
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press('KeyO');
    await page.locator('[data-test=outfit-menu]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForTimeout(500);
    await snap('1-dressed');
    // The fountain's sound plays (S2.14): one emitter, from the downloaded world.
    steps['sounds'] = await page.locator('[data-test=sounds]').getAttribute('data-playing', { timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(500);
    await snap('1-joined');
    // Walk forward for a second and jump, then chat.
    // The dance from the emotes menu (B): the world sends it back in the roster, the avatar plays
    // it; walking ends it.
    await page.keyboard.press('KeyB');
    await page.locator('[data-test=emote-menu]').waitFor({ timeout: 10_000 });
    await page.locator('[data-test=emote-play]').first().click({ timeout: 10_000 });
    steps['emoted'] = await page
      .locator('[data-test=emote][data-playing="1"]')
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    // Its sound plays at the dancer, in step.
    steps['danceSound'] = await page
      .locator('[data-test=emote][data-sounds="1"]')
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(700);
    await snap('1c-dancing');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Space');
    await page.keyboard.up('KeyW');
    // The walk sounded: the default footsteps (P.06), one a stride.
    steps['footsteps'] = Number(await page.locator('[data-test=sounds]').getAttribute('data-footsteps', { timeout: 10_000 }).catch(() => '0'));
    steps['emoteStopped'] = await page
      .locator('[data-test=emote][data-playing="0"][data-anim=""]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
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
    // A report from inside the world (S3.02): the menu, the form, the receipt.
    await page.keyboard.press('Escape');
    const reportWorld = page.locator('[data-test=report-world]');
    await reportWorld.waitFor({ timeout: 10_000 });
    await snap('2c-menu');
    // Where the menu's buttons are, and how big the window is: the record if a click goes astray.
    // (Run in the page, which has a DOM; this program does not.)
    steps['menu'] = await page.evaluate(`({
      view: [innerWidth, innerHeight, devicePixelRatio],
      buttons: [...document.querySelectorAll('.menu button')].map((b) => {
        const r = b.getBoundingClientRect();
        return [b.dataset.test ?? '', Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }),
    })`);
    // The keyboard's way, which every player has: focus the button and press Enter.
    await reportWorld.focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-test=report-category]').selectOption('harassment');
    await page.locator('[data-test=report-text]').fill('A test report from the end-to-end test.');
    await page.locator('[data-test=report-send]').click();
    steps['report'] = await page.locator('[data-test=report-receipt]').getAttribute('data-receipt', { timeout: 15_000 }).catch(() => null);
    await snap('2c-report');
    await page.locator('[data-test=report-done]').click();
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
    // The outfit came along (S5.05): kept in the settings by account, sent to the new world at its first roster.
    steps['outfitKept'] = await page
      .locator('[data-test=outfit][data-items="1"][data-dressed="1"]')
      .waitFor({ state: 'attached', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
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
    Number(steps['footsteps']) > 0 &&
    steps['people'] === 'owner' &&
    steps['avatar'] === 'worn' &&
    steps['avatarDrawn'] === true &&
    steps['kit'] === 'worn' &&
    steps['item'] === 'ready' &&
    steps['starter'] === 'ready' &&
    steps['published'] === true &&
    steps['dressed'] === true &&
    steps['outfitSaved'] === true &&
    steps['outfitKept'] === true &&
    steps['animation'] === 'ready' &&
    steps['emoted'] === true &&
    steps['danceSound'] === true &&
    steps['emoteStopped'] === true &&
    /^R-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(String(steps['report'])) &&
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
