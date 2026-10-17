// SPDX-License-Identifier: MPL-2.0
// The stand-in's real sequence against a recording runner: no GPU, sudo or client needed.
import { describe, expect, it } from 'vitest';
import {
  checkClocks,
  execute,
  floorCheck,
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
      return { code: hit ? hit[1] : 0, output: cmd.includes('--lock-memory-clocks=810,810') ? 'Memory clocks set.' : '' };
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

describe('the crowd plan (spike S0.09)', () => {
  it('runs the crowd bench instead of the blank scene, with the target\'s headroom', () => {
    const p = planRun({ profile: PROFILE, target: 'iris-xe', clientPath: '/opt/flatchat', seconds: 300, outDir: '/tmp/out', stamp: 'S', crowd: { avatars: '/avatars', full: 8 } });
    expect(p.kind).toBe('crowd');
    const at = p.client.indexOf('/opt/flatchat');
    expect(p.client.slice(at)).toEqual(['/opt/flatchat', '--crowd=300', '--avatars=/avatars', '--crowd-out=/tmp/out/S-iris-xe/frames.json', `--bench-size=${PROFILE.targets['iris-xe']!.size}`, `--crowd-headroom=${PROFILE.targets['iris-xe']!.headroom ?? 1}`, '--crowd-full=8']);
    // The check after the reset stays the short blank-scene bench.
    expect(p.check).toContain('--bench=4');
  });
});

describe('execute', () => {
  it('locks, samples, runs the client, resets, then checks the clocks are free', async () => {
    const r = recorder();
    const outcome = await execute(plan(), r);
    expect(r.calls.map((c) => c.split(' ').slice(0, 4).join(' '))).toEqual([
      'sudo -v',
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
    expect(outcome).toMatchObject({ locked: true, lockOutput: ['', 'Memory clocks set.'], clientCode: 0, resetCodes: [0, 0], checkCode: 0, interrupted: false });
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
    expect(judge(t, during, after)).toEqual({ graphicsLockHeld: true, memoryLock: 'held', lockHeld: true, reset: 'verified' });
  });

  it('sees a lock that did not hold and a reset that freed only the graphics clock', () => {
    const during = samples(['x, 1800, 7001, 90']);
    const after = samples(['x, 1905, 810, 97']);
    expect(judge(t, during, after)).toEqual({ graphicsLockHeld: false, memoryLock: 'not-held', lockHeld: false, reset: 'graphics-only' });
  });

  it('tells a held graphics lock from a memory lock the driver did not enforce (2026-10-16, GTX 1660 SUPER)', () => {
    const during = samples(['x, 645, 405, 30', 'x, 645, 5000, 60', 'x, 645, 7000, 82']);
    const after = samples(['x, 1530, 7000, 31']);
    expect(judge(t, during, after)).toEqual({ graphicsLockHeld: true, memoryLock: 'not-held', lockHeld: false, reset: 'verified' });
  });

  it('sees no reset when the clocks stay low under load, or when there are no samples', () => {
    expect(judge(t, samples(['x, 645, 810, 99']), samples(['x, 645, 810, 99'])).reset).toBe('not-verified');
    expect(judge(t, samples([]), samples([]))).toEqual({ graphicsLockHeld: false, memoryLock: 'not-held', lockHeld: false, reset: 'not-verified' });
  });

  it('judges a compute-only profile on its graphics lock alone', () => {
    const computeOnly = { ...t, lockMemory: false, memoryClockMHz: undefined };
    const during = samples(['x, 480, 405, 30', 'x, 480, 7000, 70']);
    const after = samples(['x, 1530, 7000, 31']);
    expect(judge(computeOnly, during, after)).toEqual({ graphicsLockHeld: true, memoryLock: 'not-locked', lockHeld: true, reset: 'verified' });
  });
});

describe('a compute-only profile and the floor check', () => {
  const computeOnly: StandinProfile = {
    gpu: 'Example GPU 3000',
    targets: { 'iris-xe': { label: 'Iris Xe class', graphicsClockMHz: 645, lockMemory: false, cpus: '0-3', cpuQuota: '300%', memoryMax: '4G', size: '1280x720', floorFps: 30, headroom: 1.5 } },
  };

  it('accepts a profile without a memory clock when memory is not locked, and plans no memory lock', () => {
    expect(validateProfile(computeOnly).errors).toEqual([]);
    const p = planRun({ profile: computeOnly, target: 'iris-xe', clientPath: '/c', seconds: 5, outDir: '/o', stamp: 'S' });
    expect(p.lock).toEqual([['sudo', 'nvidia-smi', '--id=0', '--lock-gpu-clocks=645,645']]);
    expect(p.reset.map((c) => c.at(-1))).toEqual(['--reset-gpu-clocks', '--reset-memory-clocks']);
  });

  it('checks the graphics clock against the top memory clock when memory is not locked', () => {
    const supported = parseSupportedClocks(SUPPORTED);
    expect(checkClocks(computeOnly.targets['iris-xe']!, supported)).toEqual([]);
    expect(checkClocks({ ...computeOnly.targets['iris-xe']!, graphicsClockMHz: 300 }, supported)[0]).toContain('not offered with memory at 7001 MHz');
  });

  it('still needs a memory clock when memory is locked, and checks floor and headroom', () => {
    const rest: Record<string, unknown> = { ...PROFILE.targets['iris-xe']! };
    delete rest['memoryClockMHz'];
    expect(validateProfile({ gpu: 'g', targets: { a: { ...rest, lockMemory: true } } }).errors[0]).toContain('memoryClockMHz');
    expect(validateProfile({ gpu: 'g', targets: { a: { ...computeOnly.targets['iris-xe']!, headroom: 9 } } }).errors[0]).toContain('headroom');
  });

  it('passes the floor only with the headroom on the average and the floor on the 1% low', () => {
    const t = computeOnly.targets['iris-xe']!;
    expect(floorCheck(t, { avgFps: 50, low1PctFps: 31 })).toMatchObject({ needAvgFps: 45, needLowFps: 30, pass: true });
    expect(floorCheck(t, { avgFps: 44, low1PctFps: 40 })?.pass).toBe(false);
    expect(floorCheck(t, { avgFps: 60, low1PctFps: 25 })?.pass).toBe(false);
    expect(floorCheck(PROFILE.targets['iris-xe']!, { avgFps: 60, low1PctFps: 25 })).toBeUndefined();
  });
});
