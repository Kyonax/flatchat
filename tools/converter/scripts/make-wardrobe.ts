// SPDX-License-Identifier: MPL-2.0
// The starter wardrobe (Track P's P.08), from start to finish: MakeHuman's CC0 garments fitted to
// the three bodies in headless Blender (tools/blender/wardrobe/fit.py, with the body kits' pinned
// Blender, MPFB and VRM Add-on), then each made into an item (src/item/wardrobe.ts): its fit cut
// from each body's export, simplified under its slot's caps, given the skin's weights and pushed
// out wherever skin still came through, its texture fitted (MakeHuman's logo painted out of the
// tee), the three fits joined into one file that declares itself, and the file checked: the item
// converter takes it with no warning, and on every body no skin comes through in the seven
// reference poses as made and at both ends of the sliders (P.08's Verify). kits/items/<id>/<id>.glb,
// kits/items/wardrobe.json and kits/items/fingerprints.json (each item's fingerprint, S5.09: what a
// starter item explains is no evidence of a copy) are written only when every garment passes.
//
//   node tools/converter/scripts/make-wardrobe.ts
//
// Blender and its add-ons are the body kits' own: node tools/blender/bodykit/run.mts --setup.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, type BodyKit, type Fingerprint, type ItemClipping, type Region } from '@flatchat/content';
import type { Document, Node } from '@gltf-transform/core';
import { cloneDocument, dedup, mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { avatarIO, readAvatarLevel } from '../src/avatar/convert.ts';
import { clippingOf, coverageOf, type KitBody, kitBody } from '../src/item/clipping.ts';
import { convertItem, ItemError } from '../src/item/convert.ts';
import { pushOut, STARTER_WARDROBE, underCap, WARDROBE_AUTHORS, WARDROBE_LEFT_OUT, WARDROBE_SHAPES, wardrobeHides, wardrobeMaterial, weightsFromSkin } from '../src/item/wardrobe.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOME = process.env['FLATCHAT_BLENDER_HOME'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender');
const BLENDER = join(HOME, 'blender-5.2.2-linux-x64', 'blender');
const OUT = join(ROOT, 'kits', 'items');

const say = (line: string): void => void process.stdout.write(`wardrobe: ${line}\n`);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const triangles = (n: Node): number => n.getMesh()!.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0);

/** What wardrobe.json says of each garment. */
interface Listed {
  id: string;
  name: string;
  from: string;
  slot: string;
  hides: Region[];
  file: string;
  sha256: string;
  bytes: number;
  fits: Record<string, { triangles: number; pushed: { vertices: number; largestMm: number }; clipping: ItemClipping }>;
  minutesByHand: number;
}

