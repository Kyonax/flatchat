// SPDX-License-Identifier: Apache-2.0
// Effects (S6.01, Q-M8, Q-M9, DR-12): particles, auras and trails made in Effekseer's free editor,
// worn at an avatar's attachment points or placed in a world. This file reads them without running
// them: the editor's file (.efkefc, a container whose BIN_ chunk is what the runtime plays; the
// older .efk is that body alone), its version against the runtime the platform pins, and the
// resources it asks for. The converter checks every upload with it before its dry run in the
// pinned runtime (packages/effects); the platform keeps an effect as one bundle (FCFX, below) of
// the effect and the files it uses, so the client fetches one file per effect. Shared by the
// converter, the core, the world validator and the client.

/** The runtime every client plays effects with (packages/effects/third_party/effekseer), and the
 *  newest effect body it reads: Effekseer 1.8's. A newer editor's file is refused at upload. */
export const EFFECT_RUNTIME = { effekseer: '1.80.7', bodyVersion: 1810 } as const;

/** The largest effect upload: one .efkefc, one Effekseer package (.efkpkg) or one zip. */
export const EFFECT_SOURCE_LIMIT = 16 * 1024 * 1024;

/** What effects may weigh: rr-013's starting proposals for particles (instances) and squares (the
 *  runtime's quads: sprites, ribbons, rings and tracks), and a budget of its own for the triangles
 *  of their models (.efkmodel and procedural meshes), to tune on the reference laptop like the
 *  avatars' ranks. The client's runtime is made with the global instance and quad caps, so nothing
 *  can pass those. */
export const EFFECT_LIMITS = {
  /** Every effect a viewer plays, together. */
  instances: 4000,
  quads: 16000,
  triangles: 200_000,
  /** One avatar's worn effects together, and so any one effect worn on an avatar. */
  avatar: { instances: 300, quads: 2000, triangles: 20_000 },
  /** One world's own effects together. */
  world: { instances: 2000, quads: 8000, triangles: 100_000 },
  /** An effect whose drawing takes longer than this on the GPU, for this many measured frames in
   *  a row, is stopped for the rest of the visit. */
  gpuMs: 0.5,
  gpuFrames: 3,
  /** The same for its update on the CPU, in the client; and an update so slow it is stopped at once. */
  cpuMs: 2,
  cpuFrames: 3,
  stallMs: 16,
  /** One effect's files. */
  files: 48,
  textures: 24,
  /** A texture's longest side, and every texture's pixels together (4 bytes each when drawn). */
  textureSide: 1024,
  texturePixels: 4 * 1024 * 1024,
  models: 8,
  /** The dry run's 95th-percentile update may take this long, on the converter's machine (a
   *  typical effect takes a twentieth of it; a broken one was found taking 32 s an update). */
  updateMs: 2,
  /** The dry run: frames at 60 a second (10 s), the random seeds it plays them with, and how long
   *  the whole run may take. */
  dryRunFrames: 600,
  dryRunSeeds: [1, 2, 3] as readonly number[],
  dryRunMs: 20_000,
} as const;

/** The resources an effect body names, by kind, as the runtime asks for them. */
export interface EffectResources {
  colorImages: string[];
  normalImages: string[];
  /** Distortion's textures: drawn only over a copy of the frame behind them, which the client
   *  never gives the runtime, so distortion is off everywhere (S6.01). */
  distortionImages: string[];
  sounds: string[];
  models: string[];
  /** Material files (.efkmat): node-graph shaders, so creator shaders (S6.03). */
  materials: string[];
  curves: string[];
}

export interface EffectFile {
  /** The container's version (EFKE), when the file has one; the older .efk has none. */
  container?: number;
  /** The body's version (SKFE): 1810 for Effekseer 1.8. */
  version: number;
  resources: EffectResources;
}

export class EffectFormatError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/** The editor version a body version comes from, for messages: 1810 → "1.8". */
export function editorVersion(version: number): string {
  if (version >= 1500) return `${Math.floor(version / 1000)}.${Math.floor((version % 1000) / 100)}`;
  return 'before 1.5';
}

