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

/** What an item's file cannot say itself (S5.08): packages/content's ItemDeclaration. */
interface FlatchatItemDeclaration {
  name: string;
  slot: string;
  hides: string[];
  authors: string[];
  attach?: string;
}

/** One of the account's avatars (S4.01). */
interface FlatchatAvatar {
  id: string;
  name: string;
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed' | 'removed';
  rank: string | null;
  problems: string[];
  manifest: string | null;
  createdAt: string;
  wearing: boolean;
  /** The standard body it is (S5.05). */
  kit: import('@flatchat/content').BodyKit | null;
  /** Its gallery entry when published, or the entry it was taken from (S5.06). */
  published: string | null;
  fromGallery: string | null;
}

/** One of the account's items (S5.05). */
interface FlatchatItem {
  id: string;
  name: string;
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed' | 'removed';
  slot: import('@flatchat/content').Slot | null;
  fits: Array<import('@flatchat/content').BodyKit>;
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: string;
  published: string | null;
  fromGallery: string | null;
  /** The starter wardrobe's id for it, when it is one (P.08). */
  starter: string | null;
}

/** One of the account's emotes and dances (S5.07). */
interface FlatchatAnimation {
  id: string;
  name: string;
  use: 'emote' | 'dance';
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed';
  source: string;
  sound: boolean;
  mouth: boolean;
  duration: number | null;
  loop: boolean;
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: string;
}

/** One entry of the free gallery (S5.06). */
interface FlatchatGalleryEntry {
  id: string;
  kind: 'avatar' | 'item';
  name: string;
  authors: string[];
  licence: import('@flatchat/content').Licence;
  slot: import('@flatchat/content').Slot | null;
  fits: Array<import('@flatchat/content').BodyKit>;
  rank: string | null;
  takes: number;
  publishedAt: string;
  publisher: string;
  manifest: string;
  mine: boolean;
  taken: boolean;
}

/** A worn item: its manifest's SHA-256, and a prop's adjustment (cm, degrees, percent). */
interface FlatchatWorn {
  item: string;
  adjust?: import('@flatchat/content').WornAdjust;
}

interface FlatchatOutfit {
  id: string;
  name: string;
  items: FlatchatWorn[];
  updatedAt: string;
}

interface FlatchatPerson {
  account: string;
  name: string;
}

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
  // Friends and blocks (S3.10, S3.11), and whether this account is a minor.
  social(): Promise<FlatchatResult<{ under18: boolean; verified: boolean; supervision: string; friends: FlatchatPerson[]; incoming: FlatchatPerson[]; outgoing: FlatchatPerson[]; blocks: string[] }>>;
  resendVerification(): Promise<FlatchatResult<{ sent: boolean }>>;
  befriend(account: string, on: boolean): Promise<FlatchatResult<{ status: string }>>;
  setBlock(account: string, on: boolean): Promise<FlatchatResult<object>>;
  // Personal mutes (S3.08): the accounts this player does not hear, in every world.
  mutes(): Promise<FlatchatResult<{ accounts: string[] }>>;
  setMute(account: string, on: boolean): Promise<FlatchatResult<object>>;
  // Reports (S3.02): one from the world view, and the account's own with their decisions.
  report(report: import('./world/report').ReportPayload): Promise<FlatchatResult<{ receipt: string }>>;
  reports(): Promise<FlatchatResult<{ reports: Array<{ receipt: string; category: string; status: string; decision: string; createdAt: string }> }>>;
  avatars(): Promise<FlatchatResult<{ avatars: FlatchatAvatar[] }>>;
  uploadAvatar(): Promise<FlatchatResult<{ id: string }>>;
  wearAvatar(id: string | null): Promise<FlatchatResult<object>>;
  deleteAvatar(id: string): Promise<FlatchatResult<object>>;
  avatarFile(manifest: string, level: 'manifest' | 'thumbnail' | 'lod0' | 'lod1' | 'lod2' | 'impostor'): Promise<FlatchatResult<{ manifest: import('@flatchat/content').AvatarManifest; bytes: ArrayBuffer; kit?: import('@flatchat/content').BodyKit }>>;
  // Standard bodies, items and outfits (S5.05).
  takeKit(kit: import('@flatchat/content').BodyKit): Promise<FlatchatResult<{ id: string; status: 'ready' | 'converting' }>>;
  items(): Promise<FlatchatResult<{ items: FlatchatItem[] }>>;
  /** Takes one of the starter wardrobe's items (P.08), with no upload. */
  takeStarter(starter: string): Promise<FlatchatResult<{ id: string; status: 'ready' | 'converting' }>>;
  /** Opens the dialog and sends the file; a file that cannot say what it is (S5.08) comes back as
   *  needs-declaration, and goes when its declaration is given with the token. */
  uploadItem(given?: { token: string; declaration: FlatchatItemDeclaration }): Promise<FlatchatResult<{ id: string }> | { ok: false; error: 'needs-declaration'; token: string; name: string; format: string }>;
  deleteItem(id: string): Promise<FlatchatResult<object>>;
  itemFile(manifest: string, part: 'manifest' | 'prop' | 'effect' | import('@flatchat/content').BodyKit): Promise<FlatchatResult<{ manifest: import('@flatchat/content').ItemManifest; bytes?: ArrayBuffer }>>;
  outfits(): Promise<FlatchatResult<{ outfits: FlatchatOutfit[] }>>;
  saveOutfit(id: string | null, name: string, items: FlatchatWorn[]): Promise<FlatchatResult<{ outfit: FlatchatOutfit }>>;
  deleteOutfit(id: string): Promise<FlatchatResult<object>>;
  // Emotes and dances (S5.07).
  animations(): Promise<FlatchatResult<{ animations: FlatchatAnimation[] }>>;
  uploadAnimation(use: 'emote' | 'dance', withSound: boolean): Promise<FlatchatResult<{ id: string }>>;
  deleteAnimation(id: string): Promise<FlatchatResult<object>>;
  animationFile(manifest: string, part: 'vrma' | 'audio'): Promise<FlatchatResult<{ manifest: import('@flatchat/content').AnimationManifest; bytes: ArrayBuffer }>>;
  // The free gallery (S5.06).
  gallery(q: { kind?: string; slot?: string; body?: string; q?: string; before?: string }): Promise<FlatchatResult<{ entries: FlatchatGalleryEntry[]; next: string | null }>>;
  publish(req: { kind: 'avatar' | 'item'; id: string; name: string; licence: import('@flatchat/content').Licence; affirm: boolean }): Promise<FlatchatResult<{ entry: FlatchatGalleryEntry }>>;
  take(id: string): Promise<FlatchatResult<{ kind: 'avatar' | 'item'; id: string }>>;
  withdraw(id: string): Promise<FlatchatResult<object>>;
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
