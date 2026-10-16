// SPDX-License-Identifier: MPL-2.0
// The client's main process: one window with locked-down web preferences. With --smoke the
// renderer draws for a few seconds, then this process prints one JSON line (the graphics backend,
// the frame rate and Chromium's GPU status), writes it to --smoke-out=FILE if given, and quits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';

const smoke = process.argv.includes('--smoke');
const smokeOut = process.argv.find((a) => a.startsWith('--smoke-out='))?.slice('--smoke-out='.length);
const SMOKE_TIMEOUT_MS = 30_000;

function finishSmoke(report: Record<string, unknown>, code: number): void {
  const line = JSON.stringify({ ...report, gpu: app.getGPUFeatureStatus(), platform: process.platform });
  console.log(line);
  if (smokeOut) writeFileSync(smokeOut, `${line}\n`);
  app.exit(code);
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
  const query = smoke ? '?smoke=1' : '';
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl}${query}`);
  else void win.loadFile(join(__dirname, '../renderer/index.html'), smoke ? { query: { smoke: '1' } } : {});
  return win;
}

ipcMain.handle('flatchat:smoke-report', (_event, report: Record<string, unknown>) => {
  // A scene that could not start reports backend 'none': the smoke test fails.
  if (smoke) finishSmoke({ event: 'smoke', ...report }, report['backend'] === 'none' ? 1 : 0);
});

void app.whenReady().then(() => {
  // A game window has no File/Edit menu, and the menu's Alt toggle would fight the controls.
  // Development keeps it for reload and DevTools.
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null);
  createWindow();
  if (smoke) setTimeout(() => finishSmoke({ event: 'smoke-timeout' }, 1), SMOKE_TIMEOUT_MS);
});

app.on('window-all-closed', () => app.quit());
