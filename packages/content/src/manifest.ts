// SPDX-License-Identifier: Apache-2.0
// A world's world.toml (docs/world-format.md): parsed, checked field by field, and turned into a
// manifest. Every problem names its file and field; an unknown key is a warning, never used.
import { parse, TomlError } from 'smol-toml';

export const WORLD_FORMAT = 1;

export type Severity = 'error' | 'warning';

export interface Problem {
  code: string;
  severity: Severity;
  file: string;
  /** A field in world.toml, or a JSON path in a scene ("nodes[3].extensions.OMI_seat"). */
  at: string;
  message: string;
}

export interface SceneEntry {
  id: string;
  file: string;
}

export interface WorldManifest {
  format: number;
  name: string;
  description: string;
  capacity: { recommended: number; maximum: number };
  persistence: 'reset' | 'persistent';
  flying: boolean;
  avatars: { minHeight: number; maxHeight: number };
  voice: { range: number };
  scenes: SceneEntry[];
}

/** Plain text: no control, format or direction characters. */
export function plainText(text: string): boolean {
  return !/[\p{Cc}\p{Cf}]/u.test(text);
}

/** A relative path that stays inside the world folder. */
export function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 256 || !plainText(path)) return false;
  if (path.startsWith('/') || path.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const KNOWN: Record<string, readonly string[]> = {
  '': ['format', 'name', 'description', 'capacity', 'persistence', 'movement', 'avatars', 'voice', 'scenes'],
  capacity: ['recommended', 'maximum'],
  persistence: ['mode'],
  movement: ['flying'],
  avatars: ['min_height', 'max_height'],
  voice: ['range'],
  scenes: ['id', 'file'],
};

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

export function parseManifest(text: string, file = 'world.toml'): { manifest?: WorldManifest; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (code: string, at: string, message: string, severity: Severity = 'error'): void => void problems.push({ code, severity, file, at, message });
  let doc: Table;
  try {
    doc = parse(text) as Table;
  } catch (err) {
    add('toml-syntax', err instanceof TomlError ? `line ${err.line}` : '', err instanceof Error ? err.message.split('\n')[0]! : 'not TOML');
    return { problems };
  }
  for (const [table, keys] of Object.entries(KNOWN)) {
    const sections = table === '' ? [doc] : table === 'scenes' ? (Array.isArray(doc['scenes']) ? (doc['scenes'] as unknown[]).filter(isTable) : []) : isTable(doc[table]) ? [doc[table] as Table] : [];
    for (const section of sections) {
      for (const key of Object.keys(section)) {
        if (!keys.includes(key)) add('field-unknown', table ? `${table}.${key}` : key, `unknown key ${key}: this version ignores it`, 'warning');
      }
    }
  }
  const num = (v: unknown, at: string, min: number, max: number, fallback: number, integer = false): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      add('field', at, `${at} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
      return fallback;
    }
    return v;
  };
  const table = (key: string): Table => (isTable(doc[key]) ? (doc[key] as Table) : {});

  if (doc['format'] !== WORLD_FORMAT) {
    add('format-unsupported', 'format', typeof doc['format'] === 'number' && doc['format'] > WORLD_FORMAT ? `format ${doc['format']} is newer than this tool (${WORLD_FORMAT})` : `format must be ${WORLD_FORMAT}`);
  }
  const name = typeof doc['name'] === 'string' ? doc['name'].trim() : '';
  if ([...name].length < 3 || [...name].length > 48 || !plainText(name)) add('field', 'name', 'name must be 3 to 48 characters of plain text');
  const description = typeof doc['description'] === 'string' ? doc['description'].trim() : '';
  if ([...description].length > 280 || !plainText(description)) add('field', 'description', 'description must be at most 280 characters of plain text');

  const cap = table('capacity');
  const maximum = num(cap['maximum'], 'capacity.maximum', 1, 1000, 50, true);
  const recommended = num(cap['recommended'], 'capacity.recommended', 1, 1000, Math.min(40, maximum), true);
  if (recommended > maximum) add('field', 'capacity.recommended', 'capacity.recommended must be at most capacity.maximum');

  const mode = table('persistence')['mode'] ?? 'reset';
  if (mode !== 'reset' && mode !== 'persistent') add('field', 'persistence.mode', 'persistence.mode must be "reset" or "persistent"');
  const flying = table('movement')['flying'] ?? false;
  if (typeof flying !== 'boolean') add('field', 'movement.flying', 'movement.flying must be true or false');

  const av = table('avatars');
  const minHeight = num(av['min_height'], 'avatars.min_height', 0.1, 20, 0.5);
  const maxHeight = num(av['max_height'], 'avatars.max_height', 0.1, 20, 3);
  if (minHeight >= maxHeight) add('field', 'avatars', 'avatars.min_height must be below avatars.max_height');
  const range = num(table('voice')['range'], 'voice.range', 1, 100, 25);

  const scenes: SceneEntry[] = [];
  const rawScenes = Array.isArray(doc['scenes']) ? (doc['scenes'] as unknown[]) : [];
  if (rawScenes.length === 0) add('scene-missing', 'scenes', 'a world needs at least one [[scenes]] entry');
  rawScenes.forEach((s, i) => {
    const at = `scenes[${i}]`;
    if (!isTable(s)) return add('field', at, 'each [[scenes]] entry is a table');
    const id = s['id'];
    const f = s['file'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return add('field', `${at}.id`, 'a scene id is 1 to 32 lowercase letters, digits and dashes');
    if (scenes.some((e) => e.id === id)) return add('field', `${at}.id`, `scene id ${id} is used twice`);
    if (typeof f !== 'string' || !safePath(f)) return add('path-unsafe', `${at}.file`, 'a scene file is a relative path inside the world folder');
    if (!/\.(glb|gltf)$/i.test(f)) return add('field', `${at}.file`, 'a scene file is .glb or .gltf');
    scenes.push({ id, file: f });
  });

  if (problems.some((p) => p.severity === 'error')) return { problems };
  return {
    manifest: {
      format: WORLD_FORMAT,
      name,
      description,
      capacity: { recommended, maximum },
      persistence: mode as WorldManifest['persistence'],
      flying: flying as boolean,
      avatars: { minHeight, maxHeight },
      voice: { range },
      scenes,
    },
    problems,
  };
}
