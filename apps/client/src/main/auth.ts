// SPDX-License-Identifier: MPL-2.0
// Signing in (S1.04, DR-22): the client makes a PKCE verifier, opens a loopback port, asks the core
// for a login request, and opens the core's sign-in page in the system browser; the browser comes
// back to the loopback port with a code, which the client trades (with its verifier) for a session.
// The refresh token is kept encrypted by the operating system (Electron's safeStorage, injected
// here as a TokenStore); the access token lives only in memory. A refresh token works once, so
// refreshes are serialised: two at once would look like a stolen token and end the session.
import { createHash, randomBytes } from 'node:crypto';
import { type Account, type AvatarItem, type BanAppeal, type CoreApi, CoreError, type CoreTokens, type ItemEntry, type JoinTicket, type MyReport, type OutfitEntry, type Person, type ReportBody, type WornEntry, type WorldSummary } from './core-api';
import type { BodyKit } from '@flatchat/content';
import { listenForCallback } from './loopback';

export interface TokenStore {
  load(): string | undefined;
  save(refresh: string | undefined): void;
  /** False when the system offers no protected storage: the session then lasts until the app quits. */
  readonly durable: boolean;
}

export type AuthState =
  | { status: 'signed-out'; error?: string }
  | { status: 'waiting' }
  | { status: 'signed-in'; account: Account; remembered: boolean };

const SIGNIN_MS = 10 * 60_000;
/** Refresh this long before the access token's end. */
const EARLY_MS = 60_000;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

export class Auth {
  private readonly api: CoreApi;
  private readonly store: TokenStore;
  private readonly openBrowser: (url: URL) => Promise<void>;
  private readonly now: () => number;
  private tokens: CoreTokens | undefined;
  private refreshing: Promise<CoreTokens | undefined> | undefined;
  private abort: AbortController | undefined;
  private current: AuthState = { status: 'signed-out' };
  private readonly listeners = new Set<(s: AuthState) => void>();

  constructor(api: CoreApi, store: TokenStore, openBrowser: (url: URL) => Promise<void>, now: () => number = Date.now) {
    this.api = api;
    this.store = store;
    this.openBrowser = openBrowser;
    this.now = now;
  }

  get state(): AuthState {
    return this.current;
  }

