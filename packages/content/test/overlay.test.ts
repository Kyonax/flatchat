// SPDX-License-Identifier: Apache-2.0
// Screen overlays (S6.02's Verify: consent tests, switching off per viewer): who sees an overlay,
// at what size and opacity, and the rules an overlay item and an outfit of them meet.
import { describe, expect, it } from 'vitest';
import { checkItemManifest, type ItemManifest, outfitProblems, readItemDeclaration, resolveOutfit } from '../src/item.ts';
import { DEFAULT_OVERLAY_SETTINGS, OVERLAY_LIMITS, overlayImageProblems, overlayShown, overlayVisible, readOverlayLook } from '../src/overlay.ts';
import { uploadFormat } from '../src/formats.ts';

/** A PNG's first bytes: the signature and the IHDR chunk's width and height. */
const png = (width: number, height: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
};

describe('who sees an overlay (consent)', () => {
  const settings = { ...DEFAULT_OVERLAY_SETTINGS, allowed: ['acc-friend'] };
  const other = { whose: 'other' as const, settings, safeMode: false, audience: 'everyone' as const, ageS: 1 };

  it("shows another player's only to a viewer who allowed that person", () => {
    expect(overlayVisible({ ...other, account: 'acc-friend' })).toBe(true);
    expect(overlayVisible({ ...other, account: 'acc-stranger' })).toBe(false);
    expect(overlayVisible({ ...other, account: undefined })).toBe(false);
  });

  it('never shows one its wearer keeps to themself, or one from a hidden person', () => {
    expect(overlayVisible({ ...other, account: 'acc-friend', audience: 'self' })).toBe(false);
    expect(overlayVisible({ ...other, account: 'acc-friend', hidden: true })).toBe(false);
  });

  it("shows another player's for ten seconds after it was put on", () => {
    expect(overlayVisible({ ...other, account: 'acc-friend', ageS: OVERLAY_LIMITS.others.showS - 0.1 })).toBe(true);
    expect(overlayVisible({ ...other, account: 'acc-friend', ageS: OVERLAY_LIMITS.others.showS })).toBe(false);
  });

  it("shows the viewer's own and the world's until the viewer switches them off", () => {
    expect(overlayVisible({ whose: 'mine', settings, safeMode: false })).toBe(true);
    expect(overlayVisible({ whose: 'world', settings, safeMode: false })).toBe(true);
    expect(overlayVisible({ whose: 'mine', settings: { ...settings, mine: false }, safeMode: false })).toBe(false);
    expect(overlayVisible({ whose: 'world', settings: { ...settings, world: false }, safeMode: false })).toBe(false);
  });

  it('shows none at all in safe mode', () => {
    for (const whose of ['mine', 'world', 'other'] as const) expect(overlayVisible({ ...other, whose, account: 'acc-friend', safeMode: true })).toBe(false);
  });
});

describe("an overlay's look on a viewer's screen", () => {
  const big = { hud: 'centre' as const, size: 0.5, opacity: 1, motion: 'pulse' as const };

  it("keeps another player's small, see-through and off the centre", () => {
    expect(overlayShown(big, 'other')).toEqual({ hud: 'top', size: OVERLAY_LIMITS.others.size, opacity: OVERLAY_LIMITS.others.opacity, motion: 'pulse' });
  });

  it("lets the wearer's own and a world's be larger", () => {
    expect(overlayShown(big, 'mine')).toEqual(big);
    expect(overlayShown({ ...big, size: 1 }, 'world')).toEqual({ ...big, size: 1, opacity: OVERLAY_LIMITS.world.opacity });
  });
});

describe('the overlay format', () => {
  it('reads a look with its defaults, and refuses what is out of range', () => {
    expect(readOverlayLook({ hud: 'top-left' }, 'item')).toEqual({ look: { hud: 'top-left', size: 0.15, opacity: 1, motion: 'none' }, problems: [] });
    expect(readOverlayLook({}, 'world').look.hud).toBe('centre');
    expect(readOverlayLook({ hud: 'middle', size: 2, opacity: 0, motion: 'strobe' }, 'item').problems).toHaveLength(4);
    expect(readOverlayLook({ hud: 'top', size: 1 }, 'world').problems).toEqual([]);
    expect(readOverlayLook({ hud: 'top', size: 1 }, 'item').problems).toHaveLength(1);
  });

  it('takes a PNG of at most 512 px a side', () => {
    expect(overlayImageProblems(png(256, 128))).toEqual([]);
    expect(overlayImageProblems(png(1024, 16))).toEqual([expect.stringMatching(/512 px a side/)]);
    expect(overlayImageProblems(new Uint8Array(64))).toEqual([expect.stringMatching(/is a PNG/)]);
    expect(uploadFormat(png(64, 64))).toBe('image');
  });
});

describe('overlay items and outfits', () => {
  const declared = { name: 'Badge', slot: 'overlay', hud: 'top-right', size: 0.1, motion: 'bob', audience: 'everyone', authors: ['me'] };

  it('reads an overlay declaration, and keeps its fields to overlays', () => {
    expect(readItemDeclaration(declared)).toMatchObject({ slot: 'overlay', hud: 'top-right', size: 0.1, opacity: 1, motion: 'bob', audience: 'everyone' });
    expect(readItemDeclaration({ ...declared, audience: undefined }).audience).toBe('self');
    expect(() => readItemDeclaration({ name: 'Hat', slot: 'hat', hud: 'top' })).toThrow(/only an overlay has a screen point/);
    expect(() => readItemDeclaration({ ...declared, hud: undefined })).toThrow(/names its screen point/);
  });

  it('wears one overlay to a screen point, four at most', () => {
    expect(outfitProblems([{ slot: 'overlay', hud: 'top' }, { slot: 'overlay', hud: 'bottom' }])).toEqual([]);
    expect(outfitProblems([{ slot: 'overlay', hud: 'top' }, { slot: 'overlay', hud: 'top' }])).toEqual(['2 items in one overlay at top']);
    const five = (['top', 'bottom', 'left', 'right', 'centre'] as const).map((hud) => ({ slot: 'overlay' as const, hud }));
    expect(outfitProblems(five)).toEqual(['5 overlays; 4 at most']);
    expect(resolveOutfit([{ slot: 'overlay' as const, hud: 'top' as const, n: 1 }, { slot: 'overlay' as const, hud: 'top' as const, n: 2 }]).map((w) => w.n)).toEqual([2]);
  });

  it("checks an overlay item's manifest", () => {
    const m: ItemManifest = {
      format: 1,
      kind: 'item',
      converter: 'x',
      source: { sha256: 'a'.repeat(64), bytes: 10 },
      name: 'Badge',
      authors: [],
      slot: 'overlay',
      hides: [],
      fits: {},
      clipping: {},
      overlay: { file: 'b'.repeat(64), bytes: 10, width: 64, height: 64, hud: 'top', size: 0.1, opacity: 0.8, motion: 'none', audience: 'self' },
      warnings: [],
    };
    expect(checkItemManifest(m).overlay?.hud).toBe('top');
    expect(() => checkItemManifest({ ...m, overlay: { ...m.overlay!, width: 4096 } })).toThrow(/out of range/);
    expect(() => checkItemManifest({ ...m, overlay: undefined })).toThrow();
  });
});
