// SPDX-License-Identifier: MPL-2.0
// The harness: every headless check of the repository in one command, in a fixed order, with a
// PASS or FAIL line per check and the output of each failure. Agents, people and CI run the same.
//
//   npm run harness [-- --only a,b] [-- --skip a,b] [-- --with-client] [-- --verbose] [-- --list]
//
// lock    package-lock.json in step with every package.json (what CI's npm ci needs)
// layout  the folders, licence files and SPDX headers      skill   the agent skill's shape
// traps   the trap linter                                   lint    ESLint
// types   TypeScript in every workspace                     tests   unit and process tests
// server  a real world server, headless: ready, 50 ticks, a clean stop
// client  (only with --with-client) the client's smoke test, which needs a display
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI = process.env['GITHUB_ACTIONS'] === 'true';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let verbose = false;

interface Result {
  ok: boolean;
  output: string;
  detail?: string;
}

interface Check {
  name: string;
  title: string;
  run: () => Promise<Result>;
  optional?: boolean;
}

function command(cmd: string, args: string[], timeoutMs = 600_000): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' } });
    let output = '';
    const take = (d: Buffer): void => {
      output += d.toString();
      if (CI || verbose) process.stdout.write(d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output });
    });
  });
}

const node = (...args: string[]): Promise<Result> => command(process.execPath, args);
const npm = (...args: string[]): Promise<Result> => command(NPM, ['run', '--silent', ...args]);

async function serverCheck(): Promise<Result> {
  const ticks = 50;
  const hz = 50;
  const r = await command(process.execPath, ['apps/world-server/src/main.ts', '--port', '0', '--tick-hz', String(hz), '--ticks', String(ticks)], 20_000);
  const events = r.output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const ready = events.find((e) => e['event'] === 'ready');
  const stopped = events.find((e) => e['event'] === 'stopped');
  const problems: string[] = [];
  if (!r.ok) problems.push('the server did not exit with code 0');
  if (!ready || !(Number(ready['port']) > 0)) problems.push('no "ready" line with a UDP port');
  if (!stopped || stopped['reason'] !== 'tick-limit' || stopped['ticks'] !== ticks) problems.push(`no clean stop after ${ticks} ticks`);
  if (problems.length > 0) return { ok: false, output: `${r.output}\n${problems.join('\n')}` };
  return {
    ok: true,
    output: r.output,
    detail: `UDP port ${String(ready?.['port'])}, ${ticks} ticks at ${hz} Hz in ${String(stopped?.['uptimeMs'])} ms, slowest tick ${Number(stopped?.['slowestTickMs']).toFixed(2)} ms`,
  };
}

const CHECKS: Check[] = [
  { name: 'lock', title: 'package-lock.json in step with every package.json', run: () => node('tools/harness/src/lock-check.ts') },
  { name: 'layout', title: 'Folders, licence files and SPDX headers', run: () => node('tools/repo/check-layout.mjs') },
  { name: 'skill', title: 'The agent skill', run: () => node('tools/harness/src/skill-check.ts') },
  { name: 'traps', title: 'Trap linter', run: () => node('tools/harness/src/trap-lint.ts') },
  { name: 'lint', title: 'ESLint', run: () => npm('lint') },
  { name: 'types', title: 'TypeScript in every workspace', run: () => npm('typecheck') },
  { name: 'tests', title: 'Unit and process tests', run: () => npm('test') },
  { name: 'server', title: 'World server, headless', run: serverCheck },
  { name: 'client', title: 'Client smoke test (needs a display)', run: () => npm('client:smoke'), optional: true },
];

function tail(text: string, lines = 80): string {
  return text.trimEnd().split('\n').slice(-lines).map((l) => `    ${l}`).join('\n');
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        only: { type: 'string' },
        skip: { type: 'string' },
        'with-client': { type: 'boolean' },
        verbose: { type: 'boolean' },
        list: { type: 'boolean' },
      },
    }));
  } catch (err) {
    console.error(`harness: ${(err as Error).message}`);
    return 2;
  }
  verbose = values.verbose ?? false;
  if (values.list) {
    for (const c of CHECKS) console.log(`${c.name.padEnd(7)} ${c.title}${c.optional ? '  (only with --with-client)' : ''}`);
    return 0;
  }
  const names = (s: string | undefined): string[] => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const only = names(values.only);
  const skip = names(values.skip);
  const unknown = [...only, ...skip].filter((n) => !CHECKS.some((c) => c.name === n));
  if (unknown.length > 0) {
    console.error(`harness: no check named ${unknown.join(', ')}; see --list`);
    return 2;
  }
  const selected = CHECKS.filter((c) => (only.length ? only.includes(c.name) : !c.optional || values['with-client']) && !skip.includes(c.name));

  const started = performance.now();
  const failed: string[] = [];
  for (const c of selected) {
    if (CI) console.log(`::group::${c.title}`);
    const t0 = performance.now();
    const r = await c.run();
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    if (CI) console.log('::endgroup::');
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(7)} ${c.title} (${seconds} s)${r.detail ? ` · ${r.detail}` : ''}`);
    if (!r.ok) {
      failed.push(c.name);
      if (CI) console.log(`::error title=harness ${c.name}::${c.title} failed`);
      else if (!verbose) console.log(tail(r.output));
    }
  }
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`harness: ${selected.length - failed.length} of ${selected.length} passed in ${total} s${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
