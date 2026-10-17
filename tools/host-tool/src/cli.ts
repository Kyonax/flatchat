// SPDX-License-Identifier: MPL-2.0
// The host tool (S2.02): everything a host needs, from a terminal.
//
//   host signin --core URL          sign in through the browser; the session stays in ~/.config/flatchat
//   host new DIR [--from plaza]     a new world folder (from the plaza, or an empty starter)
//   host check DIR                  validate a world folder against the world format
//   host build DIR [OUT]            convert it into what a world server serves (default OUT: DIR/.built)
//   host request --name N [--capacity 50] [--unlisted]   ask the core to approve a world hosted here
//                                   (relayed; at most 200 players; --unlisted: reached by its ID only)
//   host worlds                     your worlds: status, listed or not, online, players
//   host listing WORLD_ID on|off    put a world on the public list, or take it off (S2.09)
//   host key WORLD_ID               fetch an approved world's key (kept in ~/.config/flatchat/worlds)
//   host run DIR --world-id ID [--map-port] [--ice-server URL]…   build if needed, then run it
//   host advise [--mbps N]          measure the upload (Cloudflare's speed test) and suggest a capacity
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateWorld } from '@flatchat/content';
import { ConvertError, convertWorld, readFolder, writeBuilt } from '@flatchat/converter';
import { access, api, coreUrl, HostError, loadSession, saveSession, saveWorldKey, signIn, worldEnvFile } from './account.ts';
import { advise, measureUpload } from './advisor.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const PLAZA = join(ROOT, 'kits', 'worlds', 'plaza');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    core: { type: 'string' },
    from: { type: 'string', default: 'plaza' },
    name: { type: 'string' },
    capacity: { type: 'string', default: '50' },
    unlisted: { type: 'boolean', default: false },
    'world-id': { type: 'string' },
    'map-port': { type: 'boolean', default: false },
    'ice-server': { type: 'string', multiple: true },
    mbps: { type: 'string' },
    'rtc-port': { type: 'string', default: '7778' },
  },
});
const [command, a1, a2] = positionals;
const say = (line: string): void => void process.stdout.write(`${line}\n`);

async function build(dir: string, out: string): Promise<void> {
  const { world, warnings } = await convertWorld(readFolder(dir)).then((r) => {
    writeBuilt(out, r.out);
    return r;
  });
  for (const w of warnings) say(`warning: ${w}`);
  say(`built "${world.manifest.name}": ${world.files.length} files, ${world.files.reduce((n, f) => n + f.size, 0)} bytes → ${out}`);
}

async function main(): Promise<number> {
  switch (command) {
    case 'signin': {
      const core = coreUrl(values.core ?? loadSession()?.core ?? '');
      const r = await signIn(core);
      saveSession({ core, refresh: r.refresh });
      say(`signed in to ${core} as ${r.name}`);
      return 0;
    }
    case 'new': {
      const dir = resolve(a1 ?? '');
      if (!a1 || existsSync(dir)) throw new HostError('host new DIR: a folder that does not exist yet');
      if (values.from === 'plaza') cpSync(PLAZA, dir, { recursive: true });
      else throw new HostError('--from plaza is the template for now');
      say(`made ${dir} from the ${values.from}: edit world.toml and the scene in Blender, then host check ${a1}`);
      return 0;
    }
    case 'check': {
      const report = validateWorld(readFolder(resolve(a1 ?? '.')));
      for (const p of report.problems) say(`${p.severity}: ${p.code} ${p.file} ${p.at}: ${p.message}`);
      say(report.ok ? `ok: "${report.manifest?.name}", ${report.scenes.length} scene(s), ${report.scenes.reduce((n, s) => n + s.triangles, 0)} triangles` : 'refused');
      return report.ok ? 0 : 1;
    }
    case 'build': {
      const dir = resolve(a1 ?? '.');
      await build(dir, resolve(a2 ?? join(dir, '.built')));
      return 0;
    }
    case 'request': {
      if (!values.name) throw new HostError('host request --name "World name"');
      const { core, access: a } = await access();
      const w = await api.request(fetch, core, a, values.name, Number(values.capacity), !values.unlisted);
      say(`asked ${core} to approve "${values.name}": ${w.id} (${w.status}${values.unlisted ? ', unlisted' : ''}). Once approved: host key ${w.id}`);
      return 0;
    }
    case 'worlds': {
      const { core, access: a } = await access();
      for (const w of (await api.worlds(fetch, core, a)).worlds) {
        say(`${w.id}  ${w.status.padEnd(8)}  ${w.listed ? 'listed  ' : 'unlisted'}  ${w.online ? `online, ${w.players} of ${w.capacity}` : 'offline'}  ${w.name}`);
      }
      return 0;
    }
    case 'listing': {
      if (!a1 || (a2 !== 'on' && a2 !== 'off')) throw new HostError('host listing WORLD_ID on|off');
      const { core, access: a } = await access();
      const w = await api.update(fetch, core, a, a1, { listed: a2 === 'on' });
      say(`${w.name} is ${w.listed ? 'on the public list (until it reaches its recommended count)' : 'off the public list: players reach it by its ID'}`);
      return 0;
    }
    case 'key': {
      if (!a1) throw new HostError('host key WORLD_ID');
      const { core, access: a } = await access();
      const { key } = await api.key(fetch, core, a, a1);
      say(`kept the key of ${a1} in ${saveWorldKey(a1, key)}`);
      return 0;
    }
    case 'run': {
      const dir = resolve(a1 ?? '.');
      const id = values['world-id'] ?? '';
      const envFile = worldEnvFile(id);
      if (!existsSync(envFile)) throw new HostError(`no key for world ${id}: run host key ${id}`);
      const session = loadSession();
      if (!session) throw new HostError('not signed in: run host signin --core URL');
      const out = join(dir, '.built');
      if (!existsSync(join(out, 'world.json')) || statSync(join(dir, 'world.toml')).mtimeMs > statSync(join(out, 'world.json')).mtimeMs) await build(dir, out);
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1]!] = m[2]!;
      }
      const args = [SERVER_MAIN, '--transport', 'rtc', '--world', out, '--core', session.core, '--relay', '--rtc-port', values['rtc-port'], ...(values['map-port'] ? ['--map-port'] : []), ...(values['ice-server'] ?? ['stun:stun.cloudflare.com:3478']).flatMap((u) => ['--ice-server', u])];
      say(`running ${id} from ${out}: Ctrl+C stops it`);
      const child = spawn(process.execPath, ['--min-semi-space-size=16', '--max-semi-space-size=16', ...args], { env, stdio: 'inherit' });
      return new Promise((r) => child.on('exit', (code) => r(code ?? 1)));
    }
    case 'advise': {
      const mbps = values.mbps !== undefined ? Number(values.mbps) : await measureUpload();
      const a = advise(mbps);
      say(`upload ${a.uploadMbps} Mbps: recommended ${a.recommended} players, at most ${a.maximum}; if everyone gathers in one place, about ${a.crowded}`);
      say(`put them in world.toml: [capacity] recommended = ${a.recommended}, maximum = ${a.maximum}`);
      return 0;
    }
    default:
      process.stderr.write('usage: host signin|new|check|build|request|worlds|listing|key|run|advise … (see the header of tools/host-tool/src/cli.ts)\n');
      return 2;
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof ConvertError) {
    for (const p of err.report.problems) process.stderr.write(`${p.severity}: ${p.code} ${p.file} ${p.at}: ${p.message}\n`);
  } else {
    process.stderr.write(`host: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
}