const COUNT_MAX = 1024;
/** A resource path as the runtime and the bundle know it: forward slashes, no "./", ".." resolved
 *  where it can be, no NUL. */
export function effectPath(raw: string): string {
  const parts: string[] = [];
  for (const p of raw.replace(/\0+$/, '').replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

class Reader {
  at = 0;
  readonly b: Uint8Array;
  readonly where: string;
  constructor(b: Uint8Array, where: string) {
    this.b = b;
    this.where = where;
  }
  private view = (): DataView => new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  need(n: number): void {
    if (n < 0 || this.at + n > this.b.length) throw new EffectFormatError([`${this.where}: the file ends early`]);
  }
  i32(): number {
    this.need(4);
    const v = this.view().getInt32(this.at, true);
    this.at += 4;
    return v;
  }
  fourcc(): string {
    this.need(4);
    const s = String.fromCharCode(...this.b.subarray(this.at, this.at + 4));
    this.at += 4;
    return s;
  }
  /** A count or a length the runtime bounds the same way (0 to 1,024). */
  count(what: string): number {
    const n = this.i32();
    if (n < 0 || n > COUNT_MAX) throw new EffectFormatError([`${this.where}: ${what} count ${n} is out of range`]);
    return n;
  }
  utf16(chars: number): string {
    this.need(chars * 2);
    let s = '';
    for (let i = 0; i < chars; i++) s += String.fromCharCode(this.b[this.at + i * 2]! | (this.b[this.at + i * 2 + 1]! << 8));
    this.at += chars * 2;
    return s;
  }
  paths(what: string): string[] {
    const n = this.count(what);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(effectPath(this.utf16(this.count(`${what} path`))));
    return out;
  }
}

/** The runtime body (it starts "SKFE"): its version and the resources it names, in the order
 *  Effekseer 1.80.7's loader reads them (Effekseer.Effect.cpp, LoadBody). */
function readBody(body: Uint8Array): EffectFile {
  const r = new Reader(body, 'the effect');
  if (r.fourcc() !== 'SKFE') throw new EffectFormatError(['not an Effekseer effect: its body does not start with SKFE']);
  const version = r.i32();
  const res: EffectResources = { colorImages: [], normalImages: [], distortionImages: [], sounds: [], models: [], materials: [], curves: [] };
  if (version > EFFECT_RUNTIME.bodyVersion) return { version, resources: res };
  if (version < 0) throw new EffectFormatError([`the effect's version ${version} is not one Effekseer writes`]);
  res.colorImages = r.paths('texture');
  if (version >= 9) {
    res.normalImages = r.paths('normal texture');
    res.distortionImages = r.paths('distortion texture');
  }
  if (version >= 1) res.sounds = r.paths('sound');
  if (version >= 6) res.models = r.paths('model');
  if (version >= 15) res.materials = r.paths('material');
  if (version >= 1607) res.curves = r.paths('curve');
  return { version, resources: res };
}

/** Reads an effect file: an .efkefc (the EFKE container, its BIN_ chunk the body) or an older
 *  .efk (the body alone). Throws EffectFormatError when it is neither or does not read. */
export function readEffectFile(bytes: Uint8Array): EffectFile {
  const r = new Reader(bytes, 'the effect');
  const head = bytes.length >= 4 ? String.fromCharCode(...bytes.subarray(0, 4)) : '';
  if (head === 'SKFE') return readBody(bytes);
  if (head !== 'EFKE') throw new EffectFormatError(['not an Effekseer effect (.efkefc or .efk)']);
  r.at = 4;
  const container = r.i32();
  while (r.at < bytes.length) {
    const id = r.fourcc();
    const size = r.i32();
    if (size < 0) throw new EffectFormatError([`the effect's ${id} chunk has a negative size`]);
    r.need(size);
    if (id === 'BIN_') return { container, ...readBody(bytes.subarray(r.at, r.at + size)) };
    r.at += size;
  }
  throw new EffectFormatError(['the effect has no runtime body (no BIN_ chunk)']);
}

/** Every path an effect names, once each, with its kind. */
export function effectFiles(f: EffectFile): Array<{ path: string; kind: keyof EffectResources }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; kind: keyof EffectResources }> = [];
  for (const kind of Object.keys(f.resources) as Array<keyof EffectResources>) {
    for (const path of f.resources[kind]) {
      if (path === '' || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, kind });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the bundle (FCFX)

/** How the platform keeps an effect: "FCFX", the format (1), the index's length, the index (JSON:
 *  the effect's own path and every file's path and size, in order), then the files' bytes in that
 *  order, the effect first. One file per effect, named by its SHA-256 like every converted file. */
export const BUNDLE_FORMAT = 1;
const BUNDLE_INDEX_MAX = 64 * 1024;

export interface EffectBundle {
  /** The effect's own path, first among the files. */
  main: string;
  files: Map<string, Uint8Array>;
}

export function writeBundle(b: EffectBundle): Uint8Array {
  const order = [b.main, ...[...b.files.keys()].filter((p) => p !== b.main).sort()];
  if (!b.files.has(b.main)) throw new Error('the bundle has no effect');
  const index = new TextEncoder().encode(JSON.stringify({ main: b.main, files: order.map((path) => ({ path, bytes: b.files.get(path)!.length })) }));
  const total = 12 + index.length + order.reduce((n, p) => n + b.files.get(p)!.length, 0);
  const out = new Uint8Array(total);
  out.set([0x46, 0x43, 0x46, 0x58]);
  const view = new DataView(out.buffer);
  view.setUint32(4, BUNDLE_FORMAT, true);
  view.setUint32(8, index.length, true);
  out.set(index, 12);
  let at = 12 + index.length;
  for (const p of order) {
    out.set(b.files.get(p)!, at);
    at += b.files.get(p)!.length;
  }
  return out;
}

export function readBundle(bytes: Uint8Array): EffectBundle {
  const bad = (why: string): never => {
    throw new EffectFormatError([`not an effect bundle: ${why}`]);
  };
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FCFX') bad('no FCFX header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== BUNDLE_FORMAT) bad(`format ${view.getUint32(4, true)}`);
  const n = view.getUint32(8, true);
  if (n > BUNDLE_INDEX_MAX || 12 + n > bytes.length) bad('its index does not fit');
  let index: { main?: unknown; files?: unknown };
  try {
    index = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + n))) as typeof index;
  } catch {
    return bad('its index does not read');
  }
  if (typeof index.main !== 'string' || !Array.isArray(index.files) || index.files.length > EFFECT_LIMITS.files) bad('its index lists no effect, or too many files');
  const files = new Map<string, Uint8Array>();
  let at = 12 + n;
  for (const f of index.files as Array<{ path?: unknown; bytes?: unknown }>) {
    if (typeof f.path !== 'string' || effectPath(f.path) !== f.path || f.path === '' || typeof f.bytes !== 'number' || !Number.isInteger(f.bytes) || f.bytes < 0) bad('a file entry does not read');
    if (at + (f.bytes as number) > bytes.length || files.has(f.path as string)) bad('its files do not fit');
    files.set(f.path as string, bytes.subarray(at, at + (f.bytes as number)));
    at += f.bytes as number;
  }
  if (at !== bytes.length || !files.has(index.main as string)) bad('its files do not add up');
  return { main: index.main as string, files };
}

