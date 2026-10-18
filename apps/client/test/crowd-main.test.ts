// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's main-process parts: the crowd flags, the avatar folder's protocol and the pass lines.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listAvatars, resolveAvatarRequest } from '../src/main/avatar-files';
import { crowdPass } from '../src/main/crowd-pass';
import { exitCodeFor, parseFlags, rendererQuery } from '../src/main/flags';

const argv = (...a: string[]): string[] => ['electron', '.', ...a];

describe('the crowd flags', () => {
  it('reads a crowd run with the plan\'s make-up by default', () => {
    const { flags, errors } = parseFlags(argv('--crowd=300', '--avatars=/tmp/a', '--crowd-out=c.json'));
    expect(errors).toEqual([]);
    expect(flags.crowd).toEqual({ seconds: 300, avatars: '/tmp/a', full: 12, lod: 20, present: 55, springs: 6, swap: 15, textureMB: 16, lodRatio: 0.3, merge: true, headroom: 1, converted: false, inView: 55, out: 'c.json' });
    expect(rendererQuery(flags)).toMatchObject({ crowd: '300', size: '1280x720', full: '12', lod: '20', present: '55' });
    expect(rendererQuery(flags)['converted']).toBeUndefined();
  });

  it('reads the converted crowd (S4.12): the world\'s avatar layer, 55 in view by default', () => {
    const { flags, errors } = parseFlags(argv('--crowd=60', '--avatars=/tmp/c', '--crowd-converted=1', '--crowd-present=200'));
    expect(errors).toEqual([]);
    expect(flags.crowd).toMatchObject({ converted: true, present: 200, inView: 55 });
    expect(rendererQuery(flags)).toMatchObject({ converted: '1', inview: '55', present: '200' });
    expect(rendererQuery(flags)['tier']).toBeUndefined();
    const tiered = parseFlags(argv('--crowd=60', '--avatars=/tmp/c', '--crowd-converted=1', '--crowd-tier=medium'));
    expect(tiered.errors).toEqual([]);
    expect(rendererQuery(tiered.flags)).toMatchObject({ converted: '1', tier: 'medium' });
    expect(parseFlags(argv('--crowd=60', '--avatars=/tmp/c', '--crowd-converted=1', '--crowd-tier=ultra')).errors).toEqual(['--crowd-tier must be low, medium or high, got ultra']);
  });

  it('refuses a crowd without avatars, a crowd too small for its tiers and mixed modes', () => {
    expect(parseFlags(argv('--crowd=60')).errors).toEqual(['--crowd needs --avatars=DIR, a folder of .vrm files']);
    expect(parseFlags(argv('--crowd=60', '--avatars=/a', '--crowd-full=12', '--crowd-lod=20', '--crowd-present=20')).errors).toHaveLength(1);
    expect(parseFlags(argv('--crowd=60', '--avatars=/a', '--crowd-full=4', '--crowd-springs=6')).errors).toHaveLength(1);
    expect(parseFlags(argv('--crowd=60', '--avatars=/a', '--smoke')).errors).toContain('--crowd runs alone');
    expect(parseFlags(argv('--crowd=60', '--avatars=/a', '--crowd-texture-mb=-1')).errors).toHaveLength(1);
    expect(parseFlags(argv('--crowd=60', '--avatars=/a', '--crowd-full=2.5')).errors).toHaveLength(1);
  });

  it('exits 0 only for a crowd run that drew and finished', () => {
    expect(exitCodeFor({ backend: 'WebGPU' }, 'crowd')).toBe(0);
    expect(exitCodeFor({ backend: 'WebGPU', error: 'boom' }, 'crowd')).toBe(1);
    expect(exitCodeFor({ backend: 'none' }, 'crowd')).toBe(1);
  });
});

describe('the avatar folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatchat-avatars-'));
  writeFileSync(join(dir, 'b.vrm'), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'A Girl.VRM'), 'xyz');
  mkdirSync(join(dir, 'sub', 'deeper'));
  writeFileSync(join(dir, 'sub', 'deeper', 'c.vrm'), 'x');
  const files = listAvatars(dir);

  it('lists the .vrm files of the folder and of its subfolders one level down', () => {
    expect(files).toEqual([
      { name: 'b.vrm', bytes: 1 },
      { name: 'sub/A Girl.VRM', bytes: 3 },
    ]);
  });

  it('serves the index and exactly the listed files', () => {
    expect(resolveAvatarRequest('flatchat-avatar://bench/index.json', files)).toEqual({ kind: 'index' });
    expect(resolveAvatarRequest(`flatchat-avatar://bench/${encodeURIComponent('sub/A Girl.VRM')}`, files)).toEqual({ kind: 'file', name: 'sub/A Girl.VRM' });
    expect(resolveAvatarRequest('flatchat-avatar://bench/b.vrm', files)).toEqual({ kind: 'file', name: 'b.vrm' });
  });

  it('refuses anything else: other names, other hosts, other schemes, paths that climb', () => {
    for (const url of [
      'flatchat-avatar://bench/notes.txt',
      'flatchat-avatar://bench/sub/deeper/c.vrm',
      `flatchat-avatar://bench/${encodeURIComponent('../b.vrm')}`,
      'flatchat-avatar://bench/%2e%2e%2fetc%2fpasswd',
      'flatchat-avatar://other/b.vrm',
      'file:///etc/passwd',
      'flatchat-avatar://bench/b.vrm?x=1',
      'flatchat-avatar://bench/%E0%A4%A',
      'not a url',
    ]) {
      expect(resolveAvatarRequest(url, files)).toBeUndefined();
    }
  });
});

describe('the S0.09 pass lines', () => {
  const report = { summary: { p95Ms: 25, maxMs: 80, frames: 9000 }, framesOver100: 0, tiers: { full: { count: 12 } } };

  it('passes a run inside every line', () => {
    expect(crowdPass(report, 1500).every((l) => l.ok)).toBe(true);
  });

  it('tightens the frame lines by the stand-in\'s headroom', () => {
    const lines = crowdPass(report, 1500, 1.5);
    expect(lines[0]).toMatchObject({ limit: '≤ 22.2 ms', ok: false });
    expect(lines[1]).toMatchObject({ limit: '≤ 66.7 ms', ok: false });
  });

  it('fails too few full avatars, too much memory and a run with no frames', () => {
    expect(crowdPass({ ...report, tiers: { full: { count: 7 } } }, 1500)[2]!.ok).toBe(false);
    // The converted crowd sets its own count: a tier's quota of the near ones it draws in full.
    expect(crowdPass({ ...report, tiers: { full: { count: 4 } }, fullExpected: 4 }, 1500)[2]).toMatchObject({ limit: '≥ 4', ok: true });
    expect(crowdPass(report, 2049)[3]!.ok).toBe(false);
    expect(crowdPass({ summary: { frames: 0 } }, 1000).slice(0, 2).every((l) => !l.ok)).toBe(true);
  });
});
