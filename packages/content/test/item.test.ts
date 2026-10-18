// SPDX-License-Identifier: Apache-2.0
// The item rules every program shares (S5.02): the kits' 53 bones and the regions they fill, the
// slots and their caps, a creator's declaration read or refused with every reason at once, and a
// fit's JSON checked before three.js sees it.
import { describe, expect, it } from 'vitest';
import { checkItemFit, checkItemManifest, ITEM_FORMAT, ItemFormatError, KIT_BONES, readItemDeclaration, REGIONS, regionOfBone, SLOT_REPLACES, SLOTS } from '../src/index.ts';

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
