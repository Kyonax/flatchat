// SPDX-License-Identifier: MPL-2.0
// The weak-laptop stand-in: makes this desktop's NVIDIA card and CPU behave like an integrated-
// graphics laptop (an Intel Iris Xe or AMD Radeon 680M class), runs the client's bench on it and
// logs every frame time, then puts the card back. The clock lines need root, so they run through
// sudo in the person's own terminal; everything else runs as that person. `plan` prints every
// command and changes nothing: read it first.
//
//   npm run standin -- plan   --target iris-xe [--profile FILE] [--seconds 60] [--client PATH] [--out DIR] [--no-query]
//                             [--crowd DIR [--full N] [--lod N] [--present N]]   (spike S0.09: the crowd bench on DIR's avatars)
//   npm run standin -- run    --target iris-xe [the same options]
//   npm run standin -- status        the card's clocks now (read-only)
//   npm run standin -- reset         the two reset lines alone, through sudo
//
// The profile (clocks and limits per target) belongs to the machine, not to the repository:
// --profile FILE, else $FLATCHAT_STANDIN_PROFILE, else ~/.config/flatchat/standin.json.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CHECK_SECONDS,
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
  type Plan,
  type Runner,
  type StandinProfile,
} from './standin-plan.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_CLIENT = join(ROOT, 'apps', 'client', 'release', 'linux-unpacked', 'flatchat');
const DEFAULT_OUT = join(ROOT, 'out', 'standin');

const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);
const shell = (cmd: Cmd): string => cmd.map(quote).join(' ');

function profilePath(option: string | undefined): string {
  if (option) return resolve(option);
  const env = process.env['FLATCHAT_STANDIN_PROFILE'];
  if (env) return resolve(env);
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'flatchat', 'standin.json');
}

