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
  world: (worldId: string): Promise<unknown> => ipcRenderer.invoke('flatchat:world', worldId),
  favourites: (): Promise<unknown> => ipcRenderer.invoke('flatchat:favourites'),
  setFavourite: (worldId: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('flatchat:favourite', worldId, on),
  contentHas: (hashes: string[]): Promise<string[]> => ipcRenderer.invoke('flatchat:content-has', hashes),
  contentGet: (hash: string): Promise<Uint8Array | undefined> => ipcRenderer.invoke('flatchat:content-get', hash),
  contentPut: (hash: string, bytes: Uint8Array): Promise<boolean> => ipcRenderer.invoke('flatchat:content-put', hash, bytes),
  joinWorld: (worldId: string): Promise<unknown> => ipcRenderer.invoke('flatchat:join', worldId),
  appealBan: (worldId: string, reason: string, text: string): Promise<unknown> => ipcRenderer.invoke('flatchat:appeal-ban', worldId, reason, text),
  report: (report: unknown): Promise<unknown> => ipcRenderer.invoke('flatchat:report', report),
  mutes: (): Promise<unknown> => ipcRenderer.invoke('flatchat:mutes'),
  social: (): Promise<unknown> => ipcRenderer.invoke('flatchat:social'),
  resendVerification: (): Promise<unknown> => ipcRenderer.invoke('flatchat:resend-verification'),
  befriend: (account: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('flatchat:befriend', account, on),
  setBlock: (account: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('flatchat:set-block', account, on),
  setMute: (account: string, on: boolean): Promise<unknown> => ipcRenderer.invoke('flatchat:set-mute', account, on),
  reports: (): Promise<unknown> => ipcRenderer.invoke('flatchat:reports'),
  avatars: (): Promise<unknown> => ipcRenderer.invoke('flatchat:avatars'),
  uploadAvatar: (): Promise<unknown> => ipcRenderer.invoke('flatchat:avatars:upload'),
  wearAvatar: (id: string | null): Promise<unknown> => ipcRenderer.invoke('flatchat:avatars:wear', id),
  deleteAvatar: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:avatars:delete', id),
  avatarFile: (manifest: string, level: string): Promise<unknown> => ipcRenderer.invoke('flatchat:avatar-file', manifest, level),
  // Standard bodies, items and outfits (S5.05).
  takeKit: (kit: string): Promise<unknown> => ipcRenderer.invoke('flatchat:avatars:kit', kit),
  items: (): Promise<unknown> => ipcRenderer.invoke('flatchat:items'),
  uploadItem: (): Promise<unknown> => ipcRenderer.invoke('flatchat:items:upload'),
  deleteItem: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:items:delete', id),
  itemFile: (manifest: string, part: string): Promise<unknown> => ipcRenderer.invoke('flatchat:item-file', manifest, part),
  outfits: (): Promise<unknown> => ipcRenderer.invoke('flatchat:outfits'),
  saveOutfit: (id: string | null, name: string, items: unknown): Promise<unknown> => ipcRenderer.invoke('flatchat:outfits:save', id, name, items),
  deleteOutfit: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:outfits:delete', id),
  // Emotes and dances (S5.07).
  animations: (): Promise<unknown> => ipcRenderer.invoke('flatchat:animations'),
  uploadAnimation: (use: string, withSound: boolean): Promise<unknown> => ipcRenderer.invoke('flatchat:animations:upload', use, withSound),
  deleteAnimation: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:animations:delete', id),
  animationFile: (manifest: string, part: string): Promise<unknown> => ipcRenderer.invoke('flatchat:animation-file', manifest, part),
  // The free gallery (S5.06).
  gallery: (q: unknown): Promise<unknown> => ipcRenderer.invoke('flatchat:gallery', q),
  publish: (req: unknown): Promise<unknown> => ipcRenderer.invoke('flatchat:gallery:publish', req),
  take: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:gallery:take', id),
  withdraw: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:gallery:withdraw', id),
  banAppeal: (worldId: string): Promise<unknown> => ipcRenderer.invoke('flatchat:ban-appeal', worldId),
  // Offline mode (S2.13): a world in the main process, its messages over IPC.
  offlineWorlds: (): Promise<unknown> => ipcRenderer.invoke('flatchat:offline-worlds'),
  offlineJoin: (id: string): Promise<unknown> => ipcRenderer.invoke('flatchat:offline-join', id),
  localOpen: (): Promise<boolean> => ipcRenderer.invoke('flatchat:local-open'),
  localSend: (channel: 'reliable' | 'unreliable', bytes: Uint8Array): void => ipcRenderer.send('flatchat:local-send', channel, bytes),
  localClose: (): Promise<void> => ipcRenderer.invoke('flatchat:local-close'),
  onLocal: (listener: (channel: 'reliable' | 'unreliable', bytes: Uint8Array) => void): (() => void) => {
    const handler = (_event: unknown, channel: 'reliable' | 'unreliable', bytes: Uint8Array): void => listener(channel, bytes);
    ipcRenderer.on('flatchat:local-recv', handler);
    return () => ipcRenderer.removeListener('flatchat:local-recv', handler);
  },
  onLocalEnd: (listener: (reason: string) => void): (() => void) => {
    const handler = (_event: unknown, reason: string): void => listener(reason);
    ipcRenderer.on('flatchat:local-end', handler);
    return () => ipcRenderer.removeListener('flatchat:local-end', handler);
  },
});
