// SPDX-License-Identifier: MPL-2.0
// The client's main process: one window with locked-down web preferences, and two measuring modes
// (see flags.ts). --smoke draws for a few seconds, then prints one JSON line (the graphics backend,
// the frame rate and Chromium's GPU status), writes it to --smoke-out=FILE if given, and quits.
// --bench=SECONDS draws a fixed-size frame with no frame-rate cap, writes every frame time to
// --bench-out=FILE and prints a summary line. A run that could not draw exits 1.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { exitCodeFor, parseFlags, rendererQuery } from './flags';

const { flags, errors } = parseFlags(process.argv);
if (errors.length > 0) {
  console.error(JSON.stringify({ event: 'error', errors }));
  process.exit(2);
}

const SMOKE_TIMEOUT_MS = 30_000;
const BENCH_SLACK_MS = 60_000;

if (flags.bench !== undefined) {
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
  app.exit(exitCodeFor(report));
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

ipcMain.handle('flatchat:smoke-report', (_event, report: Record<string, unknown>) => {
  if (flags.smoke) finish('smoke', report, flags.smokeOut);
});

ipcMain.handle('flatchat:bench-report', (_event, report: Record<string, unknown>) => {
  if (flags.bench !== undefined) finish('bench', report, flags.benchOut);
});

void app.whenReady().then(() => {
  // A game window has no File/Edit menu, and the menu's Alt toggle would fight the controls.
  // Development keeps it for reload and DevTools.
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null);
  createWindow();
  if (flags.smoke) setTimeout(() => finish('smoke-timeout', {}, flags.smokeOut), SMOKE_TIMEOUT_MS);
  if (flags.bench !== undefined) {
    setTimeout(() => finish('bench-timeout', {}, flags.benchOut), flags.bench * 1000 + BENCH_SLACK_MS);
  }
});

app.on('window-all-closed', () => app.quit());
