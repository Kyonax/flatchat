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

describe('the join check', () => {
  const token = 'ab'.repeat(40);
  it('reads a loopback join with its token, only in smoke mode', () => {
    const { flags, errors } = parseFlags(argv('--smoke', '--join=http://127.0.0.1:7779/rtc', `--join-token=${token}`));
    expect(errors).toEqual([]);
    expect(flags.join).toEqual({ url: 'http://127.0.0.1:7779/rtc', token });
    expect(rendererQuery(flags)).toEqual({ smoke: '1', join: 'http://127.0.0.1:7779/rtc', token });
  });

  it('refuses a join without smoke, without a token, or to another host', () => {
    expect(parseFlags(argv('--join=http://127.0.0.1:7779/rtc', `--join-token=${token}`)).errors).toEqual(['--join is part of the smoke test: add --smoke']);
    expect(parseFlags(argv('--smoke', '--join=http://127.0.0.1:7779/rtc')).errors).toEqual(['--join and --join-token go together']);
    expect(parseFlags(argv('--smoke', '--join=https://example.com/rtc', `--join-token=${token}`)).errors).toHaveLength(1);
    expect(parseFlags(argv('--smoke', '--join=http://127.0.0.1:7779/rtc', '--join-token=XYZ')).errors).toHaveLength(1);
    expect(parseFlags(argv('--smoke', '--join=http://8.8.8.8:7779/rtc', `--join-token=${token}`)).errors).toHaveLength(1);
  });

  it('reads a join on the local network, as the signaling bridge allows', () => {
    const { flags, errors } = parseFlags(argv('--smoke', '--join=http://10.77.0.1:7779/rtc', `--join-token=${token}`));
    expect(errors).toEqual([]);
    expect(flags.join?.url).toBe('http://10.77.0.1:7779/rtc');
  });

  it('fails a smoke run that was asked to join and did not', () => {
    const passed = { cases: 41, failures: [] };
    expect(exitCodeFor({ backend: 'WebGPU', protocol: passed, net: { ok: true } }, 'smoke', { join: true })).toBe(0);
    expect(exitCodeFor({ backend: 'WebGPU', protocol: passed, net: { ok: false, error: 'refused' } }, 'smoke', { join: true })).toBe(1);
    expect(exitCodeFor({ backend: 'WebGPU', protocol: passed }, 'smoke', { join: true })).toBe(1);
    expect(exitCodeFor({ backend: 'WebGPU', protocol: passed }, 'smoke')).toBe(0);
  });
});

describe('the voice test', () => {
  const token = 'cd'.repeat(40);
  it('reads its seconds and both players\' tokens, and runs alone', () => {
    const { flags, errors } = parseFlags(argv('--voice-test=20', '--join=http://127.0.0.1:7779/rtc', `--join-token=${token}`, `--listen-token=${token}`, '--voice-out=v.json'));
    expect(errors).toEqual([]);
    expect(rendererQuery(flags)).toEqual({ voice: '20', join: 'http://127.0.0.1:7779/rtc', token, token2: token });
    expect(flags.voiceOut).toBe('v.json');
    expect(parseFlags(argv('--voice-test=20', '--join=http://127.0.0.1:7779/rtc', `--join-token=${token}`)).errors).toEqual(['--voice-test needs --listen-token=HEX']);
    expect(parseFlags(argv('--smoke', '--voice-test=20', `--listen-token=${token}`)).errors).toContain('--voice-test runs alone, without --smoke or --bench');
  });

  it('reads the load test, which runs alone', () => {
    const { flags, errors } = parseFlags(argv('--voice-load=30', '--voice-out=load.json'));
    expect(errors).toEqual([]);
    expect(rendererQuery(flags)).toEqual({ voiceload: '30' });
    expect(parseFlags(argv('--voice-load=0')).errors).toHaveLength(1);
    expect(parseFlags(argv('--smoke', '--voice-load=30')).errors).toContain('--voice-load runs alone');
  });

  it('passes only a report that says ok', () => {
    expect(exitCodeFor({ ok: true }, 'voice')).toBe(0);
    expect(exitCodeFor({ ok: false }, 'voice')).toBe(1);
    expect(exitCodeFor({}, 'voice')).toBe(1);
  });
});

describe('the voice lounge', () => {
  const token = 'ef'.repeat(40);
  it('joins a LAN world server with a token, and runs alone', () => {
    const { flags, errors } = parseFlags(argv('--lounge=http://192.168.40.3:7779/rtc', `--join-token=${token}`));
    expect(errors).toEqual([]);
    expect(rendererQuery(flags)).toEqual({ lounge: 'http://192.168.40.3:7779/rtc', token });
    expect(parseFlags(argv('--lounge=http://203.0.113.5:7779/rtc', `--join-token=${token}`)).errors).toHaveLength(1);
    expect(parseFlags(argv('--lounge=http://192.168.40.3:7779/rtc')).errors).toEqual(['--lounge needs --join-token=HEX']);
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
    expect(exitCodeFor({ backend: 'WebGPU' }, 'bench')).toBe(0);
    expect(exitCodeFor({ backend: 'WebGL2' }, 'bench')).toBe(0);
    expect(exitCodeFor({ backend: 'none' }, 'bench')).toBe(1);
    expect(exitCodeFor({}, 'bench')).toBe(1);
  });

  it('passes a smoke run only when every golden packet passed in the renderer', () => {
    const passed = { cases: 41, failures: [] };
    expect(exitCodeFor({ backend: 'WebGL2', protocol: passed }, 'smoke')).toBe(0);
    expect(exitCodeFor({ backend: 'WebGL2' }, 'smoke')).toBe(1);
    expect(exitCodeFor({ backend: 'WebGL2', protocol: { cases: 41, failures: ['ping: writes 05'] } }, 'smoke')).toBe(1);
    expect(exitCodeFor({ backend: 'WebGL2', protocol: { cases: 0, failures: [], error: 'import failed' } }, 'smoke')).toBe(1);
    expect(exitCodeFor({ backend: 'none', protocol: passed }, 'smoke')).toBe(1);
  });
});
