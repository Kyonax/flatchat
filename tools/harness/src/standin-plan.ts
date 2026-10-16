// SPDX-License-Identifier: MPL-2.0
// The weak-laptop stand-in, planned: the profile's shape, nvidia-smi's output read, the exact
// commands of one run in order, the run itself through a replaceable runner, and the verdict on
// its clock samples. The runner is the only part that touches the machine, so the unit tests run
// the real sequence against a fake one: no GPU, no sudo and no client needed.

export type Cmd = readonly string[];

/** One laptop class the desktop card imitates. */
export interface TargetProfile {
  label: string;
  /** Locked as min = max, from the card's supported list for the memory clock below. */
  graphicsClockMHz: number;
  memoryClockMHz: number;
  /** taskset's CPU list, for example "0-3". */
  cpus: string;
  /** systemd's CPUQuota for the client's scope, for example "300%". */
  cpuQuota: string;
  /** systemd's MemoryMax for the client's scope, for example "4G". */
  memoryMax: string;
  /** The drawing buffer, for example "1280x720". */
  size: string;
  note?: string;
}

export interface StandinProfile {
  /** The card's exact name, as `nvidia-smi --query-gpu=name` prints it. */
  gpu: string;
  source?: string;
  targets: Record<string, TargetProfile>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function validateProfile(data: unknown): { profile?: StandinProfile; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(data)) return { errors: ['the profile must be a JSON object'] };
  if (typeof data['gpu'] !== 'string' || !data['gpu'].trim()) errors.push('gpu: the card\'s exact name from nvidia-smi is required');
  const targets = data['targets'];
  if (!isObject(targets) || Object.keys(targets).length === 0) {
    errors.push('targets: at least one target is required');
  } else {
    for (const [name, t] of Object.entries(targets)) {
      const at = `targets.${name}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`${at}: use lowercase letters, digits and dashes`);
      if (!isObject(t)) {
        errors.push(`${at}: must be an object`);
        continue;
      }
      if (typeof t['label'] !== 'string' || !t['label'].trim()) errors.push(`${at}.label is required`);
      if (!intIn(t['graphicsClockMHz'], 100, 5000)) errors.push(`${at}.graphicsClockMHz must be a whole number of MHz from 100 to 5000`);
      if (!intIn(t['memoryClockMHz'], 100, 40000)) errors.push(`${at}.memoryClockMHz must be a whole number of MHz from 100 to 40000`);
      if (typeof t['cpus'] !== 'string' || !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(t['cpus'])) errors.push(`${at}.cpus must be a CPU list such as "0-3"`);
      if (typeof t['cpuQuota'] !== 'string' || !/^\d{1,4}%$/.test(t['cpuQuota'])) errors.push(`${at}.cpuQuota must look like "300%"`);
      if (typeof t['memoryMax'] !== 'string' || !/^\d+(\.\d+)?[KMGT]?$/.test(t['memoryMax'])) errors.push(`${at}.memoryMax must look like "4G"`);
      if (typeof t['size'] !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(t['size'])) errors.push(`${at}.size must look like "1280x720"`);
    }
  }
  return errors.length ? { errors } : { profile: data as unknown as StandinProfile, errors };
}

/** Memory clock → its supported graphics clocks, from `nvidia-smi -q -d SUPPORTED_CLOCKS`. */
export function parseSupportedClocks(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let memory: number | undefined;
  for (const line of text.split('\n')) {
    const mem = /^\s*Memory\s*:\s*(\d+)\s*MHz/.exec(line);
    if (mem) {
      memory = Number(mem[1]);
      if (!out.has(memory)) out.set(memory, []);
      continue;
    }
    const gr = /^\s*Graphics\s*:\s*(\d+)\s*MHz/.exec(line);
    if (gr && memory !== undefined) out.get(memory)?.push(Number(gr[1]));
  }
  return out;
}

export function checkClocks(target: TargetProfile, supported: Map<number, number[]>): string[] {
  const graphics = supported.get(target.memoryClockMHz);
  if (!graphics) {
    return [`memory clock ${target.memoryClockMHz} MHz is not supported; the card offers ${[...supported.keys()].join(', ')} MHz`];
  }
  if (!graphics.includes(target.graphicsClockMHz)) {
    const lo = Math.min(...graphics);
    const hi = Math.max(...graphics);
    return [`graphics clock ${target.graphicsClockMHz} MHz is not offered with memory at ${target.memoryClockMHz} MHz (${lo}–${hi} MHz, in its own steps)`];
  }
  return [];
}

export interface Plan {
  target: string;
  profile: TargetProfile;
  outDir: string;
  framesFile: string;
  clocksFile: string;
  afterFramesFile: string;
  afterClocksFile: string;
  reportFile: string;
  lock: Cmd[];
  sampler: Cmd;
  client: Cmd;
  reset: Cmd[];
  check: Cmd;
}

export interface PlanOptions {
  profile: StandinProfile;
  target: string;
  clientPath: string;
  seconds: number;
  outDir: string;
  stamp: string;
  gpuIndex?: number;
}

export const CHECK_SECONDS = 4;

export function planRun(o: PlanOptions): Plan {
  const t = o.profile.targets[o.target];
  if (!t) throw new Error(`no target "${o.target}" in the profile; it has ${Object.keys(o.profile.targets).join(', ')}`);
  const id = `--id=${o.gpuIndex ?? 0}`;
  const dir = `${o.outDir}/${o.stamp}-${o.target}`;
  const bench = (seconds: number, file: string): string[] => [o.clientPath, `--bench=${seconds}`, `--bench-out=${file}`, `--bench-size=${t.size}`];
  const plan: Plan = {
    target: o.target,
    profile: t,
    outDir: dir,
    framesFile: `${dir}/frames.json`,
    clocksFile: `${dir}/clocks.csv`,
    afterFramesFile: `${dir}/after-reset-frames.json`,
    afterClocksFile: `${dir}/after-reset-clocks.csv`,
    reportFile: `${dir}/run.json`,
    lock: [
      ['sudo', 'nvidia-smi', id, `--lock-gpu-clocks=${t.graphicsClockMHz},${t.graphicsClockMHz}`],
      ['sudo', 'nvidia-smi', id, `--lock-memory-clocks=${t.memoryClockMHz},${t.memoryClockMHz}`],
    ],
    sampler: ['nvidia-smi', id, '--query-gpu=timestamp,clocks.gr,clocks.mem,utilization.gpu', '--format=csv,noheader,nounits', '--loop-ms=500'],
    client: [
      'systemd-run', '--user', '--scope', '--quiet', `--unit=flatchat-standin-${o.stamp}`,
      '-p', `CPUQuota=${t.cpuQuota}`, '-p', `MemoryMax=${t.memoryMax}`,
      '--', 'taskset', '--cpu-list', t.cpus, ...bench(o.seconds, `${dir}/frames.json`),
    ],
    reset: [
      ['sudo', 'nvidia-smi', id, '--reset-gpu-clocks'],
      ['sudo', 'nvidia-smi', id, '--reset-memory-clocks'],
    ],
    check: bench(CHECK_SECONDS, `${dir}/after-reset-frames.json`),
  };
  return plan;
}

export interface RunResult {
  code: number;
  stdout: string;
}

/** The only part that touches the machine: real processes in standin.ts, a recorder in the tests. */
export interface Runner {
  /** Run to the end. inherit = share the terminal (sudo's password prompt, the client's log). */
  run(cmd: Cmd, options?: { inherit?: boolean }): Promise<RunResult>;
  /** Start in the background with stdout going to a file; stop() ends it and waits. */
  background(cmd: Cmd, outFile: string): { stop: () => Promise<void> };
  log(line: string): void;
}

export interface Outcome {
  locked: boolean;
  clientCode: number | undefined;
  resetCodes: number[];
  checkCode: number | undefined;
  interrupted: boolean;
  error?: string;
}

/**
 * Lock, measure, and always reset: the reset lines run after a failed lock, a failed client and an
 * interrupt alike. Then a short uncapped run, sampled again, shows whether the clocks are free.
 */
export async function execute(plan: Plan, runner: Runner, interrupted: () => boolean = () => false): Promise<Outcome> {
  const outcome: Outcome = { locked: false, clientCode: undefined, resetCodes: [], checkCode: undefined, interrupted: false };
  try {
    for (const cmd of plan.lock) {
      runner.log(`$ ${cmd.join(' ')}`);
      const r = await runner.run(cmd, { inherit: true });
      if (r.code !== 0) throw new Error(`${cmd.join(' ')} exited with ${r.code}`);
    }
    outcome.locked = true;
    if (!interrupted()) {
      runner.log(`$ ${plan.sampler.join(' ')} > ${plan.clocksFile} &`);
      const sampler = runner.background(plan.sampler, plan.clocksFile);
      try {
        runner.log(`$ ${plan.client.join(' ')}`);
        outcome.clientCode = (await runner.run(plan.client, { inherit: true })).code;
      } finally {
        await sampler.stop();
      }
    }
  } catch (err) {
    outcome.error = (err as Error).message;
  } finally {
    for (const cmd of plan.reset) {
      runner.log(`$ ${cmd.join(' ')}`);
      outcome.resetCodes.push((await runner.run(cmd, { inherit: true })).code);
    }
  }
  outcome.interrupted = interrupted();
  if (!outcome.interrupted && outcome.locked) {
    runner.log(`$ ${plan.sampler.join(' ')} > ${plan.afterClocksFile} &`);
    const sampler = runner.background(plan.sampler, plan.afterClocksFile);
    try {
      runner.log(`$ ${plan.check.join(' ')}`);
      outcome.checkCode = (await runner.run(plan.check, { inherit: true })).code;
    } finally {
      await sampler.stop();
    }
  }
  return outcome;
}

export interface ClockSamples {
  graphics: number[];
  memory: number[];
  utilization: number[];
}

/** Lines of `timestamp, clocks.gr, clocks.mem, utilization.gpu` (csv, no header, no units). */
export function parseClockSamples(csv: string): ClockSamples {
  const out: ClockSamples = { graphics: [], memory: [], utilization: [] };
  for (const line of csv.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) continue;
    const [gr, mem, util] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (![gr, mem, util].every(Number.isFinite)) continue;
    out.graphics.push(gr);
    out.memory.push(mem);
    out.utilization.push(util);
  }
  return out;
}

export interface ClockSummary {
  samples: number;
  graphicsMaxMHz: number;
  graphicsMinMHz: number;
  memoryMaxMHz: number;
  memoryMinMHz: number;
}

export function summarizeClocks(s: ClockSamples): ClockSummary {
  const max = (a: number[]): number => (a.length ? Math.max(...a) : 0);
  const min = (a: number[]): number => (a.length ? Math.min(...a) : 0);
  return {
    samples: s.graphics.length,
    graphicsMaxMHz: max(s.graphics),
    graphicsMinMHz: min(s.graphics),
    memoryMaxMHz: max(s.memory),
    memoryMinMHz: min(s.memory),
  };
}

export type ResetVerdict = 'verified' | 'graphics-only' | 'not-verified';

/** Clock steps are 15 MHz on most cards; one step of slack on the lock, a clear margin on the reset. */
export const LOCK_SLACK_MHZ = 15;
export const RESET_MARGIN_MHZ = 100;

export function judge(t: TargetProfile, during: ClockSummary, after: ClockSummary): { lockHeld: boolean; reset: ResetVerdict } {
  const lockHeld =
    during.samples > 0 &&
    during.graphicsMaxMHz <= t.graphicsClockMHz + LOCK_SLACK_MHZ &&
    during.memoryMaxMHz <= t.memoryClockMHz + LOCK_SLACK_MHZ;
  const graphicsFree = after.samples > 0 && after.graphicsMaxMHz > t.graphicsClockMHz + RESET_MARGIN_MHZ;
  const memoryFree = after.samples > 0 && after.memoryMaxMHz > t.memoryClockMHz + RESET_MARGIN_MHZ;
  return { lockHeld, reset: graphicsFree && memoryFree ? 'verified' : graphicsFree ? 'graphics-only' : 'not-verified' };
}
