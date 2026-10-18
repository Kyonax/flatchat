// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's avatar files. The crowd bench (--crowd) reads VRM files from the one folder the
// command line names (--avatars=DIR), through a read-only protocol, flatchat-avatar://bench/,
// registered only in that mode: the sandboxed page cannot read files itself. It serves index.json
// (each .vrm's name and size, from the folder and its subfolders one level down) and exactly the
// files that list names, nothing else: no other paths, no writing. Avatars will reach a real client
// the same way, fetched by the main process and handed to the page (the plan's ASSETs AND CONVERSION).
// This file is free of Electron, for the tests; avatar-protocol.ts registers and serves the scheme.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const AVATAR_SCHEME = 'flatchat-avatar';

export interface AvatarFile {
  /** Relative to the folder, with '/' between a subfolder and its file. */
  name: string;
  bytes: number;
}

/** The .vrm files in `dir` and in its subfolders one level down, sorted by name; and a
 *  subfolder's manifest.json (a converted avatar's, for the converted crowd, S4.12). */
export function listAvatars(dir: string): AvatarFile[] {
  const out: AvatarFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.vrm$/i.test(entry.name)) out.push({ name: entry.name, bytes: statSync(join(dir, entry.name)).size });
    if (entry.isDirectory()) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile() && (/\.vrm$/i.test(inner.name) || inner.name === 'manifest.json')) out.push({ name: `${entry.name}/${inner.name}`, bytes: statSync(join(dir, entry.name, inner.name)).size });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a request asks for: the index, one listed file, or nothing (pure, for the tests). */
export function resolveAvatarRequest(url: string, files: readonly AvatarFile[]): { kind: 'index' } | { kind: 'file'; name: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== `${AVATAR_SCHEME}:` || u.hostname !== 'bench' || u.search || u.hash) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  if (path === '/index.json') return { kind: 'index' };
  // Only a name the folder listing produced: nothing built from the request reaches the file system.
  const name = path.slice(1);
  return files.some((f) => f.name === name) ? { kind: 'file', name } : undefined;
}
