// SPDX-License-Identifier: MPL-2.0
// Model files the upload dialogs pick (S5.08): what they are called, and whether an item's file
// says what it is itself. A GLB whose scene carries its declaration does, and so does a .blend
// (Blender keeps the scene's custom property, and the core's Blender writes it out); an FBX, an OBJ
// or a DAE cannot, so the page asks for its name, slot and the body it covers before it is sent.
// An item picked that way waits here, by a token the page holds, for a while.
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { fileDeclaration, MODEL_EXTENSIONS, readGltf, type UploadFormat, uploadFormat } from '@flatchat/content';

/** The name an upload is given: its file's, without the extension. */
export function modelName(path: string): string {
  return basename(path).replace(new RegExp(`\\.(${MODEL_EXTENSIONS.join('|')})$`, 'i'), '');
}

/** Whether an item's file declares itself; a file that is no model the converter says why. */
export function declaresItself(bytes: Uint8Array): boolean {
  const format = uploadFormat(bytes);
  if (format === 'blend' || format === 'unknown') return true;
  if (format !== 'gltf') return false;
  try {
    return fileDeclaration(readGltf(bytes, 'item.glb').json as unknown as Record<string, unknown>) !== undefined;
  } catch {
    return true;
  }
}

export const PENDING_MS = 15 * 60_000;

/** Item files waiting for the declaration the page asks for. */
export class PendingItems {
  private readonly files = new Map<string, { path: string; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Keeps a file for a while; the token the page sends back with its declaration. */
  add(path: string): string {
    for (const [k, v] of this.files) if (this.now() - v.at > PENDING_MS) this.files.delete(k);
    const token = randomBytes(16).toString('hex');
    this.files.set(token, { path, at: this.now() });
    return token;
  }

  /** The file a token names, once: undefined when it is unknown or waited too long. */
  take(token: unknown): string | undefined {
    if (typeof token !== 'string') return undefined;
    const f = this.files.get(token);
    this.files.delete(token);
    return f && this.now() - f.at <= PENDING_MS ? f.path : undefined;
  }
}

/** What the page is told about an item file that needs its declaration. */
export interface NeedsDeclaration {
  ok: false;
  error: 'needs-declaration';
  token: string;
  name: string;
  format: UploadFormat;
}
