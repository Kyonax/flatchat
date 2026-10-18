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
// taken and worn, the test tee uploaded (S5.05) and published to the free gallery (S5.06), the starter
// aura taken (S6.01), the world browser, joining, the microphone question, the tee put on from the
// outfits menu and drawn on the body, an outfit saved, the aura put on and played, then off again, a dance uploaded with its sound and played from the emotes menu, the
// sound with it, until walking ends it (S5.07), walking, chat, and walking through the portal into the second world, the outfit still on. It needs a display (Xvfb in CI) and PostgreSQL's programs.
//
//   node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--shots DIR] [--relay] [--keep]
//
// One JSON line: { event: 'e2e', ok, steps, server } ; exit 0 when every step passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sampleBvh, sampleSong } from '@flatchat/converter/animation-samples';
import { sampleShaderAvatar } from '@flatchat/converter/samples';
import { _electron as electron } from 'playwright-core';
import { children, freePort, headless, run, start, startTurn, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const HOSTILE = join(ROOT, 'tools', 'converter', 'scripts', 'hostile-effects.ts');
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
  // The reference avatar with a creator shader on it (S6.03): a rim glow over its own colour.
  writeFileSync(avatarFile, await sampleShaderAvatar());
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
  await run([process.execPath, MAKE_TRAVEL, join(dir, 'travel'), '--worlds', `${plaza.id},${garden.id}`, '--names', 'E2E Plaza,E2E Garden', '--kits', 'plaza,park', '--effect', '--overlay', '--look']);
  // The garden's host does not play fair (S6.01): six broken effects beside its tornado, put into
  // the built world past the converter, with made-up numbers. The client must refuse every one.
  await run([process.execPath, HOSTILE, join(dir, 'travel', 'b.built')]);
  const gardenExtraBytes = (JSON.parse(readFileSync(join(dir, 'travel', 'b.built', 'world.json'), 'utf8')) as { files: Array<{ size: number; kind: string }> }).files.filter((f) => f.kind === 'effect' || f.kind === 'overlay').reduce((n, f) => n + f.size, 0);
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
    args: [`--core=${coreUrl}`, ...(values.relay ? ['--relay-only'] : []), ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []), ...headless()],
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
    // The page's own errors, for whoever reads a failed run.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => void (pageErrors.length < 8 && pageErrors.push(e.message.slice(0, 300))));
    page.on('console', (m) => void (m.type() === 'error' && pageErrors.length < 8 && pageErrors.push(`console: ${m.text().slice(0, 300)}`)));
    steps['pageErrors'] = pageErrors;
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
    // A starter overlay (S6.02): the star badge taken with no upload, its PNG written again by the
    // core's converter.
    await page.locator('[data-test=starter][data-id=star-badge] [data-test=take-starter]').click({ timeout: 10_000 });
    steps['starterOverlay'] = await page
      .locator('[data-test=item][data-status=ready]', { hasText: 'Star badge' })
      .waitFor({ timeout: 120_000 })
      .then(() => 'ready')
      .catch(async () => (await page.locator('[data-test=item]', { hasText: 'Star badge' }).first().getAttribute('data-status').catch(() => null)) ?? 'none');
    // A starter effect (S6.01): the aura taken with no upload, dry-run by the core's converter.
    await page.locator('[data-test=starter][data-id=aura] [data-test=take-starter]').click({ timeout: 10_000 });
    steps['starterEffect'] = await page
      .locator('[data-test=item][data-status=ready]', { hasText: 'Aura' })
      .waitFor({ timeout: 120_000 })
      .then(() => 'ready')
      .catch(async () => (await page.locator('[data-test=item]', { hasText: 'Aura' }).first().getAttribute('data-status').catch(() => null)) ?? 'none');
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
    // By name: the list is newest first, and the starters taken at home come after the tee.
    await page.locator('[data-test=outfit-menu] li', { hasText: 'Tee' }).locator('[data-test=outfit-item]').click({ timeout: 10_000 });
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
    // The aura put on beside the tee (S6.01): the runtime loads, the effect plays at the hips within
    // the guard's budget, hidden behind what stands in front of it by the scene's depth. Then off
    // again, so the next world gets the saved outfit.
    const fx = page.locator('[data-test=effects]');
    // The menu's checkbox carries the hook; the item's name is in its row.
    const aura = page.locator('[data-test=outfit-menu] li', { hasText: 'Aura' }).locator('[data-test=outfit-item]');
    await page.keyboard.press('KeyO');
    await aura.click({ timeout: 10_000 });
    await page.keyboard.press('KeyO');
    steps['effect'] = await page
      .locator('[data-test=effects][data-playing="1"]')
      .waitFor({ state: 'attached', timeout: 45_000 })
      .then(async () => {
        await page.waitForTimeout(1500);
        return {
          instances: Number(await fx.getAttribute('data-instances')),
          playing: Number(await fx.getAttribute('data-playing')),
          stopped: Number(await fx.getAttribute('data-stopped')),
          refused: Number(await fx.getAttribute('data-refused')),
          depth: await fx.getAttribute('data-depth'),
          backend: await fx.getAttribute('data-backend'),
        };
      })
      .catch(async () => `playing ${await fx.getAttribute('data-playing').catch(() => '?')}, refused ${await fx.getAttribute('data-refused').catch(() => '?')}, failed ${await fx.getAttribute('data-failed').catch(() => '?')}`);
    await snap('1a-effect');
    await page.keyboard.press('KeyO');
    await aura.click({ timeout: 10_000 });
    await page.keyboard.press('KeyO');
    steps['effectOff'] = await page
      .locator('[data-test=effects][data-playing="0"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    // The star badge on the wearer's own screen (S6.02); the safe-mode key clears it at once and
    // brings it back; then off, so the next world gets the saved outfit.
    const overlays = page.locator('[data-test=overlays]');
    const star = page.locator('[data-test=outfit-menu] li', { hasText: 'Star badge' }).locator('[data-test=outfit-item]');
    await page.keyboard.press('KeyO');
    await star.click({ timeout: 10_000 });
    await page.keyboard.press('KeyO');
    steps['overlay'] = await page
      .locator('[data-test=overlays][data-mine="1"]')
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => true)
      .catch(async () => `mine ${await overlays.getAttribute('data-mine').catch(() => '?')}`);
    await page.waitForTimeout(500);
    await snap('1b-overlay');
    await page.keyboard.press('Shift+Escape');
    steps['safeMode'] = await page
      .locator('[data-test=overlays][data-safe="1"][data-mine="0"]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(async () => page.locator('[data-test=safe-mode]').isVisible())
      .catch(() => false);
    await snap('1c-safe-mode');
    await page.keyboard.press('Shift+Escape');
    steps['safeModeOff'] = await page
      .locator('[data-test=overlays][data-safe="0"][data-mine="1"]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press('KeyO');
    await star.click({ timeout: 10_000 });
    await page.keyboard.press('KeyO');
    steps['overlayOff'] = await page
      .locator('[data-test=overlays][data-mine="0"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
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
    // The garden's own effect (S6.01): measured by the client first, then played for the world.
    steps['worldEffect'] = await page
      .locator('[data-test=effects][data-world="1"]')
      .waitFor({ state: 'attached', timeout: 60_000 })
      .then(async () => Number(await page.locator('[data-test=effects]').getAttribute('data-instances')))
      .catch(async () => `world ${await page.locator('[data-test=effects]').getAttribute('data-world').catch(() => '?')}, refused ${await page.locator('[data-test=effects]').getAttribute('data-refused').catch(() => '?')} (${await page.locator('[data-test=effects]').getAttribute('data-refused-why').catch(() => '?')})`);
    // The garden's look (S6.05): its dusk sky and fog, and its bloom and screen filters drawn.
    steps['worldLook'] = await page
      .locator('[data-test=look][data-bloom="1"][data-filters="1"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(async () => `bloom ${await page.locator('[data-test=look]').getAttribute('data-bloom').catch(() => '?')}, filters ${await page.locator('[data-test=look]').getAttribute('data-filters').catch(() => '?')}`);
    // The garden's own screen overlay (S6.02): on for every visitor.
    steps['worldOverlay'] = await page
      .locator('[data-test=overlays][data-world="1"]')
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => true)
      .catch(async () => `world ${await page.locator('[data-test=overlays]').getAttribute('data-world').catch(() => '?')}`);
    // The garden's broken effects (scripts/hostile-effects.ts): each refused by the client's own
    // check and dry run, the slowest when its measuring worker is ended at the deadline.
    steps['hostileRefused'] = await page
      .locator('[data-test=effects][data-refused="6"]')
      .waitFor({ state: 'attached', timeout: 90_000 })
      .then(() => 6)
      .catch(async () => Number(await page.locator('[data-test=effects]').getAttribute('data-refused').catch(() => '-1')));
    await page.waitForTimeout(500);
    await snap('3-travelled');
    // A GPU reset (S6.03, T-01): the device lost as a driver reset loses it. The view joins the
    // garden again with a fresh renderer, and creator shaders stay off for the session.
    const lostAt = Date.now();
    await page.evaluate(() => (globalThis as unknown as { flatchatTest?: { loseGpu(): void } }).flatchatTest?.loseGpu());
    steps['gpuReset'] = await page
      .locator('[data-test=travel][data-status=gpu]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(async () => {
        await page.locator('[data-test=travel]').waitFor({ state: 'detached', timeout: 30_000 });
        await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 30_000 });
        await page.locator('[data-test=avatar-counts][data-lod0="1"]').waitFor({ state: 'attached', timeout: 30_000 });
        const recoveredMs = Date.now() - lostAt;
        await page.waitForTimeout(1000);
        const counts = page.locator('[data-test=avatar-counts]');
        return { recoveredMs, resets: Number(await counts.getAttribute('data-gpu-resets')), shaders: Number(await counts.getAttribute('data-shaders')) };
      })
      .catch((err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err)));
    await snap('4-after-gpu-reset');
  } catch (err) {
    // What was on screen when a step failed, for whoever reads the run.
    if (values.shots) await (await app.firstWindow()).screenshot({ path: join(values.shots, 'failed.png') }).catch(() => undefined);
    throw err;
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
    // The arrival through the portal, and the join again after the GPU reset.
    (garden2['join']?.messages ?? 0) === 2 &&
    steps['sounds'] === '1' &&
    Number(steps['footsteps']) > 0 &&
    steps['people'] === 'owner' &&
    steps['avatar'] === 'worn' &&
    steps['avatarDrawn'] === true &&
    steps['kit'] === 'worn' &&
    steps['item'] === 'ready' &&
    steps['starter'] === 'ready' &&
    steps['starterEffect'] === 'ready' &&
    typeof steps['effect'] === 'object' &&
    (steps['effect'] as { instances: number; stopped: number; depth: string | null }).instances > 0 &&
    (steps['effect'] as { instances: number; stopped: number; depth: string | null }).stopped === 0 &&
    (steps['effect'] as { instances: number; stopped: number; depth: string | null }).depth === 'true' &&
    steps['effectOff'] === true &&
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
    Number(steps['worldEffect']) > 0 &&
    steps['hostileRefused'] === 6 &&
    steps['starterOverlay'] === 'ready' &&
    steps['overlay'] === true &&
    steps['safeMode'] === true &&
    steps['safeModeOff'] === true &&
    steps['overlayOff'] === true &&
    steps['worldOverlay'] === true &&
    steps['worldLook'] === true &&
    typeof steps['gpuReset'] === 'object' &&
    (steps['gpuReset'] as { recoveredMs: number; resets: number }).recoveredMs < 15_000 &&
    (steps['gpuReset'] as { recoveredMs: number; resets: number }).resets === 1 &&
    (steps['pageErrors'] as string[]).length === 0 &&
    // The park sends its plan, its effects and its overlay, never geometry.
    (gardenSent['chunk']?.bytes ?? Infinity) - gardenExtraBytes < 64 * 1024;
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
