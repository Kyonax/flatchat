// SPDX-License-Identifier: MPL-2.0
// What to render and at what quality (S6.08; Q-M4, Q-D7, Q-B1). A preset per hardware tier sets the
// resolution (a share of the window's pixels, and the most screen pixels per CSS pixel), smoothed
// edges, which of a world's screen effects may run and the room's echo; `auto` follows the tier the
// first visit measured (S4.05), `custom` keeps the player's own values. On top of it the frame-rate
// tuner steps down while frames are slow (fewer avatars in full, then a lower resolution, then the
// costliest screen effects off) and back up once they recover, never faster than every few seconds,
// so it does not flicker. The viewer's own switches (settings.look, settings.sound) still decide
// within what the preset and the tuner allow. Pure.
import type { GraphicsSettings, LookSettings, Tier } from '../../../shared/settings';

export type Preset = 'low' | 'medium' | 'high';

export interface Quality {
  /** The share of the window's pixels drawn, 0.5 to 1 (the picture is stretched to fill). */
  renderScale: number;
  /** The most screen pixels drawn per CSS pixel. */
  pixelRatio: number;
  /** Smoothed edges (MSAA); a new renderer takes it, so it applies from the next world. */
  antialias: boolean;
  /** The screen effects the preset allows (the viewer's switches decide within them). */
  look: LookSettings;
  /** The room's echo in reverb zones (S6.06). */
  reverb: boolean;
}

export const PRESETS: Readonly<Record<Preset, Quality>> = {
  low: { renderScale: 0.75, pixelRatio: 1, antialias: false, look: { bloom: true, shafts: false, reflections: false, filters: true }, reverb: false },
  medium: { renderScale: 1, pixelRatio: 1.5, antialias: true, look: { bloom: true, shafts: true, reflections: false, filters: true }, reverb: true },
  high: { renderScale: 1, pixelRatio: 2, antialias: true, look: { bloom: true, shafts: true, reflections: true, filters: true }, reverb: true },
};

/** The preset a player's settings stand for: theirs, or the measured tier's (`auto`, `custom`). */
export function presetOf(g: GraphicsSettings, tier: Tier): Preset {
  if (g.preset === 'low' || g.preset === 'medium' || g.preset === 'high') return g.preset;
  return tier === 'unset' ? 'medium' : tier;
}

/** The quality to draw at: the preset's, or the player's own values with `custom` (every screen
 *  effect allowed: the viewer's switches decide). */
export function qualityOf(g: GraphicsSettings, tier: Tier): Quality {
  if (g.preset !== 'custom') return PRESETS[presetOf(g, tier)];
  return { renderScale: g.renderScale, pixelRatio: g.pixelRatio, antialias: g.antialias, look: { bloom: true, shafts: true, reflections: true, filters: true }, reverb: true };
}

/** The tuner's steps, from none: what each one takes away. */
export const TUNER_STEPS: ReadonlyArray<{ avatars: number; scale: number; look: Partial<LookSettings> }> = [
  { avatars: 1, scale: 1, look: {} },
  { avatars: 0.75, scale: 1, look: {} },
  { avatars: 0.5, scale: 0.85, look: {} },
  { avatars: 0.5, scale: 0.7, look: { reflections: false, shafts: false } },
  { avatars: 0.25, scale: 0.6, look: { reflections: false, shafts: false, bloom: false } },
];

/** The frame-rate tuner: every two seconds (20 frames at least) the slowest tenth of the frames
 *  decides. Past 30 fps's 33 ms it steps down; well under 20 ms three times running it steps back up;
 *  after a step it waits four seconds before another. */
export class QualityTuner {
  step = 0;
  private samples: number[] = [];
  private since = -1;
  private changedAt = -Infinity;
  private fastWindows = 0;

  push(frameMs: number, now: number): void {
    if (this.since < 0) this.since = now;
    this.samples.push(frameMs);
    if (now - this.since < 2000 || this.samples.length < 20) return;
    const sorted = this.samples.sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    this.samples = [];
    this.since = now;
    const settled = now - this.changedAt >= 4000;
    if (p90 > 1000 / 30) {
      this.fastWindows = 0;
      if (settled && this.step < TUNER_STEPS.length - 1) {
        this.step += 1;
        this.changedAt = now;
      }
    } else if (p90 < 20) {
      this.fastWindows += 1;
      if (settled && this.fastWindows >= 3 && this.step > 0) {
        this.step -= 1;
        this.changedAt = now;
        this.fastWindows = 0;
      }
    } else this.fastWindows = 0;
  }

  /** What the tuner allows now: the avatars' share, the resolution's, the screen effects. */
  get now(): (typeof TUNER_STEPS)[number] {
    return TUNER_STEPS[this.step]!;
  }

  reset(): void {
    this.step = 0;
    this.samples = [];
    this.since = -1;
    this.changedAt = -Infinity;
    this.fastWindows = 0;
  }
}

/** The screen effects to draw: the viewer's switches within the quality's and the tuner's. */
export function allowedLook(viewer: LookSettings, quality: Quality, tuned: Partial<LookSettings>): LookSettings {
  const ok = (k: keyof LookSettings): boolean => viewer[k] && quality.look[k] && tuned[k] !== false;
  return { bloom: ok('bloom'), shafts: ok('shafts'), reflections: ok('reflections'), filters: ok('filters') };
}

/** The renderer's pixel ratio: the screen's, capped by the quality, scaled by it and the tuner (at
 *  least half a pixel per CSS pixel). */
export function pixelRatioFor(devicePixelRatio: number, quality: Quality, tunerScale: number): number {
  return Math.max(0.5, Math.min(devicePixelRatio, quality.pixelRatio) * quality.renderScale * tunerScale);
}
