// SPDX-License-Identifier: MPL-2.0
// Offline mode with the real client (S2.13): the core it is told to use cannot be reached, so it
// stays signed out; "Play offline" lists the worlds on this computer and plays one as a guest, with
// the world server running in the client's own main process. Three runs of the packaged client, each
// with a fresh profile: the park built into the app (drawn from the base library, a chat line
// answered by the world), then a world folder given with --offline-world, which the client
// converts with the host tool's converter before playing it: make-travel's second world, the park
// with Effekseer's tornado (S6.01) and a screen overlay (S6.02), so the conversion dry-runs an
// effect in the client's own bundled worker, and the world view measures and plays it and shows
// the overlay; then the owner's hangout (S7.03), built in: the bay and its lounge, its hum in the
// hall's echo, its look, and a frame's draws from the stats panel.
//
//   node tools/bots/src/offline-check.ts -- CLIENT [--shots DIR]
//
// One JSON line: { event: 'offline-check', ok, steps } ; exit 0 when both runs passed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron, type Page } from 'playwright-core';
import { headless } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { shots: { type: 'string' } } });
const client = positionals[0];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/offline-check.ts -- CLIENT [--shots DIR]\n');
  process.exit(2);
}

const steps: Record<string, unknown> = {};
const worlds = mkdtempSync(join(tmpdir(), 'fcoffline-worlds-'));
execFileSync(process.execPath, [MAKE_TRAVEL, worlds, '--worlds', `${randomUUID()},${randomUUID()}`, '--names', 'Offline Plaza,Offline Garden', '--kits', 'plaza,park', '--effect', '--overlay'], { stdio: 'ignore' });
const FOLDER = join(worlds, 'b');

/** One run: a fresh profile, an unreachable core, then `play` on the offline screen. */
async function visit(label: string, worldId: string, check: (page: Page) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fcoffline-'));
  const app = await electron.launch({
    executablePath: client!,
    // Port 9 (discard) on this machine: nothing answers, so the client cannot sign in.
    // At a fixed preset with the tuner off (S6.08): what is drawn does not depend on the runner's speed.
    args: ['--core=http://127.0.0.1:9', `--offline-world=${FOLDER}`, '--quality=high', ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []), ...headless()],
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), APPDATA: join(dir, 'config') },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-test=offline]').click({ timeout: 30_000 });
    await page.locator(`[data-test=offline-worlds] [data-world="${worldId}"] [data-test=play]`).click({ timeout: 20_000 });
    await page.locator('[data-test=players][data-players="1"]').waitFor({ timeout: 60_000 });
    await check(page);
    if (values.shots) await page.screenshot({ path: join(values.shots, `offline-${label}.png`) });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

let ok = false;
try {
  await visit('park', 'kit:park', async (page) => {
    steps['parkParts'] = await page.locator('[data-test=sounds]').getAttribute('data-parts', { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.locator('[data-test=chat-input]').fill('hola sin conexión');
    await page.keyboard.press('Enter');
    await page.locator('[data-test=chat-line]', { hasText: 'Guest: hola sin conexión' }).waitFor({ timeout: 10_000 });
    steps['chat'] = true;
  });
  await visit('folder', 'folder:0', async (page) => {
    steps['folderWorld'] = await page.locator('.whud.top strong').textContent({ timeout: 10_000 });
    steps['folderEffect'] = await page
      .locator('[data-test=effects][data-world="1"]')
      .waitFor({ state: 'attached', timeout: 60_000 })
      .then(async () => Number(await page.locator('[data-test=effects]').getAttribute('data-instances')))
      .catch(async () => `refused ${await page.locator('[data-test=effects]').getAttribute('data-refused').catch(() => '?')}`);
    // Its screen overlay (S6.02), converted with the folder like everything else.
    steps['folderOverlay'] = await page
      .locator('[data-test=overlays][data-world="1"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
  });
  // The owner's hangout (S7.03), built in like every kit: the bay and its lounge, its hum in the
  // hall's echo where the deck's arrivals stand, its look, and what a frame there draws.
  await visit('hangout', 'kit:hangout', async (page) => {
    steps['hangoutWorld'] = await page.locator('.whud.top strong').textContent({ timeout: 10_000 });
    steps['hangoutParts'] = Number(await page.locator('[data-test=sounds]').getAttribute('data-parts', { timeout: 10_000 }));
    steps['hangoutSound'] = await page
      .locator('[data-test=sounds][data-playing="1"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    steps['hangoutHall'] = await page
      .locator('[data-test=audio][data-room="hall"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    steps['hangoutLook'] = await page
      .locator('[data-test=look][data-bloom="1"]')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press('F3');
    steps['hangoutFrame'] = await page
      .locator('[data-test=stats]:not([data-draws="0"])')
      .waitFor({ timeout: 10_000 })
      .then(async () => ({ draws: Number(await page.locator('[data-test=stats]').getAttribute('data-draws')) }))
      .catch(() => ({ draws: 0 }));
  });
  ok =
    Number(steps['parkParts']) > 60 &&
    steps['chat'] === true &&
    steps['folderWorld'] === 'Offline Garden' &&
    Number(steps['folderEffect']) > 0 &&
    steps['folderOverlay'] === true &&
    steps['hangoutWorld'] === 'The Hangout' &&
    Number(steps['hangoutParts']) >= 35 &&
    steps['hangoutSound'] === true &&
    steps['hangoutHall'] === true &&
    steps['hangoutLook'] === true &&
    (steps['hangoutFrame'] as { draws: number }).draws > 0;
} catch (err) {
  steps['error'] = err instanceof Error ? err.message.split('\n')[0] : String(err);
}
rmSync(worlds, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ event: 'offline-check', ok, steps })}\n`);
process.exit(ok ? 0 : 1);
