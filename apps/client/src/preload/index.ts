// SPDX-License-Identifier: MPL-2.0
// The only bridge between the sandboxed page and the main process.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('flatchat', {
  versions: {
    electron: process.versions['electron'],
    chrome: process.versions['chrome'],
    node: process.versions['node'],
  },
  smokeReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:smoke-report', report),
  benchReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:bench-report', report),
});