  onChange(fn: (s: AuthState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: AuthState): AuthState {
    this.current = s;
    for (const fn of this.listeners) fn(s);
    return s;
  }

  private signedIn(t: CoreTokens): AuthState {
    this.tokens = t;
    this.store.save(t.refresh);
    return this.set({ status: 'signed-in', account: t.account, remembered: this.store.durable });
  }

  /** At start: a remembered session is refreshed, or forgotten if the core no longer takes it. */
  async restore(): Promise<AuthState> {
    const refresh = this.store.load();
    if (!refresh) return this.current;
    try {
      return this.signedIn(await this.api.refresh(refresh));
    } catch (err) {
      // Unreachable core: keep the token for the next start, stay signed out for now.
      if (!(err instanceof CoreError && err.status === 0)) this.store.save(undefined);
      return this.set({ status: 'signed-out', ...(err instanceof CoreError && err.status === 0 ? { error: 'unreachable' } : {}) });
    }
  }

  /** The whole browser sign-in; resolves when the player is signed in, gave up, or it failed. */
  async signIn(): Promise<AuthState> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.set({ status: 'waiting' });
    const { verifier, challenge } = pkcePair();
    let loopback: Awaited<ReturnType<typeof listenForCallback>> | undefined;
    try {
      // The port first, so the request names it; the request then binds the callback to this window.
      loopback = await listenForCallback(SIGNIN_MS, abort.signal);
      const { request, signinUrl } = await this.api.loginRequest(challenge, loopback.port);
      loopback.expect(request);
      await this.openBrowser(signinUrl);
      const { code } = await loopback.result;
      return this.signedIn(await this.api.exchange(request, code, verifier));
    } catch (err) {
      if (abort.signal.aborted) return this.set({ status: 'signed-out' });
      return this.set({ status: 'signed-out', error: err instanceof CoreError ? err.code : 'failed' });
    } finally {
      loopback?.close();
      if (this.abort === abort) this.abort = undefined;
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  async signOut(): Promise<AuthState> {
    const t = this.tokens;
    this.tokens = undefined;
    this.store.save(undefined);
    if (t) await this.api.revoke(t.access).catch(() => undefined);
    return this.set({ status: 'signed-out' });
  }

  /** A valid access token, refreshed when it is about to end; one refresh at a time. */
  async access(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new CoreError(401, 'signed-out', 'sign in first');
    if (t.accessExpiresAt - EARLY_MS > this.now()) return t.access;
    this.refreshing ??= this.api
      .refresh(t.refresh)
      .then((next) => {
        this.signedIn(next);
        return next;
      })
      .catch((err: unknown) => {
        if (err instanceof CoreError && err.status !== 0) {
          this.tokens = undefined;
          this.store.save(undefined);
          this.set({ status: 'signed-out', error: 'expired' });
        }
        throw err;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    const next = await this.refreshing;
    if (!next) throw new CoreError(401, 'signed-out', 'sign in again');
    return next.access;
  }

  worlds(): Promise<WorldSummary[]> {
    return this.api.worlds();
  }

  world(worldId: string): Promise<WorldSummary> {
    return this.api.world(worldId);
  }

  async favourites(): Promise<WorldSummary[]> {
    return this.api.favourites(await this.access());
  }

  async setFavourite(worldId: string, on: boolean): Promise<WorldSummary[]> {
    const access = await this.access();
    await this.api.setFavourite(access, worldId, on);
    return this.api.favourites(access);
  }

  async join(worldId: string): Promise<JoinTicket> {
    return this.api.join(await this.access(), worldId);
  }

  async standing(): Promise<{ under18: boolean; verified: boolean; supervision: string }> {
    return this.api.standing(await this.access());
  }

  async resendVerification(): Promise<boolean> {
    return this.api.resendVerification(await this.access());
  }

  async friends(): Promise<{ friends: Person[]; incoming: Person[]; outgoing: Person[] }> {
    return this.api.friends(await this.access());
  }

  async befriend(account: string): Promise<string> {
    return this.api.befriend(await this.access(), account);
  }

  async unfriend(account: string): Promise<void> {
    return this.api.unfriend(await this.access(), account);
  }

  async blocks(): Promise<string[]> {
    return this.api.blocks(await this.access());
  }

  async setBlock(account: string, on: boolean): Promise<void> {
    return this.api.setBlock(await this.access(), account, on);
  }

  async avatars(): Promise<AvatarItem[]> {
    return this.api.avatars(await this.access());
  }

  /** Uploads a file: its slot first, then the file to the slot's link. */
  async uploadAvatar(name: string, bytes: Uint8Array): Promise<string> {
    const slot = await this.api.avatarSlot(await this.access(), { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await this.api.sendUpload(slot.url, bytes);
    return slot.id;
  }

  async wearAvatar(id: string | null): Promise<void> {
    return this.api.wearAvatar(await this.access(), id);
  }

  async deleteAvatar(id: string): Promise<void> {
    return this.api.deleteAvatar(await this.access(), id);
  }

  async avatarFiles(manifest: string): Promise<{ manifest: unknown; links: Record<string, string>; kit?: BodyKit }> {
    return this.api.avatarFiles(await this.access(), manifest);
  }

  // Standard bodies, items and outfits (S5.05).
  async takeKit(kit: BodyKit): Promise<{ id: string; status: 'ready' | 'converting' }> {
    return this.api.takeKit(await this.access(), kit);
  }

  async items(): Promise<ItemEntry[]> {
    return this.api.items(await this.access());
  }

  /** Asks for a slot and sends the file there; the core converts it. Returns the item's id. */
  async uploadItem(name: string, bytes: Uint8Array): Promise<string> {
    const slot = await this.api.itemSlot(await this.access(), { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await this.api.sendUpload(slot.url, bytes);
    return slot.id;
  }

  async deleteItem(id: string): Promise<void> {
    return this.api.deleteItem(await this.access(), id);
  }

  async itemFiles(manifest: string): Promise<{ manifest: unknown; links: Record<string, string> }> {
    return this.api.itemFiles(await this.access(), manifest);
  }

  async outfits(): Promise<OutfitEntry[]> {
    return this.api.outfits(await this.access());
  }

  async saveOutfit(id: string | null, outfit: { name: string; items: WornEntry[] }): Promise<OutfitEntry> {
    return this.api.saveOutfit(await this.access(), id, outfit);
  }

  async deleteOutfit(id: string): Promise<void> {
    return this.api.deleteOutfit(await this.access(), id);
  }

  async file(url: string): Promise<Uint8Array> {
    return this.api.file(url);
  }

  async mutes(): Promise<string[]> {
    return this.api.mutes(await this.access());
  }

  async setMute(account: string, on: boolean): Promise<void> {
    return this.api.setMute(await this.access(), account, on);
  }

  async report(r: ReportBody): Promise<string> {
    return this.api.report(await this.access(), r);
  }

  async reports(): Promise<MyReport[]> {
    return this.api.reports(await this.access());
  }

  async appealBan(worldId: string, reason: string, text: string): Promise<void> {
    return this.api.appealBan(await this.access(), worldId, reason, text);
  }

  async banAppeal(worldId: string): Promise<BanAppeal | undefined> {
    return this.api.banAppeal(await this.access(), worldId);
  }

  isRelay(url: string): boolean {
    return this.api.isRelay(url);
  }

  async relaySignal(url: string, offer: { type: string; sdp: string }): Promise<{ type: string; sdp: string }> {
    return this.api.relaySignal(await this.access(), url, offer);
  }
}
