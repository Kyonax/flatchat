// SPDX-License-Identifier: MPL-2.0
// Screen overlays in the client (S6.02, Q-M13, T-14): what each player wears at a screen point, and
// the world's own. The viewer's choice always wins (packages/content's overlayVisible): the viewer's
// own show unless switched off, a world's show unless switched off, another player's only when its
// wearer shows it to everyone, the viewer allowed that person, and it was put on less than ten
// seconds ago; and safe mode clears every one. Another player's is drawn small, see-through and off
// the centre (overlayShown). Images come as blob URLs (the page's policy allows blob: images); the
// view (ui/ScreenOverlays.vue) puts each at its point with its motion.
import { type BuiltOverlay, checkItemManifest, type ItemManifest, OVERLAY_LIMITS, type OverlayAudience, overlayImageProblems, type OverlayLook, overlayShown, type OverlaySettings, overlayVisible, type OverlayWhose } from '@flatchat/content';

export interface ShownOverlay {
  /** Stable for the view: whose, and which item or world overlay. */
  key: string;
  src: string;
  whose: OverlayWhose;
  look: OverlayLook;
  /** Width over height. */
  aspect: number;
}

/** An item's manifest, or an item's image (the core's, through the main process). */
export type OverlayFetch = (manifest: string, part: 'manifest' | 'overlay') => Promise<{ manifest: ItemManifest; bytes?: ArrayBuffer }>;

interface WornOverlay {
  /** When this viewer first saw it worn, in performance.now() milliseconds. */
  since: number;
  look?: OverlayLook;
  audience?: OverlayAudience;
  file?: string;
  aspect?: number;
}

export class OverlayLayer {
  settings: OverlaySettings;
  safeMode = false;
  /** Whose account an entity is, and whether the viewer hides that person. */
  accountOf: (entity: number) => string | undefined = () => undefined;
  hiddenOf: (entity: number) => boolean = () => false;
  me = -1;
  private readonly fetch: OverlayFetch | undefined;
  private readonly onChange: (shown: ShownOverlay[]) => void;
  private readonly worn = new Map<number, Map<string, WornOverlay>>();
  private world: Array<{ key: string; look: OverlayLook; file: string; aspect: number }> = [];
  /** Blob URLs by image hash, and the hashes being fetched. */
  private readonly urls = new Map<string, string>();
  private readonly manifests = new Map<string, Promise<ItemManifest | undefined>>();
  private last = '';
  private disposed = false;

  constructor(settings: OverlaySettings, fetch: OverlayFetch | undefined, onChange: (shown: ShownOverlay[]) => void) {
    this.settings = settings;
    this.fetch = fetch;
    this.onChange = onChange;
  }

  /** What an entity wears now (its items' manifest hashes): overlays come and go with it. */
  dress(entity: number, items: readonly string[]): void {
    const had = this.worn.get(entity) ?? new Map<string, WornOverlay>();
    const now = new Map<string, WornOverlay>();
    for (const item of items) {
      const known = had.get(item);
      if (known) {
        now.set(item, known);
        continue;
      }
      const w: WornOverlay = { since: performance.now() };
      now.set(item, w);
      void this.learn(item, w);
    }
    this.worn.set(entity, now);
    this.refresh();
  }

  drop(entity: number): void {
    if (this.worn.delete(entity)) this.refresh();
  }

  /** A world's overlays, with the world's downloaded files. */
  setWorld(overlays: readonly BuiltOverlay[], files: ReadonlyMap<string, Uint8Array>): void {
    this.world = [];
    for (const [i, o] of overlays.entries()) {
      const bytes = files.get(o.file);
      // The host's image: its header checked before anything decodes it.
      if (!bytes || overlayImageProblems(bytes, OVERLAY_LIMITS.world.side).length) continue;
      if (!this.urls.has(o.file)) this.urls.set(o.file, URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' })));
      this.world.push({ key: `world:${i}`, look: { hud: o.hud, size: o.size, opacity: o.opacity, motion: o.motion }, file: o.file, aspect: o.width / o.height });
    }
    this.refresh();
  }

  /** Works out what shows now and tells the view when it changed. Called on every change and on a
   *  timer, since another player's overlay goes after its ten seconds. */
  refresh(now = performance.now()): void {
    if (this.disposed) return;
    const shown: ShownOverlay[] = [];
    for (const w of this.world) {
      const src = this.urls.get(w.file);
      if (src && overlayVisible({ whose: 'world', settings: this.settings, safeMode: this.safeMode })) shown.push({ key: w.key, src, whose: 'world', look: overlayShown(w.look, 'world'), aspect: w.aspect });
    }
    const others: Array<ShownOverlay & { since: number }> = [];
    for (const [entity, items] of this.worn) {
      const whose: OverlayWhose = entity === this.me ? 'mine' : 'other';
      for (const [item, w] of items) {
        const src = w.file ? this.urls.get(w.file) : undefined;
        if (!src || !w.look) continue;
        const visible = overlayVisible({ whose, settings: this.settings, safeMode: this.safeMode, account: this.accountOf(entity), audience: w.audience, hidden: this.hiddenOf(entity), ageS: (now - w.since) / 1000 });
        if (!visible) continue;
        const o = { key: `${entity}:${item}`, src, whose, look: overlayShown(w.look, whose), aspect: w.aspect ?? 1 };
        if (whose === 'mine') shown.push(o);
        else others.push({ ...o, since: w.since });
      }
    }
    // Everyone else's together: the newest few.
    others.sort((a, b) => b.since - a.since);
    for (const o of others.slice(0, OVERLAY_LIMITS.others.count)) shown.push({ key: o.key, src: o.src, whose: o.whose, look: o.look, aspect: o.aspect });
    const sig = shown.map((o) => `${o.key}|${o.look.hud}|${o.look.size}|${o.look.opacity}`).join(';');
    if (sig === this.last) return;
    this.last = sig;
    this.onChange(shown);
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  /** An item's manifest; an overlay's look and image. Anything that fails stays unshown. */
  private async learn(item: string, w: WornOverlay): Promise<void> {
    if (!this.fetch) return;
    let p = this.manifests.get(item);
    if (!p) {
      const fetch = this.fetch;
      p = fetch(item, 'manifest').then(
        (r) => checkItemManifest(r.manifest),
        () => undefined,
      );
      this.manifests.set(item, p);
    }
    const m = await p;
    if (!m || m.slot !== 'overlay' || !m.overlay || this.disposed) return;
    const fit = m.overlay;
    w.look = { hud: fit.hud, size: fit.size, opacity: fit.opacity, motion: fit.motion };
    w.audience = fit.audience;
    w.aspect = fit.width / fit.height;
    w.file = fit.file;
    if (!this.urls.has(fit.file)) {
      try {
        const r = await this.fetch(item, 'overlay');
        if (!r.bytes || this.disposed) return;
        if (!this.urls.has(fit.file)) this.urls.set(fit.file, URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' })));
      } catch {
        return;
      }
    }
    this.refresh();
  }
}
