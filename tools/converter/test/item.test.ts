// SPDX-License-Identifier: MPL-2.0
// Items for the three standard bodies (S5.02): the test tee (S5.01's test garment, made on all three
// kits by scripts/make-test-item.ts) converts into one fit per body with nothing out through it in
// the reference poses; a garment made inside the body, a fit made on another body, a slot's caps
// broken, a bone the kits lack and a declaration that does not read are each refused with a reason.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, type BodyKit, checkItemFit, checkItemManifest, readGltf } from '@flatchat/content';
import type { Document } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { avatarIO, readAvatarLevel } from '../src/avatar/convert.ts';
import { type KitBody, kitBody } from '../src/item/clipping.ts';
import { convertItem, ItemError } from '../src/item/convert.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEE = new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb')));
const kits: Partial<Record<BodyKit, KitBody>> = {};
beforeAll(async () => {
  for (const body of BODY_KITS) {
    const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', body, `${body}.vrm`))));
    kits[body] = kitBody(body, doc, data);
  }
}, 60_000);

/** The tee, changed. */
async function tee(change: (doc: Document) => void): Promise<Uint8Array> {
  const io = avatarIO();
  const doc = await io.readBinary(TEE);
  change(doc);
  return io.writeBinary(doc);
}
const declare = (doc: Document, d: Record<string, unknown>): void => {
  const scene = doc.getRoot().listScenes()[0]!;
  scene.setExtras({ flatchat_item: { ...(scene.getExtras()['flatchat_item'] as object), ...d } });
};
const refused = async (bytes: Uint8Array): Promise<string> => {
  try {
    await convertItem(bytes, { ktx2: false, kits });
  } catch (err) {
    if (err instanceof ItemError) return err.problems.join(' | ');
    throw err;
  }
  throw new Error('it converted');
};

describe('the test tee', () => {
  it('converts into a fit for each body, each passing the client check, nothing out through it', async () => {
    const r = await convertItem(TEE, { ktx2: false, kits });
    expect(checkItemManifest(JSON.parse(new TextDecoder().decode(r.manifestBytes)))).toMatchObject({ slot: 'top', hides: ['belly', 'chest', 'upper_arm_l', 'upper_arm_r'] });
    expect(Object.keys(r.manifest.fits).sort()).toEqual([...BODY_KITS]);
    for (const body of BODY_KITS) {
      const fit = r.manifest.fits[body]!;
      expect(() => checkItemFit(readGltf(r.files.get(fit.file)!, 'fit.glb').json as unknown as Record<string, unknown>)).not.toThrow();
      expect(fit.triangles).toBeLessThanOrEqual(8_000);
      expect(r.manifest.clipping[body]).toMatchObject({ poses: 7, through: 0 });
    }
    expect(r.manifest.warnings).toEqual([]);
  }, 60_000);
});

describe('an item is refused', () => {
  it('when its garment is made inside the body, over skin it leaves visible', async () => {
    const bytes = await tee((doc) => {
      for (const node of doc.getRoot().listNodes()) {
        if (!node.getExtras()['flatchat_fit']) continue;
        for (const prim of node.getMesh()!.listPrimitives()) {
          const pos = prim.getAttribute('POSITION')!;
          const nor = prim.getAttribute('NORMAL')!;
          const p: number[] = [];
          const n: number[] = [];
          for (let i = 0; i < pos.getCount(); i++) {
            pos.getElement(i, p);
            nor.getElement(i, n);
            pos.setElement(i, [p[0]! - n[0]! * 0.014, p[1]! - n[1]! * 0.014, p[2]! - n[2]! * 0.014]);
          }
        }
      }
      declare(doc, { hides: ['chest', 'upper_arm_l', 'upper_arm_r'] });
    });
    expect(await refused(bytes)).toMatch(/come out through it/);
  }, 60_000);

  it('when a fit was made on another body', async () => {
    const bytes = await tee((doc) => {
      for (const node of doc.getRoot().listNodes()) {
        const fit = node.getExtras()['flatchat_fit'];
        if (fit === 'feminine') node.setExtras({ flatchat_fit: 'masculine' });
        else if (fit === 'masculine') node.setExtras({ flatchat_fit: 'feminine' });
      }
    });
    expect(await refused(bytes)).toMatch(/was not made on kits\/bodies\/(feminine|masculine)/);
  }, 60_000);

  it('when it breaks its slot\'s caps', async () => {
    expect(await refused(await tee((doc) => declare(doc, { slot: 'glasses' })))).toMatch(/3630 triangles, more than a glasses may \(1500\)/);
  });

  it('when a fit is skinned to a bone the kits do not have', async () => {
    const bytes = await tee((doc) => {
      const node = doc.getRoot().listNodes().find((n) => n.getExtras()['flatchat_fit'] === 'neutral')!;
      node.getSkin()!.listJoints().find((j) => j.getName() === 'head')!.setName('tail_01');
    });
    expect(await refused(bytes)).toMatch(/bones the kits do not have \(tail_01\)/);
  });

  it('when its declaration does not read', async () => {
    const problems = await refused(await tee((doc) => declare(doc, { name: '', slot: 'cape', hides: ['tail'] })));
    expect(problems).toMatch(/a name of 1 to 80 characters/);
    expect(problems).toMatch(/slot "cape" is not one of/);
    expect(problems).toMatch(/"tail" is not a region/);
  });
});