/** The bundle's path for a path the runtime asks for: the same path, else the same path ignoring
 *  case, else the only file with that name (an effect made in one folder, packed from another). */
export function bundlePathOf(paths: Iterable<string>, raw: string): string | undefined {
  const p = effectPath(raw);
  const all = [...paths];
  if (all.includes(p)) return p;
  const lower = p.toLowerCase();
  const caseless = all.find((k) => k.toLowerCase() === lower);
  if (caseless !== undefined) return caseless;
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const named = all.filter((k) => k.toLowerCase().slice(k.lastIndexOf('/') + 1) === name);
  return named.length === 1 ? named[0] : undefined;
}

/** A bundle's file for a path the runtime asks for (bundlePathOf). */
export function bundleFile(b: EffectBundle, raw: string): Uint8Array | undefined {
  const key = bundlePathOf(b.files.keys(), raw);
  return key === undefined ? undefined : b.files.get(key);
}

// ---------------------------------------------------------------- what the converter measured

/** An effect as the platform keeps it, measured by the dry run in the pinned runtime. */
export interface EffectFit {
  /** The bundle: its SHA-256 and size. */
  file: string;
  bytes: number;
  /** The effect body's version (SKFE). */
  version: number;
  /** The most it ever had at once, over every seed of the dry run: instances alive, the quads it
   *  drew (sprites, ribbons, rings and tracks) and its models' triangles. */
  peak: { instances: number; quads: number; triangles: number };
  /** Its length in frames at 60 a second, or null when it was still playing at the end of the
   *  dry run (a loop). */
  frames: number | null;
  textures: number;
  texturePixels: number;
  models: number;
  /** Parts it draws with distortion, which no client draws (EffectResources.distortionImages). */
  distortion: boolean;
  /** The sounds it names: none play from avatars (Q-H1); a world's play at the "high" tier. */
  sounds: number;
  /** The scale it is played at (the creator's, 0.01 to 100). */
  scale: number;
  /** The dry run's 95th-percentile update, in microseconds, on the converter's machine. */
  updateUs: number;
}

