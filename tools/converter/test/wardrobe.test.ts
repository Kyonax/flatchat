// SPDX-License-Identifier: MPL-2.0
// The starter wardrobe (Track P's P.08): every item kits/items/wardrobe.json lists is the file it
// names, declared as listed, and the item converter takes it with no warning; on each of the three
// standard bodies no skin comes through it in the seven reference poses as made and at both ends
// of the sliders (P.08's Verify: its 12 test poses at the ends, besides their T-poses). The making's
// parts hold on their own: cloth takes the weights of the skin under it, a fit made too tight is
// pushed out no further than the limit, a region is hidden only where every body has it covered,
// and a logo is painted out of a texture with the cloth round it kept.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, type BodyKit, fileDeclaration, readGltf, type Region } from '@flatchat/content';
import type { Node } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { avatarIO, readAvatarLevel } from '../src/avatar/convert.ts';
import { clippingOf, type KitBody, kitBody } from '../src/item/clipping.ts';
import { convertItem } from '../src/item/convert.ts';
import { paintOut, PUSH_LIMIT, pushOut, STARTER_WARDROBE, WARDROBE_SHAPES, wardrobeHides, weightsFromSkin } from '../src/item/wardrobe.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(ROOT, 'kits', 'items');
interface Listed {
  id: string;
  name: string;
  slot: string;
  hides: Region[];
  file: string;
  sha256: string;
  bytes: number;
  minutesByHand: number;
}
const LISTED = (JSON.parse(readFileSync(join(DIR, 'wardrobe.json'), 'utf8')) as { items: Listed[] }).items;
const read = (file: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, file)));
const kits = {} as Record<BodyKit, KitBody>;
beforeAll(async () => {
  for (const b of BODY_KITS) {
    const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', b, `${b}.vrm`))));
    kits[b] = kitBody(b, doc, data);
  }
}, 60_000);

/** An item's fit for a body, as its file carries it. */
async function fitOf(bytes: Uint8Array, body: BodyKit): Promise<Node> {
  const doc = await avatarIO().readBinary(bytes);
  return doc.getRoot().listNodes().find((n) => n.getMesh() && n.getExtras()['flatchat_fit'] === body)!;
}

describe('the starter wardrobe', () => {
  it('is the files wardrobe.json names, declared as listed, each taken by the converter with no warning', async () => {
    expect(LISTED.map((l) => l.id)).toEqual(STARTER_WARDROBE.map((g) => g.id));
    for (const l of LISTED) {
      const bytes = read(l.file);
      expect(createHash('sha256').update(bytes).digest('hex'), l.id).toBe(l.sha256);
      expect(bytes.length).toBe(l.bytes);
      expect(fileDeclaration(readGltf(bytes, 'item.glb').json as unknown as Record<string, unknown>)).toMatchObject({ name: l.name, slot: l.slot, hides: l.hides });
      expect(l.minutesByHand).toBe(0);
      const r = await convertItem(bytes, { ktx2: false, kits });
      expect(Object.keys(r.manifest.fits).sort(), l.id).toEqual([...BODY_KITS]);
      expect(r.manifest.warnings, l.id).toEqual([]);
    }
  }, 300_000);

  it('lets no skin through on any body, as made and at both ends of the sliders', async () => {
    for (const l of LISTED) {
      const bytes = read(l.file);
      for (const b of BODY_KITS) {
        const c = clippingOf(kits[b], await fitOf(bytes, b), l.hides, { shapes: WARDROBE_SHAPES });
        expect(c.poses).toBe(21);
        expect(c.checked, `${l.id} on ${b}`).toBeGreaterThan(300);
        expect(c.through, `${l.id} on ${b}`).toBe(0);
      }
    }
  }, 300_000);
});

