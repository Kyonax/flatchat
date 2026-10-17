// SPDX-License-Identifier: MPL-2.0
// The client's main process: one window with locked-down web preferences. With no mode flag it is
// the app: the player signs in through the system browser (auth.ts), the settings live in a file
// (settings-file.ts), and the page asks for the world list and connect tokens through the bridge;
// it never holds an account token. The measuring modes (see flags.ts): --smoke draws for a few seconds and runs the protocol's golden packets in the
// renderer, then prints one JSON line (the graphics backend, the frame rate, the protocol check and
// Chromium's GPU status), writes it to --smoke-out=FILE if given, and quits. With --join and
// --join-token it also joins that loopback world server over WebRTC (net-check.ts).
// --bench=SECONDS draws a fixed-size frame with no frame-rate cap, writes every frame time to
// --bench-out=FILE and prints a summary line. A run that could not draw, or a smoke run whose
// protocol check failed, exits 1. --crowd=SECONDS --avatars=DIR is spike S0.09's crowd bench: the
// folder's VRM avatars served read-only (avatar-files.ts), every process's memory sampled each
// second, and the report judged against the pass lines (crowd-pass.ts).
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, type ProcessMetric, safeStorage, session, shell } from 'electron';
import { Auth, type TokenStore } from './auth';
import { registerAvatarScheme, serveAvatars } from './avatar-protocol';
import { runCensus } from './census/probe';
import { ContentCache } from './content-cache';
import { CoreApi, coreBase, CoreError } from './core-api';
import { DEFAULT_CORE } from './core-url';
import { crowdPass } from './crowd-pass';
import { exitCodeFor, parseFlags, rendererQuery } from './flags';
import { listOffline, OfflineHost } from './offline';
import { SettingsFile } from './settings-file';
import { signal } from './signal';

const { flags, errors } = parseFlags(process.argv);
if (errors.length > 0) {
  console.error(JSON.stringify({ event: 'error', errors }));
  process.exit(2);
}

const SMOKE_TIMEOUT_MS = 30_000;
/** No measuring mode: the app itself. */
const isApp = !flags.smoke && flags.bench === undefined && !flags.crowd && flags.voiceTest === undefined && flags.voiceLoad === undefined && flags.lounge === undefined && !flags.census;
const BENCH_SLACK_MS = 60_000;

if (flags.crowd) registerAvatarScheme();

if (flags.bench !== undefined || flags.crowd) {
  // Measure the frame, not the display: no vsync and no 60 fps cap. Switches must be set before ready.
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

function finish(event: string, report: Record<string, unknown>, outFile: string | undefined): void {
  const full = { event, ...report, gpu: app.getGPUFeatureStatus(), platform: process.platform };
  // The bench report carries every frame time: the file gets all of it, the console a summary.
  const summary: Record<string, unknown> = { ...full };
  delete summary['frameTimesMs'];
  console.log(JSON.stringify(summary));
  if (outFile) writeFileSync(outFile, `${JSON.stringify(full)}\n`);
  const mode = flags.crowd ? 'crowd' : flags.voiceTest !== undefined || flags.voiceLoad !== undefined ? 'voice' : flags.bench !== undefined ? 'bench' : 'smoke';
  app.exit(exitCodeFor(report, mode, { join: flags.join !== undefined }));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'FlatChat',
    backgroundColor: '#101014',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const query = rendererQuery(flags);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    const search = new URLSearchParams(query).toString();
    void win.loadURL(search ? `${devUrl}?${search}` : devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }
  return win;
}

// ------------------------------------------------------------------------------- the app

let settings: SettingsFile | undefined;
let auth: Auth | undefined;
let cache: ContentCache | undefined;
/** The address the core gave with the latest connect token: signaling may go there too. */
let joinedAddress: string | undefined;

/** The refresh token, encrypted by the operating system. Linux without a secret service would fall
 *  back to a fixed key ("basic_text"), so there the session is kept in memory only. */
function tokenStore(): TokenStore {
  const file = join(app.getPath('userData'), 'session.bin');
  const durable = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  return {
    durable,
    load: () => {
      if (!durable) return undefined;
      try {
        return safeStorage.decryptString(readFileSync(file));
      } catch {
        return undefined;
      }
    },
    save: (refresh) => {
      if (!refresh || !durable) rmSync(file, { force: true });
      else writeFileSync(file, safeStorage.encryptString(refresh), { mode: 0o600 });
    },
  };
}

function startAccount(): void {
  settings = new SettingsFile(join(app.getPath('userData'), 'settings.json'));
  cache = new ContentCache(join(app.getPath('userData'), 'content'));
  const base = coreBase(flags.core ?? (settings.get().core || DEFAULT_CORE)) ?? coreBase(DEFAULT_CORE)!;
  const openSignin = (url: URL): Promise<void> =>
    // trap-lint: allow T16 because the URL is the core's own sign-in page, checked in CoreApi.loginRequest
    shell.openExternal(url.href);
  auth = new Auth(new CoreApi(base), tokenStore(), openSignin);
  auth.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('flatchat:auth', state);
  });
  void auth.restore();
}