async function main(): Promise<number> {
  if (!existsSync(BLENDER)) {
    console.error('wardrobe: Blender is not set up: node tools/blender/bodykit/run.mts --setup');
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), 'wardrobe-'));
  try {
    say(`fitting ${STARTER_WARDROBE.length} garments on the three bodies in Blender`);
    execFileSync(BLENDER, ['--background', '--python', join(ROOT, 'tools', 'blender', 'wardrobe', 'fit.py'), '--', '--out', work, '--garments', STARTER_WARDROBE.map((g) => g.from).join(',')], {
      env: { ...process.env, BLENDER_USER_RESOURCES: join(HOME, 'user') },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const kits = {} as Record<BodyKit, KitBody>;
    const fitted = {} as Record<BodyKit, Document>;
    const deleted = {} as Record<BodyKit, Record<string, Partial<Record<Region, number>>>>;
    for (const b of BODY_KITS) {
      const kit = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', b, `${b}.vrm`))));
      kits[b] = kitBody(b, kit.doc, kit.data);
      fitted[b] = (await readAvatarLevel(new Uint8Array(readFileSync(join(work, `${b}.vrm`))))).doc;
      deleted[b] = JSON.parse(readFileSync(join(work, `${b}-garments.json`), 'utf8')) as Record<string, Partial<Record<Region, number>>>;
    }
    const io = avatarIO();
    const items: Array<{ listed: Listed; bytes: Uint8Array; fingerprint: Fingerprint | undefined }> = [];
    let ok = true;
    for (const g of STARTER_WARDROBE) {
      // Each body's fit alone, simplified under the slot's caps where it is over them.
      const fits = new Map<BodyKit, { doc: Document; node: Node }>();
      for (const b of BODY_KITS) {
        const doc = cloneDocument(fitted[b]);
        const root = doc.getRoot();
        const node = root.listNodes().find((n) => n.getName() === g.from && n.getMesh() && n.getSkin());
        if (!node) throw new Error(`${g.from}: not in the ${b} body's export`);
        for (const n of root.listNodes()) if (n !== node && n.getMesh()) n.setMesh(null).setSkin(null);
        for (const e of root.listExtensionsUsed()) e.dispose();
        for (const s of root.listScenes()) s.setExtras({});
        node.setName(`${g.id}_${b}`).setExtras({ flatchat_fit: b });
        node.getMesh()!.setName(`${g.id}_${b}`);
        await underCap(node, g.slot);
        fits.set(b, { doc, node });
      }
      // What it hides: what it covers on every body.
      const hides = wardrobeHides(BODY_KITS.map((b) => ({ covered: coverageOf(kits[b], fits.get(b)!.node), deleted: deleted[b][g.from] ?? {} })));
      const listedFits: Listed['fits'] = {};
      for (const b of BODY_KITS) {
        const { doc, node } = fits.get(b)!;
        weightsFromSkin(kits[b], node);
        const pushed = pushOut(kits[b], node, hides, WARDROBE_SHAPES);
        wardrobeMaterial(doc, node, g, 1024);
        await doc.transform(prune({ keepLeaves: false, keepAttributes: true }));
        listedFits[b] = { triangles: triangles(node), pushed: { vertices: pushed.moved, largestMm: pushed.largestMm }, clipping: pushed.clipping };
      }
      // The three fits in one file that declares itself.
      const merged = fits.get(BODY_KITS[0])!.doc;
      for (const b of BODY_KITS.slice(1)) mergeDocuments(merged, fits.get(b)!.doc);
      const [scene, ...rest] = merged.getRoot().listScenes();
      for (const s of rest) {
        for (const child of s.listChildren()) scene!.addChild(child);
        s.dispose();
      }
      scene!.setExtras({ flatchat_item: { name: g.name, slot: g.slot, hides, authors: WARDROBE_AUTHORS } });
      await merged.transform(dedup(), prune({ keepLeaves: false, keepAttributes: true }), unpartition());
      const bytes = await io.writeBinary(merged);
      // The converter takes it as an upload, with no warning.
      let fingerprint: Fingerprint | undefined;
      try {
        const r = await convertItem(bytes, { ktx2: false, kits });
        fingerprint = r.fingerprint;
        if (r.manifest.warnings.length) {
          ok = false;
          say(`${g.id}: the converter warns: ${r.manifest.warnings.join('; ')}`);
        }
      } catch (err) {
        ok = false;
        say(`${g.id}: the converter refuses it: ${err instanceof ItemError ? err.problems.join('; ') : String(err)}`);
      }
      // P.08's Verify, on the file as written: no skin through it anywhere.
      const doc = await io.readBinary(bytes);
      for (const n of doc.getRoot().listNodes()) {
        const body = n.getExtras()['flatchat_fit'] as BodyKit | undefined;
        if (!body || !n.getMesh()) continue;
        const c = clippingOf(kits[body], n, hides, { shapes: WARDROBE_SHAPES });
        listedFits[body]!.clipping = c;
        if (c.through > 0) {
          ok = false;
          say(`${g.id}: on the ${body} body, ${c.through} body points come through it (up to ${c.worstMm} mm)`);
        }
      }
      const file = `${g.id}/${g.id}.glb`;
      items.push({ listed: { id: g.id, name: g.name, from: g.from, slot: g.slot, hides, file, sha256: sha(bytes), bytes: bytes.length, fits: listedFits, minutesByHand: 0 }, bytes, fingerprint });
      say(`${g.id}: ${bytes.length} bytes, hides ${hides.join(', ') || 'nothing'}, ${BODY_KITS.map((b) => `${b} ${listedFits[b]!.triangles} triangles`).join(', ')}`);
    }
    if (!ok) {
      console.error('wardrobe: not every garment passed; kits/items/ is left as it was');
      return 1;
    }
    for (const { listed, bytes } of items) {
      mkdirSync(join(OUT, listed.id), { recursive: true });
      writeFileSync(join(OUT, listed.file), bytes);
    }
    const record = {
      made: 'node tools/converter/scripts/make-wardrobe.ts',
      checked: { poses: 7, shapes: WARDROBE_SHAPES },
      items: items.map((i) => i.listed),
      leftOut: WARDROBE_LEFT_OUT,
    };
    writeFileSync(join(OUT, 'wardrobe.json'), `${JSON.stringify(record, null, 1)}\n`);
    writeFileSync(join(OUT, 'fingerprints.json'), `${JSON.stringify(Object.fromEntries(items.map((i) => [i.listed.id, i.fingerprint])))}\n`);
    say(`${items.length} items in kits/items/, recorded in kits/items/wardrobe.json`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = await main();
