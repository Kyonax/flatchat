// SPDX-License-Identifier: MPL-2.0
// The stand-in's real sequence against a recording runner: no GPU, sudo or client needed.
import { describe, expect, it } from 'vitest';
import {
  checkClocks,
  execute,
  judge,
  parseClockSamples,
  parseSupportedClocks,
  planRun,
  summarizeClocks,
  validateProfile,
  type Cmd,
  type Runner,
  type StandinProfile,
} from '../src/standin-plan.ts';

const PROFILE: StandinProfile = {
  gpu: 'Example GPU 3000',
  targets: {
    'iris-xe': { label: 'Iris Xe class', graphicsClockMHz: 645, memoryClockMHz: 810, cpus: '0-3', cpuQuota: '300%', memoryMax: '4G', size: '1280x720' },
  },
};

const SUPPORTED = `    Memory                            : 7001 MHz
        Graphics                      : 2175 MHz
        Graphics                      : 645 MHz
    Memory                            : 810 MHz
        Graphics                      : 2100 MHz
        Graphics                      : 645 MHz
        Graphics                      : 300 MHz
`;

const plan = () => planRun({ profile: PROFILE, target: 'iris-xe', clientPath: '/opt/flatchat', seconds: 60, outDir: '/tmp/out', stamp: 'S' });

/** Records every command; codes can be set per command prefix. */
function recorder(codes: Record<string, number> = {}, onRun?: (cmd: Cmd) => void): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd) => {
      calls.push(cmd.join(' '));
      onRun?.(cmd);
      const hit = Object.entries(codes).find(([prefix]) => cmd.join(' ').includes(prefix));
      return { code: hit ? hit[1] : 0, stdout: '' };
    },
    background: (cmd, file) => {
      calls.push(`bg ${cmd[0]} > ${file}`);
      return { stop: async () => void calls.push(`stop ${file}`) };
    },
    log: () => {},
  };
}

describe('the profile', () => {
  it('accepts a complete profile and rejects bad fields', () => {
    expect(validateProfile(PROFILE).errors).toEqual([]);
    const bad = { gpu: '', targets: { 'Iris Xe': { label: 'x', graphicsClockMHz: 1.5, memoryClockMHz: 810, cpus: 'all', cpuQuota: '3', memoryMax: 'lots', size: '720p' } } };
    expect(validateProfile(bad).errors).toHaveLength(7);
  });

  it('checks the clocks against the card\'s supported pairs', () => {
    const supported = parseSupportedClocks(SUPPORTED);
    expect([...supported.keys()]).toEqual([7001, 810]);
    expect(checkClocks(PROFILE.targets['iris-xe']!, supported)).toEqual([]);
    expect(checkClocks({ ...PROFILE.targets['iris-xe']!, memoryClockMHz: 5001 }, supported)[0]).toContain('not supported');
    expect(checkClocks({ ...PROFILE.targets['iris-xe']!, graphicsClockMHz: 650 }, supported)[0]).toContain('not offered');
  });
});

describe('the plan', () => {
  it('locks, caps the client, and resets with the profile\'s numbers', () => {
    const p = plan();
    expect(p.lock).toEqual([
      ['sudo', 'nvidia-smi', '--id=0', '--lock-gpu-clocks=645,645'],
      ['sudo', 'nvidia-smi', '--id=0', '--lock-memory-clocks=810,810'],
    ]);
    expect(p.client.join(' ')).toBe(
      'systemd-run --user --scope --quiet --unit=flatchat-standin-S -p CPUQuota=300% -p MemoryMax=4G -- taskset --cpu-list 0-3 /opt/flatchat --bench=60 --bench-out=/tmp/out/S-iris-xe/frames.json --bench-size=1280x720',
    );
    expect(p.reset.map((c) => c.at(-1))).toEqual(['--reset-gpu-clocks', '--reset-memory-clocks']);
    expect(() => planRun({ ...{ profile: PROFILE, clientPath: '/c', seconds: 5, outDir: '/o', stamp: 'S' }, target: '680m' })).toThrow('no target');
  });
});

describe('execute', () => {
  it('locks, samples, runs the client, resets, then checks the clocks are free', async () => {
    const r = recorder();
    const outcome = await execute(plan(), r);
    expect(r.calls.map((c) => c.split(' ').slice(0, 4).join(' '))).toEqual([
      'sudo nvidia-smi --id=0 --lock-gpu-clocks=645,645',
      'sudo nvidia-smi --id=0 --lock-memory-clocks=810,810',
      'bg nvidia-smi > /tmp/out/S-iris-xe/clocks.csv',
      'systemd-run --user --scope --quiet',
      'stop /tmp/out/S-iris-xe/clocks.csv',
      'sudo nvidia-smi --id=0 --reset-gpu-clocks',
      'sudo nvidia-smi --id=0 --reset-memory-clocks',
      'bg nvidia-smi > /tmp/out/S-iris-xe/after-reset-clocks.csv',
      '/opt/flatchat --bench=4 --bench-out=/tmp/out/S-iris-xe/after-reset-frames.json --bench-size=1280x720',
      'stop /tmp/out/S-iris-xe/after-reset-clocks.csv',
    ]);
    expect(outcome).toMatchObject({ locked: true, clientCode: 0, resetCodes: [0, 0], checkCode: 0, interrupted: false });
  });

  it('resets after a failed lock and skips the client', async () => {
    const r = recorder({ '--lock-memory-clocks': 6 });
    const outcome = await execute(plan(), r);
    expect(outcome.error).toContain('exited with 6');
    expect(r.calls.some((c) => c.startsWith('systemd-run'))).toBe(false);
    expect(r.calls.filter((c) => c.includes('--reset-'))).toHaveLength(2);
  });

  it('resets after a failed client', async () => {
    const r = recorder({ 'systemd-run': 1 });
    const outcome = await execute(plan(), r);
    expect(outcome.clientCode).toBe(1);
    expect(outcome.resetCodes).toEqual([0, 0]);
  });

  it('resets after an interrupt and skips the check', async () => {
    let stop = false;
    const r = recorder({}, (cmd) => {
      if (cmd[0] === 'systemd-run') stop = true;
    });
    const outcome = await execute(plan(), r, () => stop);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.resetCodes).toEqual([0, 0]);
    expect(r.calls.some((c) => c.includes('--bench=4'))).toBe(false);
  });
});

describe('the verdict', () => {
  const t = PROFILE.targets['iris-xe']!;
  const samples = (lines: string[]) => summarizeClocks(parseClockSamples(lines.join('\n')));

  it('sees a held lock and a verified reset', () => {
    const during = samples(['2026/10/16 14:00:00.000, 645, 810, 99', '2026/10/16 14:00:00.500, 645, 810, 98']);
    const after = samples(['2026/10/16 14:01:00.000, 1905, 7001, 97']);
    expect(judge(t, during, after)).toEqual({ lockHeld: true, reset: 'verified' });
  });

  it('sees a lock that did not hold and a reset that freed only the graphics clock', () => {
    const during = samples(['x, 1800, 7001, 90']);
    const after = samples(['x, 1905, 810, 97']);
    expect(judge(t, during, after)).toEqual({ lockHeld: false, reset: 'graphics-only' });
  });

  it('sees no reset when the clocks stay low under load, or when there are no samples', () => {
    expect(judge(t, samples(['x, 645, 810, 99']), samples(['x, 645, 810, 99'])).reset).toBe('not-verified');
    expect(judge(t, samples([]), samples([]))).toEqual({ lockHeld: false, reset: 'not-verified' });
  });
});
