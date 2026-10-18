// SPDX-License-Identifier: Apache-2.0
// A built world (S2.03): what the converter makes from a world folder and a world server serves.
// `world.json` holds the manifest, each scene's markers in world space and the list of content
// files, each named by its SHA-256 (the visual GLB, the collision file, the navigation mesh, the
// sounds). Clients download it from strangers' servers, so `parseBuiltWorld` checks every field.
import { plainText, WORLD_FORMAT, type WorldManifest } from './manifest.ts';
import { isPart, MAX_PARTS } from './parts.ts';

export const BUILT_FORMAT = 1;

export type BuiltKind = 'scene' | 'collision' | 'navmesh' | 'audio' | 'effect';

export interface BuiltFile {
  hash: string;
  size: number;
  kind: BuiltKind;
}

export type V3 = [number, number, number];

export interface BuiltSpawn {
  position: V3;
  yaw: number;
  title: string;
  group: string;
}

export interface BuiltSeat {
  position: V3;
  yaw: number;
}

/** A box turned only about y: a portal or a zone. `half` is half its size in metres. */
export interface BuiltBox {
  center: V3;
  half: V3;
  yaw: number;
}

export interface BuiltPortal extends BuiltBox {
  world: string;
  spawn: string;
}

export interface BuiltZone extends BuiltBox {
  kind: 'voice' | 'quiet' | 'private';
  range?: number;
  gain?: number;
}

export interface BuiltEmitter {
  position: V3;
  /** The sound file's hash. */
  audio: string;
  positional: boolean;
  gain: number;
  loop: boolean;
  autoPlay: boolean;
  /** Metres within which it plays at full volume, and beyond which it is silent. */
  refDistance: number;
  maxDistance: number;
}

/** A base library part where a scene places it (S2.05): drawn by the client from its own library. */
export interface BuiltPart {
  id: string;
  position: V3;
  /** A quaternion (x, y, z, w). */
  rotation: [number, number, number, number];
  scale: V3;
}

/** A world's effect (S6.01): its bundle, where it plays (a column-major 4×4), its scale, and what the
 *  host tool's dry run measured. Clients measure it again themselves: a host is not trusted. */
export interface BuiltEffect {
  file: string;
  matrix: number[];
  scale: number;
  peak: { instances: number; quads: number; triangles: number };
}

export interface BuiltScene {
  id: string;
  /** The scene's visual GLB. */
  glb: string;
  spawns: BuiltSpawn[];
  seats: BuiltSeat[];
  portals: BuiltPortal[];
  zones: BuiltZone[];
  emitters: BuiltEmitter[];
  /** Base library parts (S2.05); none in a world built before them. */
  parts: BuiltPart[];
  /** Effects (S6.01); none in a world built before them. */
  effects: BuiltEffect[];
  triangles: number;
}

export interface BuiltWorld {
  format: number;
  manifest: WorldManifest;
  scenes: BuiltScene[];
  collision: string;
  navmesh?: string;
  /** The world's bounds in x and z, for the server's clamp. */
  bounds: { min: V3; max: V3 };
  files: BuiltFile[];
}

const LIMIT = { scenes: 16, files: 4096, markers: 1000, fileSize: 256 * 1024 * 1024 };

class Bad extends Error {}

