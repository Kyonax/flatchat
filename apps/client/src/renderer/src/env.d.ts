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
  joinWorld(worldId: string): Promise<FlatchatResult<{ token: Uint8Array; address: string; expiresAt: number }>>;
}

interface Window {
  flatchat?: FlatchatBridge;
}