const failure = (err: unknown): { ok: false; error: string } => ({ ok: false, error: err instanceof CoreError ? err.code : 'failed' });

ipcMain.handle('flatchat:locale', () => app.getLocale());
// World content (S2.04): the page downloads, the main process keeps what matches its hash.
ipcMain.handle('flatchat:content-has', (_event, hashes: unknown) => (Array.isArray(hashes) ? (cache?.has(hashes.slice(0, 4096)) ?? []) : []));
ipcMain.handle('flatchat:content-get', (_event, hash: unknown) => cache?.get(hash));
ipcMain.handle('flatchat:content-put', (_event, hash: unknown, bytes: unknown) => cache?.put(hash, bytes) ?? false);
ipcMain.handle('flatchat:settings', () => settings?.get());
ipcMain.handle('flatchat:settings-set', (_event, patch: unknown) => settings?.update(patch));
ipcMain.handle('flatchat:auth-state', () => auth?.state);
ipcMain.handle('flatchat:sign-in', () => auth?.signIn());
ipcMain.handle('flatchat:sign-in-cancel', () => auth?.cancel());
ipcMain.handle('flatchat:sign-out', () => auth?.signOut());
ipcMain.handle('flatchat:worlds', async () => {
  try {
    return { ok: true, worlds: (await auth?.worlds()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
// The world browser (S2.09): a world by its id, and the account's favourites.
ipcMain.handle('flatchat:world', async (_event, worldId: unknown) => {
  if (typeof worldId !== 'string' || !auth) return { ok: false, error: 'bad-world' };
  try {
    return { ok: true, world: await auth.world(worldId) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:favourites', async () => {
  try {
    return { ok: true, worlds: (await auth?.favourites()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:favourite', async (_event, worldId: unknown, on: unknown) => {
  if (typeof worldId !== 'string' || typeof on !== 'boolean' || !auth) return { ok: false, error: 'bad-world' };
  try {
    return { ok: true, worlds: await auth.setFavourite(worldId, on) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:join', async (_event, worldId: unknown) => {
  if (typeof worldId !== 'string' || !auth) return { ok: false, error: 'bad-world' };
  try {
    const ticket = await auth.join(worldId);
    joinedAddress = ticket.address;
    return { ok: true, token: ticket.token, address: ticket.address, expiresAt: ticket.expiresAt, iceServers: ticket.iceServers, relayOnly: flags.relayOnly === true };
  } catch (err) {
    return failure(err);
  }
});

// Reports (S3.02): the page builds one (with the clip, only then) and the core files it.
const REPORT_CATEGORIES = new Set(['csam', 'grooming', 'threats', 'intimate', 'underage', 'harassment', 'other']);
ipcMain.handle('flatchat:report', async (_event, raw: unknown) => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const target = (typeof r['target'] === 'object' && r['target'] !== null ? r['target'] : {}) as Record<string, unknown>;
  const clip = r['clip'];
  if (!auth || typeof r['category'] !== 'string' || !REPORT_CATEGORIES.has(r['category']) || (target['kind'] !== 'player' && target['kind'] !== 'world') || typeof r['text'] !== 'string') return { ok: false, error: 'bad-request' };
  if (clip !== undefined && (!(clip instanceof Uint8Array) || clip.length > 700 * 1024)) return { ok: false, error: 'bad-clip' };
  try {
    const receipt = await auth.report({
      category: r['category'],
      target: { kind: target['kind'], ...(typeof target['account'] === 'string' ? { account: target['account'] } : {}), ...(typeof target['world'] === 'string' ? { world: target['world'] } : {}), ref: typeof target['ref'] === 'string' ? target['ref'].slice(0, 300) : '' },
      text: r['text'].slice(0, 2000),
      evidence: r['evidence'],
      ...(clip instanceof Uint8Array ? { clip } : {}),
    });
    return { ok: true, receipt };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:reports', async () => {
  try {
    return { ok: true, reports: (await auth?.reports()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});

// Appeals against a world's ban (S3.07): to the world's owner, through the core.
ipcMain.handle('flatchat:appeal-ban', async (_event, worldId: unknown, reason: unknown, text: unknown) => {
  if (typeof worldId !== 'string' || typeof reason !== 'string' || typeof text !== 'string' || !text.trim() || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.appealBan(worldId, reason, text);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:ban-appeal', async (_event, worldId: unknown) => {
  if (typeof worldId !== 'string' || !auth) return { ok: false, error: 'bad-world' };
  try {
    return { ok: true, appeal: (await auth.banAppeal(worldId)) ?? null };
  } catch (err) {
    return failure(err);
  }
});

// Offline mode (S2.13): the built-in worlds sit beside the app (extraResources), or in out/ while
// developing; folders given with --offline-world are converted into the app's data folder.
let offline: OfflineHost | undefined;
const offlineKits = (): string => (app.isPackaged ? join(process.resourcesPath, 'offline') : join(__dirname, '..', 'offline'));
ipcMain.handle('flatchat:offline-worlds', () => listOffline(offlineKits(), flags.offlineWorlds));
ipcMain.handle('flatchat:offline-join', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !/^(kit:[a-z0-9-]{1,40}|folder:\d{1,2})$/.test(id)) return { ok: false, error: 'bad-world' };
  offline ??= new OfflineHost(offlineKits(), flags.offlineWorlds, join(app.getPath('userData'), 'offline'));
  try {
    const r = await offline.start(id);
    return { ok: true, token: r.token, name: r.name };
  } catch (err) {
    return { ok: false, error: 'failed', detail: err instanceof Error ? err.message.slice(0, 160) : '' };
  }
});
ipcMain.handle('flatchat:local-open', (event) => {
  if (!offline) return false;
  const page = event.sender;
  offline.open(
    (channel, bytes) => {
      if (!page.isDestroyed()) page.send('flatchat:local-recv', channel, bytes);
    },
    (reason) => {
      if (!page.isDestroyed()) page.send('flatchat:local-end', reason);
    },
  );
  return true;
});
ipcMain.on('flatchat:local-send', (_event, channel: unknown, bytes: unknown) => {
  if ((channel === 'reliable' || channel === 'unreliable') && bytes instanceof Uint8Array && bytes.length <= 65_536) offline?.receive(channel, bytes);
});
ipcMain.handle('flatchat:local-close', async () => {
  await offline?.stop();
});

ipcMain.handle('flatchat:signal', async (_event, url: unknown, offer: unknown) => {
  // A world hosted from home takes its offers through the core, with the account's token (S1.13).
  if (auth && typeof url === 'string' && url === joinedAddress && auth.isRelay(url)) {
    const o = offer as { type?: unknown; sdp?: unknown } | null;
    if (!o || o.type !== 'offer' || typeof o.sdp !== 'string' || o.sdp.length > 64 * 1024) throw new Error('not an offer');
    return auth.relaySignal(url, { type: 'offer', sdp: o.sdp });
  }
  return signal(url, offer, joinedAddress);
});

ipcMain.handle('flatchat:smoke-report', (_event, report: Record<string, unknown>) => {
  if (flags.smoke) finish('smoke', report, flags.smokeOut);
});

ipcMain.handle('flatchat:bench-report', (_event, report: Record<string, unknown>) => {
  if (flags.bench !== undefined) finish('bench', report, flags.benchOut);
});

// The voice load test's CPU: every second, each process's share of one core since the last sample.
const cpuSamples: Record<string, number[]> = {};
function sampleCpu(metrics: ProcessMetric[]): void {
  for (const m of metrics) {
    const name = m.type === 'Utility' ? (m.serviceName ?? 'utility') : m.type;
    (cpuSamples[name] ??= []).push(m.cpu.percentCPUUsage);
  }
}

ipcMain.handle('flatchat:voice-report', (_event, report: Record<string, unknown>) => {
  if (flags.voiceTest !== undefined) finish('voice', report, flags.voiceOut);
  if (flags.voiceLoad !== undefined) {
    // The first sample of each process reads 0 (no earlier sample), so it is dropped.
    const cpu = Object.fromEntries(Object.entries(cpuSamples).map(([k, v]) => [k, Math.round((v.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, v.length - 1)) * 10) / 10]));
    finish('voice-load', { ...report, cpuPercentOfOneCore: cpu }, flags.voiceOut);
  }
});

// The crowd bench's memory: every second, the resident memory of each FlatChat process and of all together.
const memory = { samples: 0, peakTotalMB: 0, endTotalMB: 0, peakByProcessMB: {} as Record<string, number> };
function sampleMemory(): void {
  let total = 0;
  for (const m of app.getAppMetrics()) {
    const name = m.type === 'Utility' ? (m.serviceName ?? 'utility') : m.type;
    const mb = (m.memory.workingSetSize ?? 0) / 1024;
    total += mb;
    memory.peakByProcessMB[name] = Math.max(memory.peakByProcessMB[name] ?? 0, Math.round(mb));
  }
  memory.samples += 1;
  memory.endTotalMB = Math.round(total);
  memory.peakTotalMB = Math.max(memory.peakTotalMB, Math.round(total));
}

ipcMain.handle('flatchat:crowd-shot', async (event) => {
  const file = flags.crowd?.shot;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!file || !win) return;
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
});

ipcMain.handle('flatchat:crowd-report', (_event, report: Record<string, unknown>) => {
  if (!flags.crowd) return;
  sampleMemory();
  finish('crowd', { ...report, memory, pass: crowdPass(report, memory.peakTotalMB, flags.crowd.headroom), headroom: flags.crowd.headroom }, flags.crowd.out);
});

/** Spike S0.10: the network census and the GPU, printed as one JSON line, then quit. */
async function census(): Promise<void> {
  const report = await runCensus();
  const gpu = (await app.getGPUInfo('complete')) as { gpuDevice?: Array<{ active?: boolean; vendorId?: number; deviceId?: number }>; auxAttributes?: { glRenderer?: string } };
  const active = gpu.gpuDevice?.find((d) => d.active) ?? gpu.gpuDevice?.[0];
  const line = { event: 'census', ...report, gpu: { renderer: gpu.auxAttributes?.glRenderer, vendorId: active?.vendorId, deviceId: active?.deviceId } };
  console.log(JSON.stringify(line));
  if (flags.censusOut) writeFileSync(flags.censusOut, `${JSON.stringify(line)}\n`);
  app.exit(0);
}

// Electron grants every permission a page asks for unless told otherwise. FlatChat's page gets only
// what it needs: the microphone (never the camera), in the app and the voice lounge (S0.08), and
// pointer lock for mouse look; everything else is refused.
function lockPermissions(): void {
  const voice = isApp || flags.lounge !== undefined;
  const allowed = (permission: string, mediaTypes?: readonly string[]): boolean =>
    (voice && permission === 'media' && (mediaTypes ?? []).every((t) => t === 'audio')) || (isApp && permission === 'pointerLock');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed(permission, (details as { mediaTypes?: string[] }).mediaTypes));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => (voice && permission === 'media') || (isApp && permission === 'pointerLock'));
}

void app.whenReady().then(() => {
  lockPermissions();
  if (flags.census) {
    void census();
    return;
  }
  // A game window has no File/Edit menu, and the menu's Alt toggle would fight the controls.
  // Development keeps it for reload and DevTools.
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null);
  // The crowd's avatar folder is served before the page that asks for it exists.
  if (flags.crowd) {
    const dir = flags.crowd.avatars;
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a folder');
      if (serveAvatars(dir).length === 0) throw new Error('no .vrm files');
    } catch (err) {
      finish('crowd', { backend: 'none', error: `--avatars=${dir}: ${err instanceof Error ? err.message : String(err)}` }, flags.crowd.out);
      return;
    }
    setInterval(sampleMemory, 1000);
    // Loading dozens of avatars on a slow machine takes minutes before the measured run starts.
    setTimeout(() => finish('crowd-timeout', { error: 'timed out' }, flags.crowd?.out), flags.crowd.seconds * 1000 + 600_000);
  }
  if (isApp) startAccount();
  createWindow();
  if (flags.smoke) setTimeout(() => finish('smoke-timeout', {}, flags.smokeOut), SMOKE_TIMEOUT_MS);
  if (flags.bench !== undefined) {
    setTimeout(() => finish('bench-timeout', {}, flags.benchOut), flags.bench * 1000 + BENCH_SLACK_MS);
  }
  if (flags.voiceTest !== undefined) setTimeout(() => finish('voice-timeout', {}, flags.voiceOut), flags.voiceTest * 1000 + BENCH_SLACK_MS);
  if (flags.voiceLoad !== undefined) {
    setInterval(() => sampleCpu(app.getAppMetrics()), 1000);
    setTimeout(() => finish('voice-timeout', {}, flags.voiceOut), flags.voiceLoad * 1000 + BENCH_SLACK_MS);
  }
});

app.on('window-all-closed', () => app.quit());