const fail = (at: string, why: string): never => {
  throw new Bad(`${at}: ${why}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, at: string, min = -1e6, max = 1e6): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(at, `a number from ${min} to ${max}`));
const bool = (v: unknown, at: string): boolean => (typeof v === 'boolean' ? v : fail(at, 'true or false'));
const hash = (v: unknown, at: string): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : fail(at, 'a SHA-256 in hexadecimal'));
const text = (v: unknown, at: string, max = 128): string => (typeof v === 'string' && [...v].length <= max && plainText(v) ? v : fail(at, `plain text of at most ${max} characters`));
const v3 = (v: unknown, at: string, min = -1e6, max = 1e6): V3 => {
  if (!Array.isArray(v) || v.length !== 3) return fail(at, 'three numbers');
  return [num(v[0], at, min, max), num(v[1], at, min, max), num(v[2], at, min, max)];
};
const list = <T>(v: unknown, at: string, max: number, each: (x: unknown, at: string) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) return fail(at, `a list of at most ${max}`);
  return v.map((x, i) => each(x, `${at}[${i}]`));
};
const box = (v: Record<string, unknown>, at: string): BuiltBox => ({ center: v3(v['center'], `${at}.center`), half: v3(v['half'], `${at}.half`, 0.001, 1e4), yaw: num(v['yaw'], `${at}.yaw`, -10, 10) });

function manifestOf(v: unknown, at: string): WorldManifest {
  if (!isObj(v)) return fail(at, 'an object');
  const cap = isObj(v['capacity']) ? v['capacity'] : fail(`${at}.capacity`, 'an object');
  const av = isObj(v['avatars']) ? v['avatars'] : fail(`${at}.avatars`, 'an object');
  const voice = isObj(v['voice']) ? v['voice'] : fail(`${at}.voice`, 'an object');
  const persistence = v['persistence'] === 'reset' || v['persistence'] === 'persistent' ? v['persistence'] : fail(`${at}.persistence`, 'reset or persistent');
  return {
    format: v['format'] === WORLD_FORMAT ? WORLD_FORMAT : fail(`${at}.format`, `world format ${WORLD_FORMAT}`),
    name: text(v['name'], `${at}.name`, 48),
    description: text(v['description'], `${at}.description`, 280),
    capacity: { recommended: num(cap['recommended'], `${at}.capacity.recommended`, 1, 1000), maximum: num(cap['maximum'], `${at}.capacity.maximum`, 1, 1000) },
    persistence,
    flying: bool(v['flying'], `${at}.flying`),
    avatars: { minHeight: num(av['minHeight'], `${at}.avatars.minHeight`, 0.1, 20), maxHeight: num(av['maxHeight'], `${at}.avatars.maxHeight`, 0.1, 20) },
    voice: { range: num(voice['range'], `${at}.voice.range`, 1, 100) },
    scenes: list(v['scenes'], `${at}.scenes`, LIMIT.scenes, (s, a) => (isObj(s) ? { id: text(s['id'], `${a}.id`, 32), file: text(s['file'], `${a}.file`, 256) } : fail(a, 'an object'))),
  };
}

/** Checks a world.json from anywhere; returns it, or the first thing wrong with it. */
export function parseBuiltWorld(json: unknown): { world: BuiltWorld } | { error: string } {
  try {
    if (!isObj(json)) fail('world.json', 'an object');
    const j = json as Record<string, unknown>;
    if (j['format'] !== BUILT_FORMAT) fail('format', `built format ${BUILT_FORMAT}`);
    const files = list(j['files'], 'files', LIMIT.files, (f, at) => {
      if (!isObj(f)) return fail(at, 'an object');
      const kind = f['kind'];
      if (kind !== 'scene' && kind !== 'collision' && kind !== 'navmesh' && kind !== 'audio' && kind !== 'effect') fail(`${at}.kind`, 'scene, collision, navmesh, audio or effect');
      return { hash: hash(f['hash'], `${at}.hash`), size: num(f['size'], `${at}.size`, 0, LIMIT.fileSize), kind: kind as BuiltKind };
    });
    const known = new Set(files.map((f) => f.hash));
    const listed = (h: string, at: string): string => (known.has(h) ? h : fail(at, 'a file the list does not have'));
    const scenes = list(j['scenes'], 'scenes', LIMIT.scenes, (s, at) => {
      if (!isObj(s)) return fail(at, 'an object');
      return {
        id: text(s['id'], `${at}.id`, 32),
        glb: listed(hash(s['glb'], `${at}.glb`), `${at}.glb`),
        spawns: list(s['spawns'], `${at}.spawns`, LIMIT.markers, (p, a) =>
          isObj(p) ? { position: v3(p['position'], `${a}.position`), yaw: num(p['yaw'], `${a}.yaw`, -10, 10), title: text(p['title'], `${a}.title`), group: text(p['group'], `${a}.group`) } : fail(a, 'an object'),
        ),
        seats: list(s['seats'], `${at}.seats`, LIMIT.markers, (p, a) => (isObj(p) ? { position: v3(p['position'], `${a}.position`), yaw: num(p['yaw'], `${a}.yaw`, -10, 10) } : fail(a, 'an object'))),
        portals: list(s['portals'], `${at}.portals`, 256, (p, a) =>
          isObj(p) ? { ...box(p, a), world: typeof p['world'] === 'string' && /^[0-9a-f-]{36}$/.test(p['world']) ? p['world'] : fail(`${a}.world`, 'a world id'), spawn: text(p['spawn'], `${a}.spawn`) } : fail(a, 'an object'),
        ),
        zones: list(s['zones'], `${at}.zones`, 256, (z, a) => {
          if (!isObj(z)) return fail(a, 'an object');
          const kind: BuiltZone['kind'] = z['kind'] === 'voice' || z['kind'] === 'quiet' || z['kind'] === 'private' ? z['kind'] : fail(`${a}.kind`, 'voice, quiet or private');
          return {
            ...box(z, a),
            kind,
            ...(z['range'] !== undefined ? { range: num(z['range'], `${a}.range`, 1, 200) } : {}),
            ...(z['gain'] !== undefined ? { gain: num(z['gain'], `${a}.gain`, 0, 4) } : {}),
          };
        }),
        emitters: list(s['emitters'], `${at}.emitters`, 256, (e, a) =>
          isObj(e)
            ? {
                position: v3(e['position'], `${a}.position`),
                audio: listed(hash(e['audio'], `${a}.audio`), `${a}.audio`),
                positional: bool(e['positional'], `${a}.positional`),
                gain: num(e['gain'], `${a}.gain`, 0, 4),
                loop: bool(e['loop'], `${a}.loop`),
                autoPlay: bool(e['autoPlay'], `${a}.autoPlay`),
                refDistance: num(e['refDistance'], `${a}.refDistance`, 0.01, 1000),
                maxDistance: num(e['maxDistance'], `${a}.maxDistance`, 0.01, 10_000),
              }
            : fail(a, 'an object'),
        ),
        parts:
          s['parts'] === undefined
            ? []
            : list(s['parts'], `${at}.parts`, MAX_PARTS, (p, a) => {
                if (!isObj(p)) return fail(a, 'an object');
                const r = Array.isArray(p['rotation']) && p['rotation'].length === 4 ? p['rotation'] : fail(`${a}.rotation`, 'four numbers');
                return {
                  id: isPart(p['id']) ? p['id'] : fail(`${a}.id`, "one of the base library's parts"),
                  position: v3(p['position'], `${a}.position`),
                  rotation: [num(r[0], `${a}.rotation`, -1, 1), num(r[1], `${a}.rotation`, -1, 1), num(r[2], `${a}.rotation`, -1, 1), num(r[3], `${a}.rotation`, -1, 1)] as [number, number, number, number],
                  scale: v3(p['scale'], `${a}.scale`, 0.01, 100),
                };
              }),
        effects:
          s['effects'] === undefined
            ? []
            : list(s['effects'], `${at}.effects`, 64, (e, a) => {
                if (!isObj(e)) return fail(a, 'an object');
                const m = Array.isArray(e['matrix']) && e['matrix'].length === 16 ? e['matrix'] : fail(`${a}.matrix`, 'sixteen numbers');
                const p = isObj(e['peak']) ? e['peak'] : fail(`${a}.peak`, 'an object');
                return {
                  file: listed(hash(e['file'], `${a}.file`), `${a}.file`),
                  matrix: m.map((x, i) => num(x, `${a}.matrix[${i}]`)),
                  scale: num(e['scale'], `${a}.scale`, 0.01, 100),
                  peak: { instances: num(p['instances'], `${a}.peak.instances`, 0, 1e6), quads: num(p['quads'], `${a}.peak.quads`, 0, 1e7), triangles: num(p['triangles'], `${a}.peak.triangles`, 0, 1e8) },
                };
              }),
        triangles: num(s['triangles'], `${at}.triangles`, 0, 4_000_000),
      };
    });
    if (scenes.length === 0) fail('scenes', 'at least one');
    if (!scenes[0]!.spawns.length) fail('scenes[0].spawns', 'at least one spawn point');
    const bounds = isObj(j['bounds']) ? j['bounds'] : fail('bounds', 'an object');
    return {
      world: {
        format: BUILT_FORMAT,
        manifest: manifestOf(j['manifest'], 'manifest'),
        scenes,
        collision: listed(hash(j['collision'], 'collision'), 'collision'),
        ...(j['navmesh'] !== undefined ? { navmesh: listed(hash(j['navmesh'], 'navmesh'), 'navmesh') } : {}),
        bounds: { min: v3(bounds['min'], 'bounds.min'), max: v3(bounds['max'], 'bounds.max') },
        files,
      },
    };
  } catch (err) {
    if (err instanceof Bad) return { error: err.message };
    throw err;
  }
}

/** Whether a point is inside a box turned about y (portals and zones). */
export function insideBox(b: BuiltBox, p: { x: number; y: number; z: number }): boolean {
  const dx = p.x - b.center[0];
  const dz = p.z - b.center[2];
  const c = Math.cos(-b.yaw);
  const s = Math.sin(-b.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= b.half[0] && Math.abs(p.y - b.center[1]) <= b.half[1] && Math.abs(lz) <= b.half[2];
}
