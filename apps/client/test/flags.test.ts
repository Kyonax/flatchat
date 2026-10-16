// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCH_SIZE, exitCodeFor, parseFlags, parseSize, rendererQuery } from '../src/main/flags';

const argv = (...flags: string[]): string[] => ['/opt/flatchat/flatchat', ...flags];

describe('parseFlags', () => {
  it('reads nothing from a plain start', () => {
    const { flags, errors } = parseFlags(argv());
    expect(errors).toEqual([]);
    expect(flags).toEqual({ smoke: false, benchSize: DEFAULT_BENCH_SIZE });
    expect(rendererQuery(flags)).toEqual({});
  });

  it('reads the smoke mode and its output file', () => {
    const { flags } = parseFlags(argv('--smoke', '--smoke-out=smoke.json'));
    expect(flags.smoke).toBe(true);
    expect(flags.smokeOut).toBe('smoke.json');
    expect(rendererQuery(flags)).toEqual({ smoke: '1' });
  });

  it('reads the bench mode with its default size', () => {
    const { flags, errors } = parseFlags(argv('--bench=60', '--bench-out=frames.json'));
    expect(errors).toEqual([]);
    expect(flags.bench).toBe(60);
    expect(flags.benchOut).toBe('frames.json');
    expect(rendererQuery(flags)).toEqual({ bench: '60', size: '1280x720' });
  });

  it('reads a bench size', () => {
    const { flags } = parseFlags(argv('--bench=5', '--bench-size=1920x1080'));
    expect(flags.benchSize).toEqual({ width: 1920, height: 1080 });
  });

  it('rejects bad values and the two modes together', () => {
    expect(parseFlags(argv('--bench=0')).errors).toHaveLength(1);
    expect(parseFlags(argv('--bench=abc')).errors).toHaveLength(1);
    expect(parseFlags(argv('--bench=10', '--bench-size=wide')).errors).toHaveLength(1);
    expect(parseFlags(argv('--smoke', '--bench=10')).errors).toEqual(['--smoke and --bench cannot run together']);
  });
});

describe('parseSize', () => {
  it('accepts WxH within limits only', () => {
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseSize('32x32')).toBeUndefined();
    expect(parseSize('99999x720')).toBeUndefined();
    expect(parseSize('1280×720')).toBeUndefined();
  });
});

describe('exitCodeFor', () => {
  it('passes only a run that drew on a known backend', () => {
    expect(exitCodeFor({ backend: 'WebGPU' })).toBe(0);
    expect(exitCodeFor({ backend: 'WebGL2' })).toBe(0);
    expect(exitCodeFor({ backend: 'none' })).toBe(1);
    expect(exitCodeFor({})).toBe(1);
  });
});