/** Checks the measured fit of an effect against the limits for where it plays. */
export function effectFitProblems(fit: EffectFit, where: 'avatar' | 'world'): string[] {
  const p: string[] = [];
  const cap = where === 'avatar' ? EFFECT_LIMITS.avatar : EFFECT_LIMITS.world;
  const whose = where === 'avatar' ? "an avatar's" : "a world's";
  if (fit.peak.instances > cap.instances) p.push(`the effect has up to ${fit.peak.instances} particles at once; ${whose} effects may have ${cap.instances}`);
  if (fit.peak.quads > cap.quads) p.push(`the effect draws up to ${fit.peak.quads} quads at once; ${whose} effects may draw ${cap.quads}`);
  if (fit.peak.triangles > cap.triangles) p.push(`the effect's models draw up to ${fit.peak.triangles} triangles at once; ${whose} effects may draw ${cap.triangles}`);
  if (fit.textures > EFFECT_LIMITS.textures) p.push(`the effect uses ${fit.textures} textures; ${EFFECT_LIMITS.textures} at most`);
  if (fit.texturePixels > EFFECT_LIMITS.texturePixels) p.push(`the effect's textures have ${fit.texturePixels} pixels together; ${EFFECT_LIMITS.texturePixels} at most`);
  if (fit.models > EFFECT_LIMITS.models) p.push(`the effect uses ${fit.models} models; ${EFFECT_LIMITS.models} at most`);
  if (fit.updateUs > EFFECT_LIMITS.updateMs * 1000) p.push(`the effect is too slow: its updates take up to ${(fit.updateUs / 1000).toFixed(1)} ms; ${EFFECT_LIMITS.updateMs} ms at most`);
  return p;
}

/** Checks an effect fit from the core before the client trusts it. */
export function checkEffectFit(value: unknown): EffectFit {
  const f = value as EffectFit;
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (typeof f !== 'object' || f === null || typeof f.file !== 'string' || !/^[0-9a-f]{64}$/.test(f.file)) throw new Error('an effect names its bundle');
  if (!num(f.version) || f.version > EFFECT_RUNTIME.bodyVersion) throw new Error('an effect newer than the runtime');
  if (!f.peak || !num(f.peak.instances) || !num(f.peak.quads) || !num(f.peak.triangles)) throw new Error('an effect carries its dry run');
  if (!num(f.scale) || f.scale < 0.01 || f.scale > 100) throw new Error('an effect scale out of range');
  return f;
}
