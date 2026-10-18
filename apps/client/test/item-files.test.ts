// SPDX-License-Identifier: MPL-2.0
// The upload dialogs' files (S5.08), without a window: an upload is named after its file; an item's
// file that declares itself (a GLB whose scene carries its declaration, a .blend) goes at once, and
// one that cannot (an FBX, an OBJ, a DAE, a GLB that says nothing) waits for the declaration the
// page asks for, by a token that works once and not after a while.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleProp } from '@flatchat/converter/item-samples';
import { sampleDae, SAMPLE_PROP_DECLARATION } from '@flatchat/converter/format-samples';
import { describe, expect, it } from 'vitest';
import { declaresItself, modelName, PENDING_MS, PendingItems } from '../src/main/item-files';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('an upload’s file', () => {
  it('names the upload, without its extension', () => {
    expect(modelName('/home/me/Linen shirt.FBX')).toBe('Linen shirt');
    expect(modelName(join('models', 'cap.blend'))).toBe('cap');
    expect(modelName('/tmp/odd.name.dae')).toBe('odd.name');
    expect(modelName('/tmp/notes.txt')).toBe('notes.txt');
  });

  it('declares an item itself as a GLB with its declaration or a .blend, never as an FBX, OBJ or DAE', async () => {
    expect(declaresItself(new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb'))))).toBe(true);
    expect(declaresItself(await sampleProp(SAMPLE_PROP_DECLARATION))).toBe(true);
    expect(declaresItself(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0))).toBe(true);
    expect(declaresItself(new Uint8Array(readFileSync(join(ROOT, 'tools', 'converter', 'test', 'fixtures', 'formats', 'prop-obj.glb'))))).toBe(false);
    expect(declaresItself(text('Kaydara FBX Binary  \0\u001a\0'))).toBe(false);
    expect(declaresItself(text('o cap\nv 0 0 0\n'))).toBe(false);
    expect(declaresItself(await sampleDae('prop'))).toBe(false);
    // Not a model at all: the converter says why.
    expect(declaresItself(text('just some text'))).toBe(true);
  });
});

describe('an item waiting for its declaration', () => {
  it('is taken once by its token, and not after a while', () => {
    let now = 1_000_000;
    const pending = new PendingItems(() => now);
    const a = pending.add('/tmp/a.fbx');
    const b = pending.add('/tmp/b.obj');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(pending.take(a)).toBe('/tmp/a.fbx');
    expect(pending.take(a)).toBeUndefined();
    expect(pending.take('nope')).toBeUndefined();
    expect(pending.take(42)).toBeUndefined();
    now += PENDING_MS + 1;
    expect(pending.take(b)).toBeUndefined();
  });
});