describe('the wardrobe’s making', () => {
  const TEE = new Uint8Array(readFileSync(join(DIR, 'test-tee', 'test-tee.glb')));

  it('gives cloth the weights of the skin under it', async () => {
    // The test tee is the skin's own triangles 8 mm out, with the skin's weights: they stay.
    const fit = await fitOf(TEE, 'feminine');
    const prim = fit.getMesh()!.listPrimitives()[0]!;
    const before = Array.from({ length: prim.getAttribute('POSITION')!.getCount() }, (_, i) => [prim.getAttribute('JOINTS_0')!.getElement(i, []), prim.getAttribute('WEIGHTS_0')!.getElement(i, [])] as const);
    expect(weightsFromSkin(kits.feminine, fit)).toBe(before.length);
    let worst = 0;
    before.forEach(([j, w], i) => {
      const after = new Map<number, number>();
      const nj = prim.getAttribute('JOINTS_0')!.getElement(i, []);
      const nw = prim.getAttribute('WEIGHTS_0')!.getElement(i, []);
      nj.forEach((joint, k) => after.set(joint, (after.get(joint) ?? 0) + nw[k]!));
      j.forEach((joint, k) => (worst = Math.max(worst, Math.abs((after.get(joint) ?? 0) - w[k]!))));
    });
    expect(worst).toBeLessThan(0.15);
  });

  it('pushes a fit made too tight out of the skin, no further than its limit', async () => {
    const fit = await fitOf(TEE, 'feminine');
    for (const prim of fit.getMesh()!.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      const nor = prim.getAttribute('NORMAL')!;
      const p: number[] = [];
      const n: number[] = [];
      // 8 mm out, moved 13 mm in: 5 mm inside the skin.
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, p);
        nor.getElement(i, n);
        pos.setElement(i, [p[0]! - n[0]! * 0.013, p[1]! - n[1]! * 0.013, p[2]! - n[2]! * 0.013]);
      }
    }
    const hides: Region[] = [];
    expect(clippingOf(kits.feminine, fit, hides).through).toBeGreaterThan(100);
    const r = pushOut(kits.feminine, fit, hides, WARDROBE_SHAPES.slice(0, 1));
    expect(r.clipping.through).toBe(0);
    expect(r.moved).toBeGreaterThan(100);
    expect(r.largestMm).toBeLessThanOrEqual(PUSH_LIMIT * 1000);
  }, 120_000);

  it('hides a region only where every body has it covered, a side only with its pair', () => {
    const whole = { chest: 1, belly: 1, upper_arm_l: 1, upper_arm_r: 1, lower_leg_l: 1, lower_leg_r: 0.98 } as Partial<Record<Region, number>>;
    expect(wardrobeHides([{ covered: whole, deleted: { hips: 1 } }, { covered: whole, deleted: { hips: 1 } }, { covered: { ...whole, belly: 0.99 }, deleted: { hips: 0.99 } }])).toEqual(['chest', 'upper_arm_l', 'upper_arm_r']);
    // MakeHuman's delete group counts as covered.
    expect(wardrobeHides([{ covered: {}, deleted: { foot_l: 1, foot_r: 0.996 } }])).toEqual(['foot_l', 'foot_r']);
  });

  it('paints a logo out of a texture, the cloth round it kept', () => {
    const [w, h] = [64, 64];
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([236 + (i % 7), 236, 238, 255], i * 4);
    // An orange mark and a grey letter inside the box.
    for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) data.set([240, 140, 40, 255], (y * w + x) * 4);
    for (let y = 22; y < 28; y++) for (let x = 34; x < 38; x++) data.set([130, 135, 135, 255], (y * w + x) * 4);
    const img = { width: w, height: h, data };
    const outside = data.slice(0, 16 * w * 4);
    expect(paintOut(img, [[0.25, 0.25, 0.75, 0.75]])).toBeGreaterThan(100);
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
      expect(Math.max(r, g, b)).toBeGreaterThan(220);
    }
    expect(data.slice(0, 16 * w * 4)).toEqual(outside);
  });
});
