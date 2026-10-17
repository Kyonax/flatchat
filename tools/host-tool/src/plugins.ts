// SPDX-License-Identifier: MPL-2.0
// A world folder's plugins (S3.01, S3.05): installing one shows the host what it asks for before it
// ever runs (T-04), and the list says which ones the world server would refuse, and why.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PERMISSION_MEANS, type PluginManifest, parseManifest } from '@flatchat/world-server/plugins';
import { HostError } from './account.ts';

/** The entry rules that come with the world server (S3.05). */
export const BUILT_IN = ['entry-open', 'entry-verified', 'entry-trust'] as const;

export interface WorldPlugin {
  folder: string;
  manifest?: PluginManifest;
  problem?: string;
}

function read(folder: string): PluginManifest {
  const toml = join(folder, 'plugin.toml');
  if (!existsSync(toml)) throw new HostError(`no plugin.toml in ${folder}`);
  try {
    return parseManifest(readFileSync(toml, 'utf8'));
  } catch (err) {
    throw new HostError(`${folder}/plugin.toml: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The plugins in a world folder, each with its plugin.toml or what is wrong with it. */
export function listPlugins(world: string): WorldPlugin[] {
  const dir = join(world, 'plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((f) => statSync(join(dir, f)).isDirectory())
    .map((folder) => {
      try {
        return { folder, manifest: read(join(dir, folder)) };
      } catch (err) {
        return { folder, problem: err instanceof Error ? err.message : String(err) };
      }
    });
}

/** Copies a plugin (a built-in entry rule's name, or a folder) into the world's plugins/ folder. */
export function addPlugin(world: string, from: string, builtIns: string): PluginManifest {
  const source = (BUILT_IN as readonly string[]).includes(from) ? join(builtIns, from) : resolve(from);
  if (!existsSync(join(source, 'plugin.toml'))) throw new HostError(`${from}: not a plugin folder (the built-in entry rules: ${BUILT_IN.join(', ')})`);
  const manifest = read(source);
  if (!existsSync(join(source, manifest.main))) throw new HostError(`${from}: no ${manifest.main}`);
  const to = join(world, 'plugins', manifest.name);
  if (existsSync(to)) throw new HostError(`plugins/${manifest.name} is already in ${world}`);
  cpSync(source, to, { recursive: true });
  return manifest;
}

/** A plugin's facts, as the host reads them before running it. */
export function describePlugin(m: PluginManifest): string[] {
  return [
    `${m.name} ${m.version}${m.description ? `: ${m.description}` : ''}`,
    `  hooks: ${m.hooks.join(', ') || 'none'}`,
    m.permissions.length ? `  asks to: ${m.permissions.map((p) => `${PERMISSION_MEANS[p]} (${p})`).join('; ')}` : '  asks for no permissions',
    ...(Object.keys(m.settings).length ? [`  settings (in its plugin.toml): ${Object.entries(m.settings).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}`] : []),
  ];
}
