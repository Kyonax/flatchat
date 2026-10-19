// SPDX-License-Identifier: MPL-2.0
// An isolated network for a measured run, with no root and no change to the machine: a new user
// and network namespace (`unshare -Urn`) holds only its own loopback interface, so no other
// program's traffic mixes in. Inside it this process is root of that namespace only, which lets
// it set the interface's MTU, add nftables counters for every datagram to and from the world
// server's ports (the bytes on the wire, IP and UDP headers included, which the transports cannot
// see themselves), and optionally add delay and loss with netem. Everything ends with the run.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function isIsolated(): boolean {
  return process.env['FLATCHAT_NETNS'] === '1';
}

export function canIsolate(): boolean {
  if (process.platform !== 'linux') return false;
  return spawnSync('unshare', ['-Urn', 'true'], { stdio: 'ignore' }).status === 0;
}

/** Runs this program again inside a fresh namespace; resolves with its exit code. */
export function reexecIsolated(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('unshare', ['-Urn', '--', process.execPath, ...process.execArgv, script, ...args], {
      stdio: 'inherit',
      env: { ...process.env, FLATCHAT_NETNS: '1', FLATCHAT_OUTER_IDS: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * A command to run as the user who started the run. Inside the namespace this process is root, and
 * Electron refuses to start as root; a nested user namespace maps that user back, so the client runs
 * as itself with its own sandbox, still on the isolated network. Outside, the command is unchanged.
 */
export function asOuterUser(command: string[]): string[] {
  const ids = process.env['FLATCHAT_OUTER_IDS'];
  if (!isIsolated() || !ids) return command;
  const [uid, gid] = ids.split(':');
  return ['unshare', '-U', `--map-user=${uid}`, `--map-group=${gid}`, '--', ...command];
}

export interface NetworkSetup {
  mtu: number;
  /** netem arguments, for example "delay 20ms 2ms loss 0.5%" (each direction crosses loopback once). */
  netem?: string;
  /** UDP ports to count both ways. */
  ports: number[];
}

export function setupNetwork({ mtu, netem, ports }: NetworkSetup): void {
  execFileSync('ip', ['link', 'set', 'lo', 'mtu', String(mtu), 'up']);
  const rules = ['table inet flatchat {', '  chain out {', '    type filter hook output priority 0; policy accept;'];
  for (const port of ports) {
    rules.push(`    udp sport ${port} counter comment "from-${port}"`);
    rules.push(`    udp dport ${port} counter comment "to-${port}"`);
  }
  rules.push('  }', '}');
  // nft 1.1 (Ubuntu 24.04's runners) refuses `nft -f -`: it stats /dev/stdin and
  // errors "Not a regular file". A real file is the same ruleset.
  const dir = mkdtempSync(join(tmpdir(), 'flatchat-nft-'));
  const file = join(dir, 'rules.nft');
  try {
    writeFileSync(file, rules.join('\n'));
    execFileSync('nft', ['-f', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (netem) execFileSync('tc', ['qdisc', 'add', 'dev', 'lo', 'root', 'netem', ...netem.trim().split(/\s+/)]);
}

/**
 * Gives the namespace a private address on a dummy interface and returns it, or undefined when the
 * kernel cannot make one. Chromium leaves loopback out of WebRTC's candidates, so a real client in
 * a loopback-only namespace never finishes gathering; traffic to this address still goes through
 * the loopback interface (it is local), so netem and the counters still see it.
 */
export function addPrivateAddress(address = '10.77.0.1'): string | undefined {
  try {
    execFileSync('ip', ['link', 'add', 'flat0', 'type', 'dummy'], { stdio: 'ignore' });
    execFileSync('ip', ['addr', 'add', `${address}/24`, 'dev', 'flat0']);
    execFileSync('ip', ['link', 'set', 'flat0', 'up']);
    return address;
  } catch {
    return undefined;
  }
}

export interface Counter {
  packets: number;
  bytes: number;
}

interface NftRule {
  rule?: { comment?: string; expr?: Array<{ counter?: Counter }> };
}

/** The counters by name (from-PORT, to-PORT), plus the loopback interface's own totals. */
export function readCounters(): Record<string, Counter> {
  const out: Record<string, Counter> = {};
  const parsed = JSON.parse(execFileSync('nft', ['-j', 'list', 'table', 'inet', 'flatchat'], { encoding: 'utf8' })) as { nftables?: NftRule[] };
  for (const item of parsed.nftables ?? []) {
    const rule = item.rule;
    const counter = rule?.expr?.find((e) => e.counter)?.counter;
    if (rule?.comment && counter) out[rule.comment] = { packets: counter.packets, bytes: counter.bytes };
  }
  const link = JSON.parse(execFileSync('ip', ['-s', '-j', 'link', 'show', 'lo'], { encoding: 'utf8' })) as Array<{ stats64?: { tx?: Counter } }>;
  const tx = link[0]?.stats64?.tx;
  if (tx) out['lo'] = { packets: tx.packets, bytes: tx.bytes };
  return out;
}
