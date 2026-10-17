// SPDX-License-Identifier: MPL-2.0
// The only bridge between the sandboxed page and the main process: one named function per channel.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('flatchat', {
  versions: {
    electron: process.versions['electron'],
    chrome: process.versions['chrome'],
    node: process.versions['node'],
  },
  signal: (url: string, offer: { type: string; sdp: string }): Promise<{ type: string; sdp: string }> => ipcRenderer.invoke('flatchat:signal', url, offer),
  smokeReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:smoke-report', report),
  benchReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:bench-report', report),
  voiceReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:voice-report', report),
  crowdReport: (report: unknown): Promise<void> => ipcRenderer.invoke('flatchat:crowd-report', report),
  crowdShot: (): Promise<void> => ipcRenderer.invoke('flatchat:crowd-shot'),
  // The app: the account lives in the main process; the page sees its state, never its tokens.
  locale: (): Promise<string> => ipcRenderer.invoke('flatchat:locale'),
  settings: (): Promise<unknown> => ipcRenderer.invoke('flatchat:settings'),
  updateSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('flatchat:settings-set', patch),
  authState: (): Promise<unknown> => ipcRenderer.invoke('flatchat:auth-state'),
  signIn: (): Promise<unknown> => ipcRenderer.invoke('flatchat:sign-in'),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('flatchat:sign-in-cancel'),
  signOut: (): Promise<unknown> => ipcRenderer.invoke('flatchat:sign-out'),
  onAuth: (listener: (state: unknown) => void): (() => void) => {
    const handler = (_event: unknown, state: unknown): void => listener(state);
    ipcRenderer.on('flatchat:auth', handler);
    return () => ipcRenderer.removeListener('flatchat:auth', handler);
  },
  worlds: (): Promise<unknown> => ipcRenderer.invoke('flatchat:worlds'),
  contentHas: (hashes: string[]): Promise<string[]> => ipcRenderer.invoke('flatchat:content-has', hashes),
  contentGet: (hash: string): Promise<Uint8Array | undefined> => ipcRenderer.invoke('flatchat:content-get', hash),
  contentPut: (hash: string, bytes: Uint8Array): Promise<boolean> => ipcRenderer.invoke('flatchat:content-put', hash, bytes),
  joinWorld: (worldId: string): Promise<unknown> => ipcRenderer.invoke('flatchat:join', worldId),
});
