// SPDX-License-Identifier: MPL-2.0
/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface FlatchatAccount {
  id: string;
  displayName: string;
}

type FlatchatAuthState =
  | { status: 'signed-out'; error?: string }
  | { status: 'waiting' }
  | { status: 'signed-in'; account: FlatchatAccount; remembered: boolean };

interface FlatchatWorld {
  id: string;
  name: string;
  online: boolean;
  players: number;
  recommended: number;
  capacity: number;
}

type FlatchatResult<T> = ({ ok: true } & T) | { ok: false; error: string };

interface FlatchatBridge {
  versions: { electron: string; chrome: string; node: string };
  signal(url: string, offer: { type: string; sdp: string }): Promise<{ type: string; sdp: string }>;
  smokeReport(report: unknown): Promise<void>;
  benchReport(report: unknown): Promise<void>;
  voiceReport(report: unknown): Promise<void>;
  crowdReport(report: unknown): Promise<void>;
  crowdShot(): Promise<void>;
  locale(): Promise<string>;
  settings(): Promise<import('../../shared/settings').Settings>;
  updateSettings(patch: unknown): Promise<import('../../shared/settings').Settings>;
  authState(): Promise<FlatchatAuthState>;
  signIn(): Promise<FlatchatAuthState>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<FlatchatAuthState>;
  onAuth(listener: (state: FlatchatAuthState) => void): () => void;
  worlds(): Promise<FlatchatResult<{ worlds: FlatchatWorld[] }>>;
  world(worldId: string): Promise<FlatchatResult<{ world: FlatchatWorld }>>;
  favourites(): Promise<FlatchatResult<{ worlds: FlatchatWorld[] }>>;
  setFavourite(worldId: string, on: boolean): Promise<FlatchatResult<{ worlds: FlatchatWorld[] }>>;
  contentHas(hashes: string[]): Promise<string[]>;
  contentGet(hash: string): Promise<Uint8Array | undefined>;
  contentPut(hash: string, bytes: Uint8Array): Promise<boolean>;
  joinWorld(worldId: string): Promise<FlatchatResult<{ token: Uint8Array; address: string; expiresAt: number; iceServers: RTCIceServer[]; relayOnly: boolean }>>;
  // Reports (S3.02): one from the world view, and the account's own with their decisions.
  report(report: import('./world/report').ReportPayload): Promise<FlatchatResult<{ receipt: string }>>;
  reports(): Promise<FlatchatResult<{ reports: Array<{ receipt: string; category: string; status: string; decision: string; createdAt: string }> }>>;
  // Appeals against a world's ban (S3.07).
  appealBan(worldId: string, reason: string, text: string): Promise<FlatchatResult<object>>;
  banAppeal(worldId: string): Promise<FlatchatResult<{ appeal: { status: 'pending' | 'upheld' | 'reversed'; note: string } | null }>>;
  // Offline mode (S2.13): worlds in the client's own main process.
  offlineWorlds(): Promise<Array<{ id: string; name: string }>>;
  offlineJoin(id: string): Promise<FlatchatResult<{ token: Uint8Array; name: string }>>;
  localOpen(): Promise<boolean>;
  localSend(channel: 'reliable' | 'unreliable', bytes: Uint8Array): void;
  localClose(): Promise<void>;
  onLocal(listener: (channel: 'reliable' | 'unreliable', bytes: Uint8Array) => void): () => void;
  onLocalEnd(listener: (reason: string) => void): () => void;
}

interface Window {
  flatchat?: FlatchatBridge;
}
