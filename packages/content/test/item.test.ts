// SPDX-License-Identifier: Apache-2.0
// The item rules every program shares (S5.02): the kits' 53 bones and the regions they fill, the
// slots and their caps, a creator's declaration read or refused with every reason at once, and a
// fit's JSON checked before three.js sees it; and which items can be worn together (S5.05), effects
// at their points among them (S6.01).
import { describe, expect, it } from 'vitest';
import { type AttachPoint, checkItemFit, checkItemManifest, ITEM_FORMAT, ItemFormatError, KIT_BONES, MODEL_SLOTS, outfitProblems, readItemDeclaration, REGIONS, regionOfBone, resolveOutfit, type Slot, SLOT_REPLACES, SLOTS } from '../src/index.ts';

describe('items', () => {
  it('name the kits\' 53 bones and give every bone but the root one region', () => {
    expect(KIT_BONES).toHaveLength(53);
    expect(new Set(KIT_BONES).size).toBe(53);
    expect(KIT_BONES.filter((b) => regionOfBone(b) === undefined)).toEqual(['Root']);
    expect(regionOfBone('spine_01')).toBe('belly');
    expect(regionOfBone('pinky_03_r')).toBe('hand_r');
    expect(Object.values(REGIONS).flat().every((b) => KIT_BONES.includes(b))).toBe(true);
  });

  it('have fixed slots with caps, a full outfit taking the top and the bottom', () => {
    expect(Object.keys(SLOTS)).toContain('top');
    expect(SLOTS.glasses.triangles).toBeLessThan(SLOTS.top.triangles);
    expect(SLOT_REPLACES.full).toEqual(['top', 'bottom']);
  });

  it('read a declaration, sorting and de-duplicating what it hides', () => {
    expect(readItemDeclaration({ name: ' Tee ', slot: 'top', hides: ['chest', 'belly', 'chest'], authors: ['A', ' '] })).toEqual({ name: 'Tee', slot: 'top', hides: ['belly', 'chest'], authors: ['A'] });
  });

  it('refuse a declaration with every reason at once', () => {
    try {
      readItemDeclaration({ slot: 'cape', hides: ['tail'] });
      throw new Error('read');
    } catch (err) {
      expect(err).toBeInstanceOf(ItemFormatError);
      expect((err as ItemFormatError).problems).toHaveLength(3);
    }
  });

  it('check a manifest and a fit before the client uses them', () => {
    const hash = 'a'.repeat(64);
    const manifest = { format: ITEM_FORMAT, kind: 'item', converter: '1.0.0', source: { sha256: hash, bytes: 1 }, name: 'Tee', authors: [], slot: 'top', hides: ['chest'], fits: { feminine: { file: hash } }, clipping: {}, warnings: [] };
    expect(checkItemManifest(manifest).name).toBe('Tee');
    expect(() => checkItemManifest({ ...manifest, fits: { child: { file: hash } } })).toThrow(/no body named child/);
    const fit = (joint: string): Record<string, unknown> => ({ asset: { version: '2.0' }, meshes: [{}], nodes: [{ name: joint }], skins: [{ joints: [0] }] });
    expect(() => checkItemFit(fit('pelvis'))).not.toThrow();
    expect(() => checkItemFit(fit('tail_01'))).toThrow(/a joint the kits do not have/);
    expect(() => checkItemFit({ ...fit('pelvis'), extensionsUsed: ['KHR_materials_clearcoat'] })).toThrow(/an extension the converter does not write/);
  });
});

describe('outfits (S5.05)', () => {
  it('take one item to a slot, one prop to a point, and a full outfit alone', () => {
    expect(outfitProblems([{ slot: 'top' }, { slot: 'bottom' }, { slot: 'attachment', attach: 'hip_l' }, { slot: 'attachment', attach: 'hip_r' }, { slot: 'hat' }])).toEqual([]);
    expect(outfitProblems([{ slot: 'top' }, { slot: 'top' }])).toEqual(['2 items in one top slot']);
    expect(outfitProblems([{ slot: 'attachment', attach: 'back' }, { slot: 'attachment', attach: 'back' }])).toEqual(['2 items in one attachment at back']);
    expect(outfitProblems([{ slot: 'full' }, { slot: 'bottom' }])).toEqual(['a full item takes the bottom slot too']);
  });

  it('are made wearable by keeping the item worn later where two conflict, in their order', () => {
    const tee = { id: 'tee', slot: 'top' as const };
    const shirt = { id: 'shirt', slot: 'top' as const };
    const jeans = { id: 'jeans', slot: 'bottom' as const };
    const dress = { id: 'dress', slot: 'full' as const };
    const capL = { id: 'capL', slot: 'attachment' as const, attach: 'hip_l' as const };
    const capR = { id: 'capR', slot: 'attachment' as const, attach: 'hip_r' as const };
    const ids = (xs: Array<{ id: string }>): string[] => xs.map((x) => x.id);
    expect(ids(resolveOutfit([tee, jeans, capL, capR]))).toEqual(['tee', 'jeans', 'capL', 'capR']);
    expect(ids(resolveOutfit([tee, jeans, shirt]))).toEqual(['jeans', 'shirt']);
    expect(ids(resolveOutfit([tee, jeans, dress]))).toEqual(['dress']);
    expect(ids(resolveOutfit([dress, jeans]))).toEqual(['jeans']);
    expect(ids(resolveOutfit([capL, { ...capL, id: 'capL2' }]))).toEqual(['capL2']);
    const sets: Array<Array<{ id: string; slot: Slot; attach?: AttachPoint }>> = [[tee, shirt, dress, jeans], [dress, tee, capL, capL]];
    for (const set of sets) expect(outfitProblems(resolveOutfit(set))).toEqual([]);
  });
});

describe('effects as items (S6.01)', () => {
  it('are worn at a point with a scale, hide nothing, and keep the declaration’s rules', () => {
    expect(readItemDeclaration({ name: 'Aura', slot: 'effect', attach: 'hips' })).toMatchObject({ slot: 'effect', attach: 'hips', scale: 1, hides: [] });
    expect(readItemDeclaration({ name: 'Glow', slot: 'effect', attach: 'hand_r', scale: 0.25 }).scale).toBe(0.25);
    const why = (d: unknown): string[] => {
      try {
        readItemDeclaration(d);
      } catch (err) {
        return (err as ItemFormatError).problems;
      }
      return [];
    };
    expect(why({ name: 'Aura', slot: 'effect' })).toEqual([expect.stringMatching(/^an effect names the point it is worn at/)]);
    expect(why({ name: 'Aura', slot: 'effect', attach: 'hips', hides: ['chest'], scale: 500 })).toEqual(['an effect hides nothing of the body', "an effect's scale is 0.01 to 100"]);
    expect(why({ name: 'Hat', slot: 'hat', scale: 2 })).toEqual(['only an effect has a scale']);
    expect(MODEL_SLOTS).not.toContain('effect');
  });

  it('take one effect to a point, and fit an avatar’s budget together', () => {
    const aura = { slot: 'effect' as const, attach: 'hips' as const, effect: { peak: { instances: 118, quads: 101, triangles: 16_940 } } };
    const prop = { slot: 'attachment' as const, attach: 'hips' as const };
    // A prop and an effect share a point; two effects do not.
    expect(outfitProblems([aura, prop])).toEqual([]);
    expect(outfitProblems([aura, { ...aura }])).toContain('2 items in one effect at hips');
    expect(outfitProblems([aura, { ...aura, attach: 'chest' as const }])).toEqual([expect.stringMatching(/33880 triangles together; an avatar's may draw 20000/)]);
  });
});
