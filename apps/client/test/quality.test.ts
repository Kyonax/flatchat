// SPDX-License-Identifier: MPL-2.0
// What to render and at what quality (S6.08): each preset's values, `auto` following the measured
// tier and `custom` keeping the player's own; the frame-rate tuner stepping down while frames are
// slow (fewer avatars, then a lower resolution, then the costliest screen effects) and back up once
// they recover, never faster than every four seconds; the viewer's switches within what the preset
// and the tuner allow; the pixel ratio from the screen, the quality and the tuner.
import { describe, expect, it } from 'vitest';
import { cleanSettings, defaultSettings, type GraphicsSettings } from '../src/shared/settings';
import { allowedLook, pixelRatioFor, PRESETS, presetOf, QualityTuner, qualityOf, TUNER_STEPS } from '../src/renderer/src/world/quality';

const graphics = (over: Partial<GraphicsSettings> = {}): GraphicsSettings => ({ ...defaultSettings().graphics, ...over });

describe('the presets', () => {
  it('draw less on low: a lower resolution, no smoothed edges, no reflections, light shafts or echo', () => {
    expect(PRESETS.low).toMatchObject({ renderScale: 0.75, pixelRatio: 1, antialias: false, reverb: false, look: { reflections: false, shafts: false, bloom: true, filters: true } });
    expect(PRESETS.medium.look.reflections).toBe(false);
    expect(PRESETS.high).toMatchObject({ renderScale: 1, pixelRatio: 2, antialias: true, reverb: true, look: { reflections: true, shafts: true } });
  });

  it('follow the measured tier on auto, and keep the player\'s own values on custom', () => {
    expect(presetOf(graphics(), 'low')).toBe('low');
    expect(presetOf(graphics(), 'unset')).toBe('medium');
    expect(presetOf(graphics({ preset: 'high' }), 'low')).toBe('high');
    expect(qualityOf(graphics({ preset: 'low' }), 'high')).toBe(PRESETS.low);
    expect(qualityOf(graphics({ preset: 'custom', renderScale: 0.6, pixelRatio: 1.25, antialias: false }), 'low')).toMatchObject({ renderScale: 0.6, pixelRatio: 1.25, antialias: false, reverb: true });
  });

  it('are read from a settings file field by field, out-of-range values pulled in', () => {
    const s = cleanSettings({ graphics: { preset: 'ultra', renderScale: 0.1, pixelRatio: 9, antialias: 'yes', stats: true } });
    expect(s.graphics).toEqual({ preset: 'auto', renderScale: 0.5, pixelRatio: 2, antialias: true, stats: true });
    expect(s.keys.stats).toEqual(['F3']);
    expect(s.keys.help).toEqual(['F1']);
  });
});

describe('the frame-rate tuner', () => {
  const run = (t: QualityTuner, ms: number, seconds: number, clock: { now: number }): void => {
    for (let i = 0; i < seconds * 30; i++) t.push(ms, (clock.now += 1000 / 30));
  };

  it('steps down while frames are slow, one step every four seconds at most, to its last step', () => {
    const t = new QualityTuner();
    const clock = { now: 0 };
    run(t, 50, 3, clock);
    expect(t.step).toBe(1);
    run(t, 50, 2, clock);
    // Two seconds after a step: not yet another.
    expect(t.step).toBe(1);
    run(t, 50, 30, clock);
    expect(t.step).toBe(TUNER_STEPS.length - 1);
    expect(t.now).toMatchObject({ avatars: 0.25, scale: 0.6, look: { bloom: false, reflections: false, shafts: false } });
  });

  it('steps back up only after three fast windows in a row, and holds between 20 and 33 ms', () => {
    const t = new QualityTuner();
    const clock = { now: 0 };
    run(t, 50, 40, clock);
    const low = t.step;
    run(t, 25, 20, clock);
    expect(t.step).toBe(low);
    run(t, 10, 5, clock);
    expect(t.step).toBe(low);
    run(t, 10, 60, clock);
    expect(t.step).toBe(0);
    expect(t.now).toEqual(TUNER_STEPS[0]);
  });
});

describe('what is drawn', () => {
  it('is the viewer\'s switches within the quality and the tuner', () => {
    const all = { bloom: true, shafts: true, reflections: true, filters: true };
    expect(allowedLook(all, PRESETS.high, {})).toEqual(all);
    expect(allowedLook(all, PRESETS.low, {})).toEqual({ bloom: true, shafts: false, reflections: false, filters: true });
    expect(allowedLook({ ...all, filters: false }, PRESETS.high, { bloom: false })).toEqual({ bloom: false, shafts: true, reflections: true, filters: false });
  });

  it('at the screen\'s pixel ratio, capped by the quality, scaled by it and the tuner', () => {
    expect(pixelRatioFor(2, PRESETS.high, 1)).toBe(2);
    expect(pixelRatioFor(2, PRESETS.low, 1)).toBe(0.75);
    expect(pixelRatioFor(1, PRESETS.medium, 0.7)).toBeCloseTo(0.7);
    expect(pixelRatioFor(1, PRESETS.low, 0.6)).toBe(0.5);
  });
});
