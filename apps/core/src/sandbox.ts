// SPDX-License-Identifier: AGPL-3.0-or-later
// The converters' sandbox (S4.02, S5.05, S5.07): every upload, an avatar, an item or an animation, is
// converted by its own program (tools/converter/src/avatar-cli.ts, item-cli.ts, animation-cli.ts) in a
// separate process under Node.js's
// permission model. It reads only the converter's code, the upload and what the conversion needs
// (the standard bodies, for an item), writes only its own folder, loads no native addon and starts
// no worker or child process, runs in an empty network namespace where the system allows one, and
// has a time and a memory limit; a crash or a hostile file costs that process alone. Headless
// Blender, which reads FBX animations (S5.07) and FBX, OBJ and .blend models (S5.08), cannot run
// under that model: runBlender is its own sandbox.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLENDER_FORMATS, MODEL_FORMAT_NAMES, type ModelFrom, uploadFormat } from '@flatchat/content';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Blender's script that turns an FBX, OBJ or .blend avatar or item into a GLB (S5.08). */
export const TO_GLB = join(ROOT, 'tools', 'blender', 'convert', 'to-glb.py');
/** How long Blender may take over one model. */
export const BLENDER_MODEL_MS = 5 * 60_000;

/** A converter program: its script, the hook that keeps native addons out, and what it may read. */
export interface ConverterProgram {
  script: string;
  sandbox: string;
  reads: string[];
}

/** What went wrong with an account's content: an upload, a standard body, an outfit. */
export type ContentProblemCode = 'upload-trust' | 'upload-limit' | 'too-large' | 'bad-request' | 'not-found' | 'not-ready' | 'mismatch' | 'slot-expired' | 'outfit-limit' | 'publish-trust' | 'licence';

export class ContentProblem extends Error {
  readonly code: ContentProblemCode;
  constructor(code: ContentProblemCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The converter's command line: Node.js's permission model with reads of the converter's code,
 *  the upload and `more.reads` only, writes of its folder only, no addons, workers or child
 *  processes (none is allowed), a memory ceiling, and the hook that keeps sharp's addon out. The
 *  program's arguments are the upload, its folder, `more.args`, and `--no-ktx2` when asked. */
export function converterArgs(c: ConverterProgram, input: string, out: string, ktx2: boolean, more: { reads?: string[]; args?: string[] } = {}): string[] {
  return [
    '--permission',
    ...[...c.reads, ...(more.reads ?? [])].map((r) => `--allow-fs-read=${r}`),
    `--allow-fs-read=${input}`,
    `--allow-fs-write=${out}`,
    '--max-old-space-size=3072',
    '--import',
    c.sandbox,
    c.script,
    input,
    out,
    ...(more.args ?? []),
    ...(ktx2 ? [] : ['--no-ktx2']),
  ];
}

/** Whether `unshare -rn` gives a process its own empty network here (Linux user namespaces). */
export function networkNamespace(): boolean {
  try {
    return spawnSync('unshare', ['-rn', 'true'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** What a converter program said: its exit code (null when it ran out of time), the end of its
 *  error output, and its result.json when it wrote one. */
export interface ConverterRun {
  code: number | null;
  stderr: string;
  result: { ok: boolean; id?: string; manifest?: unknown; problems?: string[]; fingerprint?: unknown } | undefined;
}

/** Runs a converter program on one upload, in the network namespace when `isolated`. */
export async function runConverter(args: string[], out: string, o: { isolated: boolean; timeoutMs: number }): Promise<ConverterRun> {
  const [cmd, argv] = o.isolated ? ['unshare', ['-rn', '--', process.execPath, ...args]] : [process.execPath, args];
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
  let result: ConverterRun['result'];
  try {
    result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) as ConverterRun['result'];
  } catch {
    result = undefined;
  }
  return { code, stderr, result };
}

/** Why a run neither converted nor refused its upload. */
export function converterFailure(run: ConverterRun): string {
  return run.code === null ? 'the converter ran out of time' : `the converter stopped (${run.code}): ${run.stderr.split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? ''}`;
}

/** A name as an account gave it, or as a file declared it: one line, 64 characters at most. */
export function cleanName(name: unknown, max = 64): string {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, max);
}

/** Runs a Blender script headless on one upload (S5.07, DR-15): factory settings, no audio,
 *  scripts inside files never run (-Y), offline, a clean environment whose home is the job's
 *  folder, a 6 GB address-space cap (prlimit), the empty network namespace when `isolated`, and a
 *  time limit. Blender cannot run under Node.js's permission model; this is its sandbox. */
export async function runBlender(blender: string, script: string, args: string[], o: { isolated: boolean; timeoutMs: number; home: string }): Promise<{ code: number | null; stderr: string }> {
  const capped = ['--as=6442450944', '--', blender, '-b', '--factory-startup', '-noaudio', '-Y', '--offline-mode', '--python', script, '--', ...args];
  const [cmd, argv] = o.isolated ? ['unshare', ['-rn', '--', 'prlimit', ...capped]] : ['prlimit', capped];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: o.home }, cwd: o.home });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `Blender could not start (${e.message.slice(0, 120)})` });
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
}

