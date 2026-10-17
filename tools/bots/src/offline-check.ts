// SPDX-License-Identifier: MPL-2.0
// Offline mode with the real client (S2.13): the core it is told to use cannot be reached, so it
// stays signed out; "Play offline" lists the worlds on this computer and plays one as a guest, with
// the world server running in the client's own main process. Two runs of the packaged client, each
// with a fresh profile: the park built into the app (drawn from the base library, a chat line
// answered by the world), then a world folder given with --offline-world, which the client
// converts with the host tool's converter before playing it.
//
//   node tools/bots/src/offline-check.ts -- CLIENT [--shots DIR]
//
// One JSON line: { event: 'offline-check', ok, steps } ; exit 0 when both runs passed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron, type Page } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLAZA_FOLDER = join(ROOT, 'kits', 'worlds', 'plaza');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { shots: { type: 'string' } } });
const client = positionals[0];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/offline-check.ts -- CLIENT [--shots DIR]\n');
  process.exit(2);
}

const steps: Record<string, unknown> = {};

/** One run: a fresh profile, an unreachable core, then `play` on the offline screen. */
async function visit(label: string, worldId: string, check: (page: Page) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fcoffline-'));
  const app = await electron.launch({
    executablePath: client!,
    // Port 9 (discard) on this machine: nothing answers, so the client cannot sign in.
    args: ['--core=http://127.0.0.1:9', `--offline-world=${PLAZA_FOLDER}`, ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : [])],
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
  });
  ok = Number(steps['parkParts']) > 60 && steps['chat'] === true && steps['folderWorld'] === 'The Plaza';
} catch (err) {
  steps['error'] = err instanceof Error ? err.message.split('\n')[0] : String(err);
}
process.stdout.write(`${JSON.stringify({ event: 'offline-check', ok, steps })}\n`);
process.exit(ok ? 0 : 1);
