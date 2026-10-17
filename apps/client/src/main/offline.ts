// SPDX-License-Identifier: MPL-2.0
// Offline mode (S2.13, Q-D6, T-08): a world on this computer with no core. The main process runs a
// world server (the same code hosts run) over an in-process link to the page, and seals the
// player's connect token itself with a key it makes for each visit, so the player is a guest. The
// worlds are the kits built into the app (resources/offline, from scripts/offline-worlds.ts) and
// any world folder the player opens, converted here with the host tool's converter (into the app's
// data folder, once per folder and change).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { newWorldKey, sealToken } from '@flatchat/protocol';
import { ContentServer, loadBuiltWorld } from '@flatchat/world-server/content';
import { type LocalLink, LocalTransport } from '@flatchat/world-server/local';
import { WalkableSurface } from '@flatchat/world-server/navigation';
import { builtOptions, DEFAULT_SERVER, WorldServer } from '@flatchat/world-server/server';

export interface OfflineWorld {
  /** `kit:NAME` for a built-in world, `folder:N` for a folder the player opened. */
  id: string;
  name: string;
}

type Channel = 'reliable' | 'unreliable';

/** The built-in worlds' names from their world.json, and the folders asked for. */
export function listOffline(kits: string, folders: readonly string[]): OfflineWorld[] {
  const out: OfflineWorld[] = [];
  if (existsSync(kits)) {
    for (const kit of readdirSync(kits).sort()) {
      try {
        const w = JSON.parse(readFileSync(join(kits, kit, 'world.json'), 'utf8')) as { manifest?: { name?: unknown } };
        out.push({ id: `kit:${kit}`, name: typeof w.manifest?.name === 'string' ? w.manifest.name.slice(0, 48) : kit });
      } catch {
        // not a built world
      }
    }
  }
  folders.forEach((f, i) => out.push({ id: `folder:${i}`, name: basename(f).slice(0, 48) }));
  return out;
}

export class OfflineHost {
  private readonly kits: string;
  private readonly folders: readonly string[];
  private readonly cache: string;
  private server: WorldServer | undefined;
  private transport: LocalTransport | undefined;
  private link: LocalLink | undefined;
  private walkable: WalkableSurface | undefined;
  private readonly key = newWorldKey();

  /** `kits`: the built-in worlds; `folders`: folders to convert; `cache`: where conversions go. */
  constructor(kits: string, folders: readonly string[], cache: string) {
    this.kits = kits;
    this.folders = folders;
    this.cache = cache;
  }

  /** The built world's folder for an offline world, converting a folder first when needed. */
  private async built(id: string): Promise<string> {
    if (id.startsWith('kit:')) {
      const dir = join(this.kits, id.slice(4));
      if (!/^kit:[a-z0-9-]+$/.test(id) || !existsSync(join(dir, 'world.json'))) throw new Error('no such world');
      return dir;
    }
    const folder = this.folders[Number(id.slice(7))];
    if (!folder) throw new Error('no such world');
    // A folder converts once per change: the cache is named by its path and newest file.
    const newest = readdirSync(folder, { recursive: true }).reduce((t, f) => Math.max(t, statSync(join(folder, String(f))).mtimeMs), 0);
    const out = join(this.cache, createHash('sha256').update(`${folder}\n${newest}`).digest('hex').slice(0, 24));
    if (!existsSync(join(out, 'world.json'))) {
      const { convertWorld, readFolder, writeBuilt } = await import('@flatchat/converter');
      const { out: files } = await convertWorld(readFolder(folder), { ktx2: false });
      writeBuilt(out, files);
    }
    return out;
  }

  /** Starts the world and returns the guest's connect token for it. */
  async start(id: string): Promise<{ token: Uint8Array; name: string }> {
    await this.stop();
    const loaded = await loadBuiltWorld(await this.built(id));
    const navmesh = loaded.world.navmesh ? loaded.files.get(loaded.world.navmesh) : undefined;
    this.walkable = navmesh ? await WalkableSurface.load(new Uint8Array(await readFile(navmesh.path))) : undefined;
    const worldId = randomUUID();
    this.transport = new LocalTransport();
    this.server = new WorldServer(
      { ...DEFAULT_SERVER, ...builtOptions(loaded, new ContentServer(loaded)), worldId, worldKey: this.key, build: 'flatchat-offline', metricsEverySec: 0, log: () => {}, ...(this.walkable ? { walkable: this.walkable } : {}) },
      [this.transport],
    );
    this.server.start();
    const token = await sealToken(
      { account: randomUUID(), name: 'Guest', trust: 0, tester: false, emailVerified: false, under18: false, ageDays: 0, owner: true, contact: 'everyone', friends: [], blocks: [] },
      { key: this.key, world: worldId, expiresAt: Math.floor(Date.now() / 1000) + 60 },
    );
    return { token, name: loaded.world.manifest.name };
  }

  /** The page's end of the link: what the world sends goes to `deliver`. */
  open(deliver: (channel: Channel, bytes: Uint8Array) => void, ended: (reason: string) => void): void {
    this.link?.close('another page joined');
    this.link = this.transport?.connect(deliver, ended);
  }

  receive(channel: Channel, bytes: Uint8Array): void {
    this.link?.receive(channel, bytes);
  }

  async stop(): Promise<void> {
    this.link?.close('left the offline world');
    this.link = undefined;
    await this.server?.stop('offline world closed');
    this.server = undefined;
    this.walkable?.dispose();
    this.walkable = undefined;
  }
}