/** Runs Rhubarb Lip Sync on a sound (S5.07, rr-013): its phonetic recogniser (any language, any
 *  singing), the extended shapes, JSON out; no network, a 2 GB address-space cap, PATH and HOME
 *  only, a time limit. A native program, like Blender, outside Node.js's permission model. */
export async function runRhubarb(rhubarb: string, sound: string, out: string, o: { isolated: boolean; timeoutMs: number; home: string }): Promise<{ code: number | null; stderr: string }> {
  const capped = ['--as=2147483648', '--', rhubarb, '-f', 'json', '-r', 'phonetic', '--extendedShapes', 'GHX', '--machineReadable', '-q', '-o', out, sound];
  const [cmd, argv] = o.isolated ? ['unshare', ['-rn', '--', 'prlimit', ...capped]] : ['prlimit', capped];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: o.home }, cwd: o.home });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `Rhubarb could not start (${e.message.slice(0, 120)})` });
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr: err });
    });
  });
}

/** An avatar or item upload only Blender reads (an FBX, an OBJ or a .blend, S5.08), turned into a
 *  GLB by to-glb.py in runBlender's sandbox, for the converter to read with the upload's own format,
 *  SHA-256 and size. Undefined for any other upload (a VRM or a GLB, or a DAE, which the converter
 *  reads itself); the refusal when the core has no Blender or Blender cannot read the file. A
 *  Blender that does not start is the core's failure, not the file's: that throws. */
export async function throughBlender(blender: string | undefined, upload: Uint8Array, input: string, o: { dir: string; source: { sha256: string; bytes: number }; isolated: boolean }): Promise<undefined | { refused: string } | { input: string; args: string[] }> {
  const format = uploadFormat(upload);
  if (!BLENDER_FORMATS.includes(format as ModelFrom)) return undefined;
  const name = MODEL_FORMAT_NAMES[format as ModelFrom];
  if (!blender) return { refused: `the ${name} file needs headless Blender on the core, which this one does not have: export a VRM or a GLB instead` };
  const glb = join(o.dir, 'from-blender.glb');
  const run = await runBlender(blender, TO_GLB, [input, glb, format], { isolated: o.isolated, timeoutMs: BLENDER_MODEL_MS, home: o.dir });
  if (run.code === -1) throw new Error(run.stderr);
  if (run.code !== 0) return { refused: run.code === null ? `Blender ran out of time reading the ${name} file` : (run.stderr.split('\n').find((l) => l.startsWith('to-glb:'))?.replace(/^to-glb: /, '') ?? `Blender could not read the ${name} file`) };
  return { input: glb, args: ['--from', format, '--source', `${o.source.sha256}:${o.source.bytes}`] };
}
