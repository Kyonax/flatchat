// SPDX-License-Identifier: MPL-2.0
// The client's main process: one window with locked-down web preferences, and two measuring modes
// (see flags.ts). --smoke draws for a few seconds and runs the protocol's golden packets in the
// renderer, then prints one JSON line (the graphics backend, the frame rate, the protocol check and
// Chromium's GPU status), writes it to --smoke-out=FILE if given, and quits. With --join and
// --join-token it also joins that loopback world server over WebRTC (net-check.ts).
// --bench=SECONDS draws a fixed-size frame with no frame-rate cap, writes every frame time to
// --bench-out=FILE and prints a summary line. A run that could not draw, or a smoke run whose
// protocol check failed, exits 1. --crowd=SECONDS --avatars=DIR is spike S0.09's crowd bench: the
// folder's VRM avatars served read-only (avatar-files.ts), every process's memory sampled each
// second, and the report judged against the pass lines (crowd-pass.ts).
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, type ProcessMetric, session } from 'electron';
import { registerAvatarScheme, serveAvatars } from './avatar-protocol';
import { runCensus } from './census/probe';
import { crowdPass } from './crowd-pass';
import { exitCodeFor, parseFlags, rendererQuery } from './flags';
import { signal } from './signal';

const { flags, errors } = parseFlags(process.argv);
if (errors.length > 0) {
  console.error(JSON.stringify({ event: 'error', errors }));
  process.exit(2);
}

const SMOKE_TIMEOUT_MS = 30_000;
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

ipcMain.handle('flatchat:signal', (_event, url: unknown, offer: unknown) => signal(url, offer));

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
// what it needs: the microphone, and only in the voice lounge (S0.08); everything else is refused.
function lockPermissions(): void {
  const allowed = (permission: string, mediaTypes?: readonly string[]): boolean =>
    flags.lounge !== undefined && permission === 'media' && (mediaTypes ?? []).every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed(permission, (details as { mediaTypes?: string[] }).mediaTypes));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => flags.lounge !== undefined && permission === 'media');
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