function loadProfile(path: string): StandinProfile {
  if (!existsSync(path)) {
    throw new Error(`no profile at ${path}. Write one for this machine (the skill's stand-in rule shows the format and the method), or pass --profile FILE`);
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const { profile, errors } = validateProfile(data);
  if (!profile) throw new Error(`${path}:\n  - ${errors.join('\n  - ')}`);
  return profile;
}

function capture(cmd: Cmd): { ok: boolean; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

interface Check {
  ok: boolean;
  text: string;
}

/** Read-only checks; a run starts only when every one passes. */
function preflight(profile: StandinProfile, plan: Plan, clientPath: string, query: boolean, gpuIndex: number): Check[] {
  const checks: Check[] = [];
  const uid = process.getuid?.();
  checks.push({ ok: uid !== 0, text: uid === 0 ? 'running as root: run as yourself; only the clock lines use sudo' : 'not running as root' });
  checks.push({ ok: process.platform === 'linux', text: `platform ${process.platform} (the stand-in needs Linux)` });
  const missing = ['nvidia-smi', 'sudo', 'systemd-run', 'taskset'].filter((c) => !capture([c, '--version']).ok);
  checks.push({ ok: missing.length === 0, text: missing.length ? `missing: ${missing.join(', ')}` : 'nvidia-smi, sudo, systemd-run and taskset found' });
  if (query && !missing.includes('nvidia-smi')) {
    const name = capture(['nvidia-smi', `--id=${gpuIndex}`, '--query-gpu=name', '--format=csv,noheader']).out;
    checks.push({ ok: name === profile.gpu, text: name === profile.gpu ? `card matches the profile: ${name}` : `card is "${name}", the profile is for "${profile.gpu}"` });
    const supported = parseSupportedClocks(capture(['nvidia-smi', `--id=${gpuIndex}`, '-q', '-d', 'SUPPORTED_CLOCKS']).out);
    const problems = checkClocks(plan.profile, supported);
    checks.push({
      ok: problems.length === 0,
      text:
        problems[0] ??
        (plan.profile.lockMemory === false
          ? `${plan.profile.graphicsClockMHz} MHz graphics is offered at the card's top memory clock (memory is not locked: a compute-only stand-in)`
          : `${plan.profile.graphicsClockMHz} MHz graphics with ${String(plan.profile.memoryClockMHz)} MHz memory is a supported pair`),
    });
  }
  if (uid !== undefined) {
    const file = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
    const controllers = existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/) : [];
    const ok = controllers.includes('cpu') && controllers.includes('memory');
    checks.push({ ok, text: ok ? 'the systemd user manager delegates the cpu and memory controllers' : `the systemd user manager does not delegate cpu and memory (${file})` });
  }
  let runnable = true;
  try {
    accessSync(clientPath, constants.X_OK);
  } catch {
    runnable = false;
  }
  checks.push({ ok: runnable, text: runnable ? `client build: ${clientPath}` : `no client build at ${clientPath}: run npm run dist:linux -w @flatchat/client` });
  return checks;
}

function printPlan(plan: Plan, profileFile: string, profile: StandinProfile, checks: Check[]): void {
  console.log(`standin plan · target ${plan.target}: ${plan.profile.label}`);
  console.log(`profile: ${profileFile} (card: ${profile.gpu})`);
  if (plan.profile.lockMemory === false) console.log('memory: not locked (lockMemory: false): a compute-only stand-in, so read results with its headroom');
  if (plan.profile.floorFps !== undefined) {
    console.log(`floor check: an average of at least ${plan.profile.floorFps * (plan.profile.headroom ?? 1)} fps and a 1% low of at least ${plan.profile.floorFps} fps at ${plan.profile.size}`);
  }
  if (plan.profile.note) console.log(`note: ${plan.profile.note}`);
  console.log('preflight (read-only):');
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.text}`);
  console.log('commands, in order (a dry run runs none of them):');
  const rows: [string, string, string][] = [
    ['root', shell(plan.auth), 'asks for your password once, before anything changes'],
    ...plan.lock.map((c) => ['root', shell(c), 'lock the clock; what the driver prints is kept in run.json'] as [string, string, string]),
    ['bg', `${shell(plan.sampler)} > ${quote(plan.clocksFile)}`, 'sample the clocks twice a second'],
    ['', shell(plan.client), `the bench: 4 cores, CPU and memory caps, ${plan.profile.size}`],
    ...plan.reset.map((c) => ['root', shell(c), 'always, also after a failure or Ctrl+C'] as [string, string, string]),
    ['bg', `${shell(plan.sampler)} > ${quote(plan.afterClocksFile)}`, 'sample again'],
    ['', shell(plan.check), `${CHECK_SECONDS} s uncapped: the clocks must rise above the lock`],
  ];
  rows.forEach(([tag, cmd, why], i) => console.log(`  ${String(i + 1).padStart(2)} ${tag.padEnd(4)} ${cmd}\n          ↳ ${why}`));
  console.log(`outputs: ${plan.outDir}/ (frames.json, clocks.csv, after-reset-frames.json, after-reset-clocks.csv, run.json)`);
}

let current: ChildProcess | undefined;

const realRunner: Runner = {
  run: (cmd, options) =>
    new Promise((done) => {
      // Captured commands keep the terminal as stdin, so sudo can still ask for a password.
      const child = spawn(cmd[0]!, cmd.slice(1), { stdio: options?.inherit ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
      current = child;
      let output = '';
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      child.on('error', (err) => done({ code: 127, output: err.message }));
      child.on('close', (code, signal) => {
        if (current === child) current = undefined;
        done({ code: code ?? (signal ? 128 : 1), output });
      });
    }),
  background: (cmd, outFile) => {
    const fd = openSync(outFile, 'w');
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['ignore', fd, 'ignore'] });
    const closed = new Promise<void>((done) => child.on('close', () => done()));
    return {
      stop: async () => {
        child.kill('SIGINT');
        await closed;
        closeSync(fd);
      },
    };
  },
  log: (line) => console.log(line),
};

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function run(plan: Plan, profileFile: string, profile: StandinProfile): Promise<number> {
  mkdirSync(plan.outDir, { recursive: true });
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    interrupted = true;
    console.log(`\nstandin: ${sig}: stopping the client; the reset lines still run`);
    current?.kill(sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, onSignal);

  console.log(`standin: locking the card to ${plan.profile.label}; sudo may ask for your password`);
  const outcome = await execute(plan, realRunner, () => interrupted);

  const during = summarizeClocks(parseClockSamples(existsSync(plan.clocksFile) ? readFileSync(plan.clocksFile, 'utf8') : ''));
  const after = summarizeClocks(parseClockSamples(existsSync(plan.afterClocksFile) ? readFileSync(plan.afterClocksFile, 'utf8') : ''));
  const verdict = judge(plan.profile, during, after);
  const frames = readJson(plan.framesFile);
  const floor = floorCheck(plan.profile, frames?.['summary'] as { avgFps: number; low1PctFps: number } | undefined);
  const report = {
    event: 'standin',
    target: plan.target,
    profile: { file: profileFile, gpu: profile.gpu, ...plan.profile },
    commands: { auth: plan.auth, lock: plan.lock, sampler: plan.sampler, client: plan.client, reset: plan.reset, check: plan.check },
    outcome,
    clocks: { during, after },
    verdict,
    floor: floor ?? null,
    bench: frames ? { backend: frames['backend'], adapter: frames['adapter'], width: frames['width'], height: frames['height'], summary: frames['summary'] } : null,
    ...(plan.kind === 'crowd' && frames ? { crowd: { pass: frames['pass'], tiers: frames['tiers'], memory: frames['memory'], loads: frames['loads'], duringLoads: frames['duringLoads'] } } : {}),
  };
  writeFileSync(plan.reportFile, `${JSON.stringify(report, null, 2)}\n`);

  const s = frames?.['summary'] as Record<string, number> | undefined;
  console.log(`\nstandin: ${plan.target} · ${String(frames?.['backend'] ?? 'no bench result')}${s ? ` · ${s['frames']} frames in ${s['seconds']} s · ${s['avgFps']} fps average · p95 ${s['p95Ms']} ms · 1% low ${s['low1PctFps']} fps` : ''}`);
  const memoryText = { held: 'lock held', 'not-held': 'lock NOT held', 'not-locked': 'not locked (compute-only profile)' }[verdict.memoryLock];
  console.log(`  clocks during the run (${during.samples} samples): graphics ${during.graphicsMinMHz}–${during.graphicsMaxMHz} MHz, ${verdict.graphicsLockHeld ? 'lock held' : 'lock NOT held'}; memory ${during.memoryMinMHz}–${during.memoryMaxMHz} MHz, ${memoryText}`);
  console.log(`  after the reset: graphics up to ${after.graphicsMaxMHz} MHz, memory up to ${after.memoryMaxMHz} MHz: reset ${verdict.reset}`);
  if (verdict.graphicsLockHeld && verdict.memoryLock === 'not-held') {
    console.log(`  The memory lock was not enforced; the driver said: ${outcome.lockOutput[1] || '(nothing)'}`);
    console.log('  So this run imitates the target\'s compute only: memory bandwidth stayed the card\'s own (optimistic), and memory-clock changes can stall frames.');
    console.log('  If this card never enforces it, set "lockMemory": false in the profile and give the target a headroom.');
  }
  const pass = frames?.['pass'] as Array<{ what: string; limit: string; value: string; ok: boolean }> | undefined;
  if (plan.kind === 'crowd' && pass) {
    for (const line of pass) console.log(`  ${line.ok ? 'PASS' : 'FAIL'}  ${line.what}: ${line.value} (${line.limit})`);
  }
  if (floor && plan.kind === 'bench') {
    console.log(`  floor check: ${floor.avgFps} fps average (needs ${floor.needAvgFps}: ${floor.floorFps} × ${floor.headroom}) and a 1% low of ${floor.lowFps} fps (needs ${floor.needLowFps}): ${floor.pass ? 'PASS' : 'FAIL'}`);
  }
  const kind = !verdict.graphicsLockHeld
    ? 'not a stand-in run'
    : verdict.memoryLock === 'held'
      ? 'a full stand-in run'
      : verdict.memoryLock === 'not-locked'
        ? 'a compute-only stand-in run'
        : 'graphics-only: the driver ignored the memory lock';
  console.log(`  result: ${kind} · report: ${plan.reportFile}`);
  if (verdict.reset !== 'verified') {
    console.log('  The card may still be locked: check with  npm run standin -- status  and clear it with  npm run standin -- reset  (or reboot).');
  }
  const ok = !outcome.error && outcome.clientCode === 0 && outcome.resetCodes.every((c) => c === 0) && verdict.graphicsLockHeld && verdict.reset !== 'not-verified';
  if (outcome.error) console.log(`  error: ${outcome.error}`);
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        target: { type: 'string' },
        profile: { type: 'string' },
        seconds: { type: 'string', default: '60' },
        client: { type: 'string' },
        out: { type: 'string' },
        'no-query': { type: 'boolean' },
        'gpu-index': { type: 'string', default: '0' },
        crowd: { type: 'string' },
        full: { type: 'string' },
        lod: { type: 'string' },
        present: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`standin: ${(err as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  const gpuIndex = Number(values['gpu-index']);
  if (command === 'status') {
    return spawnSync('nvidia-smi', [`--id=${gpuIndex}`, '--query-gpu=name,pstate,clocks.gr,clocks.mem,clocks.max.gr,clocks.max.mem,clocks_event_reasons.applications_clocks_setting', '--format=csv'], { stdio: 'inherit' }).status ?? 1;
  }
  if (command === 'reset') {
    let code = 0;
    for (const flag of ['--reset-gpu-clocks', '--reset-memory-clocks']) {
      const cmd = ['sudo', 'nvidia-smi', `--id=${gpuIndex}`, flag];
      console.log(`$ ${shell(cmd)}`);
      code ||= spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'inherit' }).status ?? 1;
    }
    return code;
  }
  if (command !== 'plan' && command !== 'run') {
    console.error('usage: standin plan|run --target NAME [--profile FILE] [--seconds 60] [--client PATH] [--out DIR] [--no-query] [--crowd DIR [--full N] [--lod N] [--present N]]\n       standin status | reset');
    return 2;
  }
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
    console.error('standin: --seconds must be from 5 to 3600');
    return 2;
  }
  const file = profilePath(values.profile);
  let profile: StandinProfile;
  try {
    profile = loadProfile(file);
  } catch (err) {
    console.error(`standin: ${(err as Error).message}`);
    return 1;
  }
  const target = values.target;
  if (!target || !profile.targets[target]) {
    console.error(`standin: pick a target with --target: ${Object.keys(profile.targets).join(', ')}`);
    return 2;
  }
  const clientPath = resolve(values.client ?? DEFAULT_CLIENT);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const count = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  const crowd = values.crowd ? { avatars: resolve(values.crowd), full: count(values.full), lod: count(values.lod), present: count(values.present) } : undefined;
  const plan = planRun({ profile, target, clientPath, seconds, outDir: resolve(values.out ?? DEFAULT_OUT), stamp, gpuIndex, ...(crowd ? { crowd } : {}) });
  const checks = preflight(profile, plan, clientPath, !values['no-query'], gpuIndex);
  printPlan(plan, file, profile, checks);
  if (command === 'plan') return 0;
  if (checks.some((c) => !c.ok)) {
    console.error('standin: a preflight check failed, so nothing ran and the card is untouched');
    return 1;
  }
  return run(plan, file, profile);
}

if (import.meta.main) process.exitCode = await main();
