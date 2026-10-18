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
import { basename, join } from 'node:path';
import { ANIMATION_AUDIO_LIMIT, ANIMATION_SOURCE_LIMIT, ANIMATION_USES, AVATAR_SOURCE_LIMIT, BODY_KITS, checkAnimationManifest, checkItemManifest, checkManifest, ITEM_SOURCE_LIMIT, LEVELS, LicenceError, MODEL_EXTENSIONS, readLicence, uploadFormat } from '@flatchat/content';
import { app, BrowserWindow, dialog, ipcMain, Menu, type ProcessMetric, safeStorage, session, shell } from 'electron';
import { Auth, type TokenStore } from './auth';
import { registerAvatarScheme, serveAvatars } from './avatar-protocol';
import { runCensus } from './census/probe';
import { ContentCache } from './content-cache';
import { cleanWorn, CoreApi, coreBase, CoreError, STARTER_ID } from './core-api';
import { DEFAULT_CORE } from './core-url';
import { crowdPass } from './crowd-pass';
import { exitCodeFor, parseFlags, rendererQuery } from './flags';
import { declaresItself, modelName, type NeedsDeclaration, PendingItems } from './item-files';
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

// Friends and blocks (S3.10, S3.11), and whether this account is a minor (its own defaults).
ipcMain.handle('flatchat:social', async () => {
  try {
    if (!auth) return { ok: false, error: 'signed-out' };
    const [standing, friends, blocks] = await Promise.all([auth.standing(), auth.friends(), auth.blocks()]);
    return { ok: true, ...standing, ...friends, blocks };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:resend-verification', async () => {
  try {
    return { ok: true, sent: (await auth?.resendVerification()) ?? false };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:befriend', async (_event, account: unknown, on: unknown) => {
  if (typeof account !== 'string' || typeof on !== 'boolean' || !auth) return { ok: false, error: 'bad-request' };
  try {
    if (!on) {
      await auth.unfriend(account);
      return { ok: true, status: 'removed' };
    }
    return { ok: true, status: await auth.befriend(account) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:set-block', async (_event, account: unknown, on: unknown) => {
  if (typeof account !== 'string' || typeof on !== 'boolean' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.setBlock(account, on);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});

// Personal mutes (S3.08): kept by the core, so they follow the account into every world.
ipcMain.handle('flatchat:mutes', async () => {
  try {
    return { ok: true, accounts: (await auth?.mutes()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:set-mute', async (_event, account: unknown, on: unknown) => {
  if (typeof account !== 'string' || typeof on !== 'boolean' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.setMute(account, on);
    return { ok: true };
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

// Avatars (S4.01): the account's own, an upload (a file the person picks, read and sent by this
// process: the page never sees the file or the token), wearing and deleting; and a worn avatar's
// files through the content cache (S4.04), each checked against its name.
ipcMain.handle('flatchat:avatars', async () => {
  try {
    return { ok: true, avatars: (await auth?.avatars()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:avatars:upload', async (event) => {
  if (!auth) return { ok: false, error: 'signed-out' };
  const window = BrowserWindow.fromWebContents(event.sender);
  // The end-to-end test's file, in place of a dialog it cannot click (S4.12).
  const e2e = process.env['FLATCHAT_E2E_AVATAR'];
  const picked = e2e
    ? { canceled: false, filePaths: [e2e] }
    : await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0]!, { title: 'Upload an avatar', filters: [{ name: 'Avatars (VRM, GLB, FBX, OBJ, DAE, .blend)', extensions: [...MODEL_EXTENSIONS] }], properties: ['openFile'] });
  const path = picked.canceled ? undefined : picked.filePaths[0];
  if (!path) return { ok: false, error: 'cancelled' };
  try {
    if (statSync(path).size > AVATAR_SOURCE_LIMIT) return { ok: false, error: 'too-large' };
    const bytes = new Uint8Array(readFileSync(path));
    return { ok: true, id: await auth.uploadAvatar(modelName(path), bytes) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:avatars:wear', async (_event, id: unknown) => {
  if ((id !== null && typeof id !== 'string') || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.wearAvatar(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:avatars:delete', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.deleteAvatar(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});

/** Delivery answers (manifest and signed links) for 50 minutes: the links last an hour. */
const deliveries = new Map<string, { at: number; d: Promise<{ manifest: unknown; links: Record<string, string>; kit?: string }> }>();
const downloads = new Map<string, Promise<Uint8Array>>();
ipcMain.handle('flatchat:avatar-file', async (_event, manifest: unknown, level: unknown) => {
  if (typeof manifest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest) || !auth || !cache) return { ok: false, error: 'bad-request' };
  if (level !== 'manifest' && level !== 'thumbnail' && !(LEVELS as readonly unknown[]).includes(level)) return { ok: false, error: 'bad-request' };
  try {
    let entry = deliveries.get(manifest);
    if (!entry || Date.now() - entry.at > 50 * 60_000) {
      entry = { at: Date.now(), d: auth.avatarFiles(manifest) };
      deliveries.set(manifest, entry);
      entry.d.catch(() => deliveries.delete(manifest));
    }
    const d = await entry.d;
    const m = checkManifest(d.manifest);
    const hash = level === 'manifest' ? manifest : level === 'thumbnail' ? m.thumbnail : m.levels[level as (typeof LEVELS)[number]].file;
    const link = d.links[level as string];
    if (!hash || !link) return { ok: false, error: 'not-found' };
    const bytes = await cachedFile(hash, link);
    return { ok: true, manifest: m, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ...(d.kit ? { kit: d.kit } : {}) };
  } catch (err) {
    return failure(err);
  }
});

/** A file through a delivery's link, from the content cache when it holds it, each fetched once
 *  at a time and checked against its name. */
async function cachedFile(hash: string, link: string): Promise<Uint8Array> {
  const fetchOne = async (): Promise<Uint8Array> => {
    const hit = cache!.get(hash);
    if (hit) return hit;
    const bytes = await auth!.file(link);
    if (!cache!.put(hash, bytes)) throw new CoreError(502, 'bad-file', 'the file is not the one asked for');
    return bytes;
  };
  let job = downloads.get(hash);
  if (!job) {
    job = fetchOne().finally(() => downloads.delete(hash));
    downloads.set(hash, job);
  }
  return job;
}

// Standard bodies, items and outfits (S5.05): a body taken with no upload, an item uploaded the way
// an avatar is (the file the person picks, read and sent by this process), the account's saved
// outfits, and a worn item's files (a fit for a body, or a prop) through the content cache.
ipcMain.handle('flatchat:avatars:kit', async (_event, kit: unknown) => {
  if (typeof kit !== 'string' || !(BODY_KITS as readonly string[]).includes(kit) || !auth) return { ok: false, error: 'bad-request' };
  try {
    return { ok: true, ...(await auth.takeKit(kit as (typeof BODY_KITS)[number])) };
  } catch (err) {
    return failure(err);
  }
});
// The starter wardrobe (P.08): one of its items taken, with no upload, as a standard body is.
ipcMain.handle('flatchat:items:starter', async (_event, starter: unknown) => {
  if (typeof starter !== 'string' || !STARTER_ID.test(starter) || !auth) return { ok: false, error: 'bad-request' };
  try {
    return { ok: true, ...(await auth.takeStarter(starter)) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:items', async () => {
  try {
    return { ok: true, items: (await auth?.items()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
// An item's file that cannot say what it is (an FBX, OBJ or DAE, S5.08) waits for the declaration
// the page asks for, then goes with it.
const pendingItems = new PendingItems();
ipcMain.handle('flatchat:items:upload', async (event, given: unknown) => {
  if (!auth) return { ok: false, error: 'signed-out' };
  if (given !== undefined) {
    const g = (typeof given === 'object' && given !== null ? given : {}) as { token?: unknown; declaration?: unknown };
    const path = pendingItems.take(g.token);
    if (!path) return { ok: false, error: 'expired' };
    try {
      return { ok: true, id: await auth.uploadItem(modelName(path), new Uint8Array(readFileSync(path)), g.declaration) };
    } catch (err) {
      return failure(err);
    }
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  // The end-to-end test's file, in place of a dialog it cannot click.
  const e2e = process.env['FLATCHAT_E2E_ITEM'];
  const picked = e2e
    ? { canceled: false, filePaths: [e2e] }
    : await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0]!, { title: 'Upload an item', filters: [{ name: 'Items (GLB, FBX, OBJ, DAE, .blend)', extensions: MODEL_EXTENSIONS.filter((e) => e !== 'vrm') }], properties: ['openFile'] });
  const path = picked.canceled ? undefined : picked.filePaths[0];
  if (!path) return { ok: false, error: 'cancelled' };
  try {
    if (statSync(path).size > ITEM_SOURCE_LIMIT) return { ok: false, error: 'too-large' };
    const bytes = new Uint8Array(readFileSync(path));
    if (!declaresItself(bytes)) {
      const waiting = pendingItems.add(path);
      return { ok: false, error: 'needs-declaration', token: waiting, name: modelName(path), format: uploadFormat(bytes) } satisfies NeedsDeclaration;
    }
    return { ok: true, id: await auth.uploadItem(modelName(path), bytes) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:items:delete', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.deleteItem(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});
const itemDeliveries = new Map<string, { at: number; d: Promise<{ manifest: unknown; links: Record<string, string> }> }>();
ipcMain.handle('flatchat:item-file', async (_event, manifest: unknown, part: unknown) => {
  if (typeof manifest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest) || !auth || !cache) return { ok: false, error: 'bad-request' };
  if (part !== 'manifest' && part !== 'prop' && !(BODY_KITS as readonly unknown[]).includes(part)) return { ok: false, error: 'bad-request' };
  try {
    let entry = itemDeliveries.get(manifest);
    if (!entry || Date.now() - entry.at > 50 * 60_000) {
      entry = { at: Date.now(), d: auth.itemFiles(manifest) };
      itemDeliveries.set(manifest, entry);
      entry.d.catch(() => itemDeliveries.delete(manifest));
    }
    const d = await entry.d;
    const m = checkItemManifest(d.manifest);
    if (part === 'manifest') return { ok: true, manifest: m };
    const hash = part === 'prop' ? m.prop?.file : m.fits[part as (typeof BODY_KITS)[number]]?.file;
    const link = d.links[part as string];
    if (!hash || !link) return { ok: false, error: 'not-found' };
    const bytes = await cachedFile(hash, link);
    return { ok: true, manifest: m, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:outfits', async () => {
  try {
    return { ok: true, outfits: (await auth?.outfits()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:outfits:save', async (_event, id: unknown, name: unknown, items: unknown) => {
  if ((id !== null && typeof id !== 'string') || typeof name !== 'string' || !name.trim() || !auth) return { ok: false, error: 'bad-request' };
  try {
    return { ok: true, outfit: await auth.saveOutfit(id, { name, items: cleanWorn(items) }) };
  } catch (err) {
    return failure(err);
  }
});
// Emotes and dances (S5.07): the account's own, an upload (a VRMA, GLB, BVH or FBX the person
// picks, read and sent by this process, with its use: an emote or a dance), deleting, and a ready
// animation's VRMA through the content cache.
ipcMain.handle('flatchat:animations', async () => {
  try {
    return { ok: true, animations: (await auth?.animations()) ?? [] };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:animations:upload', async (event, use: unknown, withSound: unknown) => {
  if (!auth || !(ANIMATION_USES as readonly unknown[]).includes(use)) return { ok: false, error: 'bad-request' };
  const window = BrowserWindow.fromWebContents(event.sender);
  // The end-to-end test's file, in place of a dialog it cannot click.
  const e2e = process.env['FLATCHAT_E2E_ANIMATION'];
  const picked = e2e
    ? { canceled: false, filePaths: [e2e] }
    : await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0]!, { title: 'Upload an emote or a dance', filters: [{ name: 'Animations (VRMA, GLB, BVH, FBX)', extensions: ['vrma', 'glb', 'bvh', 'fbx'] }], properties: ['openFile'] });
  const path = picked.canceled ? undefined : picked.filePaths[0];
  if (!path) return { ok: false, error: 'cancelled' };
  // Its sound, when asked for (S5.07): a WAV or an Ogg.
  let soundPath: string | undefined;
  if (withSound === true) {
    const e2eSound = process.env['FLATCHAT_E2E_AUDIO'];
    const s = e2eSound
      ? { canceled: false, filePaths: [e2eSound] }
      : await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0]!, { title: 'Its sound', filters: [{ name: 'Sounds (WAV, Ogg)', extensions: ['wav', 'ogg'] }], properties: ['openFile'] });
    soundPath = s.canceled ? undefined : s.filePaths[0];
    if (!soundPath) return { ok: false, error: 'cancelled' };
  }
  try {
    if (statSync(path).size > ANIMATION_SOURCE_LIMIT || (soundPath && statSync(soundPath).size > ANIMATION_AUDIO_LIMIT)) return { ok: false, error: 'too-large' };
    const bytes = new Uint8Array(readFileSync(path));
    const sound = soundPath ? new Uint8Array(readFileSync(soundPath)) : undefined;
    return { ok: true, id: await auth.uploadAnimation(basename(path).replace(/\.(vrma|glb|bvh|fbx)$/i, ''), bytes, use as (typeof ANIMATION_USES)[number], sound) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:animations:delete', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.deleteAnimation(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});
const animationDeliveries = new Map<string, { at: number; d: Promise<{ manifest: unknown; links: Record<string, string> }> }>();
ipcMain.handle('flatchat:animation-file', async (_event, manifest: unknown, part: unknown = 'vrma') => {
  if (typeof manifest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest) || (part !== 'vrma' && part !== 'audio') || !auth || !cache) return { ok: false, error: 'bad-request' };
  try {
    let entry = animationDeliveries.get(manifest);
    if (!entry || Date.now() - entry.at > 50 * 60_000) {
      entry = { at: Date.now(), d: auth.animationFiles(manifest) };
      animationDeliveries.set(manifest, entry);
      entry.d.catch(() => animationDeliveries.delete(manifest));
    }
    const d = await entry.d;
    const m = checkAnimationManifest(d.manifest);
    const hash = part === 'audio' ? m.audio?.file : m.file;
    const link = d.links[part];
    if (!hash || !link) return { ok: false, error: 'not-found' };
    const bytes = await cachedFile(hash, link);
    return { ok: true, manifest: m, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  } catch (err) {
    return failure(err);
  }
});

// The free gallery (S5.06): browsing, publishing one of the account's own under a licence,
// taking an entry (the account's own copy), withdrawing one.
ipcMain.handle('flatchat:gallery', async (_event, q: unknown) => {
  if (!auth) return { ok: false, error: 'signed-out' };
  const v = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
  const s = (k: string): string | undefined => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  try {
    const query: { kind?: string; slot?: string; body?: string; q?: string; before?: string } = {};
    for (const k of ['kind', 'slot', 'body', 'q', 'before'] as const) {
      const x = s(k);
      if (x) query[k] = x;
    }
    return { ok: true, ...(await auth.gallery(query)) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:gallery:publish', async (_event, req: unknown) => {
  const v = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>;
  if ((v['kind'] !== 'avatar' && v['kind'] !== 'item') || typeof v['id'] !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    const licence = readLicence(v['licence']);
    return { ok: true, entry: await auth.publish({ kind: v['kind'], id: v['id'], name: typeof v['name'] === 'string' ? v['name'] : '', licence, affirm: v['affirm'] === true }) };
  } catch (err) {
    return err instanceof LicenceError ? { ok: false, error: 'bad-request' } : failure(err);
  }
});
ipcMain.handle('flatchat:gallery:take', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    return { ok: true, ...(await auth.take(id)) };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:gallery:withdraw', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.withdraw(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
});
ipcMain.handle('flatchat:outfits:delete', async (_event, id: unknown) => {
  if (typeof id !== 'string' || !auth) return { ok: false, error: 'bad-request' };
  try {
    await auth.deleteOutfit(id);
    return { ok: true };
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
