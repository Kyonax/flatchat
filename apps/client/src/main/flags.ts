// SPDX-License-Identifier: MPL-2.0
// The client's command-line flags for its two measuring modes, and the exit code of a finished
// run. Free of Electron, so the unit tests run in plain Node.
//
//   --smoke [--smoke-out=FILE]                       draw for a few seconds, report once, quit
//           [--join=http://ADDRESS:PORT/rtc --join-token=HEX]
//                                                    and join that world server over WebRTC (on
//                                                    this machine or the local network, as the
//                                                    signaling bridge allows)
//   --voice-test=SECONDS --join=… --join-token=HEX --listen-token=HEX [--voice-out=FILE]
//                                                    spike S0.08: join twice, send tone bursts
//                                                    from one player to the other, report
//                                                    latency, losses and the fade by distance
//   --voice-load=SECONDS [--voice-out=FILE]          spike S0.08: the cost of hearing 16 voices
//   --lounge=URL --join-token=HEX                    spike S0.08's listening test: walk and talk with
//                                                    others on a world server on this machine or the LAN
//   --census [--census-out=FILE]                     spike S0.10: what this network allows (NAT,
//                                                    port mapping, IPv6) and the GPU, then quit
//   --bench=SECONDS [--bench-out=FILE] [--bench-size=WxH]
//                                                    draw a fixed-size frame with no frame-rate cap
//                                                    and log every frame time (default 1280x720)
//   --crowd=SECONDS --avatars=DIR [--crowd-full=12] [--crowd-lod=20] [--crowd-present=55]
//           [--crowd-springs=6] [--crowd-swap=15] [--crowd-texture-mb=16] [--crowd-lod-ratio=0.3] [--crowd-merge=1]
//           [--crowd-headroom=1] [--crowd-out=FILE] [--crowd-shot=FILE.png] [--bench-size=WxH]
//                                                    spike S0.09: a crowd of the folder's VRM avatars
//                                                    on the low preset, no frame-rate cap; reports
//                                                    frame times, loads, memory and the pass lines

import { signalTarget } from './signal';

export interface Size {
  width: number;
  height: number;
}

export interface ClientFlags {
  smoke: boolean;
  smokeOut?: string;
  /** The smoke test's network check: a loopback world server's signaling URL and a sealed token. */
  join?: { url: string; token: string };
  /** Spike S0.08's voice test: seconds of bursts, and the listening player's token. */
  voiceTest?: number;
  /** Spike S0.08's load test: seconds of 16 voices through the hearing chain. */
  voiceLoad?: number;
  listenToken?: string;
  voiceOut?: string;
  /** Spike S0.08's voice lounge: a world server's signaling URL; its token is join.token. */
  lounge?: string;
  /** Spike S0.10's network census. */
  census?: boolean;
  censusOut?: string;
  /** Seconds to measure, after the warm-up. */
  bench?: number;
  benchOut?: string;
  benchSize: Size;
  crowd?: CrowdFlags;
}

/** Spike S0.09's crowd bench. */
export interface CrowdFlags {
  seconds: number;
  /** The folder of .vrm files; the main process serves it, the page never sees the path. */
  avatars: string;
  full: number;
  lod: number;
  present: number;
  springs: number;
  swap: number;
  /** Each full avatar's texture budget, MB of RGBA with mipmaps (a quarter at the lower detail); 0 keeps them. */
  textureMB: number;
  lodRatio: number;
  /** Merge each avatar's materials into at most three, as the converter will (1), or draw them as exported (0). */
  merge: boolean;
  /** The stand-in's headroom (OQ-24): the frame-time lines divide by it. */
  headroom: number;
  out?: string;
  /** A PNG of the window once the crowd has warmed up: the spike's devlog shot. */
  shot?: string;
}

export const DEFAULT_BENCH_SIZE: Size = { width: 1280, height: 720 };
export const MAX_BENCH_SECONDS = 3600;

function value(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

export function parseSize(text: string): Size | undefined {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(text);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 64 && height >= 64 && width <= 7680 && height <= 4320 ? { width, height } : undefined;
}

export function parseFlags(argv: readonly string[]): { flags: ClientFlags; errors: string[] } {
  const errors: string[] = [];
  const flags: ClientFlags = { smoke: argv.includes('--smoke'), benchSize: DEFAULT_BENCH_SIZE };
  const smokeOut = value(argv, 'smoke-out');
  if (smokeOut) flags.smokeOut = smokeOut;

  const bench = value(argv, 'bench');
  if (bench !== undefined) {
    const seconds = Number(bench);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_BENCH_SECONDS) {
      errors.push(`--bench must be a number of seconds from 1 to ${MAX_BENCH_SECONDS}, got ${bench}`);
    } else {
      flags.bench = seconds;
    }
  }
  const benchOut = value(argv, 'bench-out');
  if (benchOut) flags.benchOut = benchOut;
  const size = value(argv, 'bench-size');
  if (size !== undefined) {
    const parsed = parseSize(size);
    if (parsed) flags.benchSize = parsed;
    else errors.push(`--bench-size must look like 1280x720, got ${size}`);
  }
  if (flags.smoke && flags.bench !== undefined) errors.push('--smoke and --bench cannot run together');
  const voice = value(argv, 'voice-test');
  if (voice !== undefined) {
    const seconds = Number(voice);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) errors.push(`--voice-test must be 1 to 600 seconds, got ${voice}`);
    else flags.voiceTest = seconds;
    const listen = value(argv, 'listen-token');
    if (listen === undefined || !/^([0-9a-f]{2}){16,256}$/.test(listen)) errors.push('--voice-test needs --listen-token=HEX');
    else flags.listenToken = listen;
    const out = value(argv, 'voice-out');
    if (out) flags.voiceOut = out;
    if (flags.smoke || flags.bench !== undefined) errors.push('--voice-test runs alone, without --smoke or --bench');
  }
  const load = value(argv, 'voice-load');
  if (load !== undefined) {
    const seconds = Number(load);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) errors.push(`--voice-load must be 1 to 600 seconds, got ${load}`);
    else flags.voiceLoad = seconds;
    const out = value(argv, 'voice-out');
    if (out) flags.voiceOut = out;
    if (flags.smoke || flags.bench !== undefined || flags.voiceTest !== undefined) errors.push('--voice-load runs alone');
  }
  const lounge = value(argv, 'lounge');
  if (lounge !== undefined) {
    if (!signalTarget(lounge)) errors.push('--lounge must be http(s)://ADDRESS:PORT/rtc on this machine or the local network');
    else flags.lounge = lounge;
    const t = value(argv, 'join-token');
    if (t === undefined || !/^([0-9a-f]{2}){16,256}$/.test(t)) errors.push('--lounge needs --join-token=HEX');
    else flags.join = { url: lounge, token: t };
    if (flags.smoke || flags.bench !== undefined) errors.push('--lounge runs alone');
  }
  if (argv.includes('--census')) {
    flags.census = true;
    const out = value(argv, 'census-out');
    if (out) flags.censusOut = out;
    if (flags.smoke || flags.bench !== undefined || flags.voiceTest !== undefined || flags.voiceLoad !== undefined) errors.push('--census runs alone');
  }
  const crowd = value(argv, 'crowd');
  if (crowd !== undefined) {
    const seconds = Number(crowd);
    const avatars = value(argv, 'avatars');
    const number = (name: string, fallback: number, min: number, max: number, integer = true): number => {
      const text = value(argv, name);
      if (text === undefined) return fallback;
      const n = Number(text);
      if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        errors.push(`--${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}, got ${text}`);
        return fallback;
      }
      return n;
    };
    const full = number('crowd-full', 12, 0, 64);
    const lod = number('crowd-lod', 20, 0, 200);
    const present = number('crowd-present', Math.max(55, full + lod), 0, 1000);
    const springs = number('crowd-springs', Math.min(6, full), 0, 64);
    const textureMB = number('crowd-texture-mb', 16, 0, 1024, false);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_BENCH_SECONDS) errors.push(`--crowd must be a number of seconds from 1 to ${MAX_BENCH_SECONDS}, got ${crowd}`);
    if (!avatars) errors.push('--crowd needs --avatars=DIR, a folder of .vrm files');
    if (present < full + lod) errors.push(`--crowd-present (${present}) must be at least --crowd-full plus --crowd-lod (${full + lod})`);
    if (springs > full) errors.push(`--crowd-springs (${springs}) cannot be more than --crowd-full (${full})`);
    if (flags.smoke || flags.bench !== undefined || flags.voiceTest !== undefined || flags.voiceLoad !== undefined || lounge !== undefined || flags.census) errors.push('--crowd runs alone');
    flags.crowd = {
      seconds,
      avatars: avatars ?? '',
      full,
      lod,
      present,
      springs,
      swap: number('crowd-swap', 15, 0, 600),
      textureMB,
      lodRatio: number('crowd-lod-ratio', 0.3, 0.05, 1, false),
      merge: number('crowd-merge', 1, 0, 1) === 1,
      headroom: number('crowd-headroom', 1, 1, 4, false),
    };
    const out = value(argv, 'crowd-out');
    if (out) flags.crowd.out = out;
    const shot = value(argv, 'crowd-shot');
    if (shot) flags.crowd.shot = shot;
  }
  const join = value(argv, 'join');
  const token = value(argv, 'join-token');
  if (lounge === undefined && (join !== undefined || token !== undefined)) {
    if (!flags.smoke && flags.voiceTest === undefined) errors.push('--join is part of the smoke test: add --smoke');
    else if (join === undefined || token === undefined) errors.push('--join and --join-token go together');
    else if (!signalTarget(join)) errors.push(`--join must be http(s)://ADDRESS:PORT/rtc on this machine or the local network, got ${join}`);
    else if (!/^([0-9a-f]{2}){16,256}$/.test(token)) errors.push('--join-token must be lowercase hexadecimal');
    else flags.join = { url: join, token };
  }
  return { flags, errors };
}

/** The query string the renderer reads to pick its mode. */
export function rendererQuery(flags: ClientFlags): Record<string, string> {
  const c = flags.crowd;
  if (c) {
    return {
      crowd: String(c.seconds),
      size: `${flags.benchSize.width}x${flags.benchSize.height}`,
      full: String(c.full),
      lod: String(c.lod),
      present: String(c.present),
      springs: String(c.springs),
      swap: String(c.swap),
      texturemb: String(c.textureMB),
      lodratio: String(c.lodRatio),
      merge: c.merge ? '1' : '0',
    };
  }
  if (flags.bench !== undefined) {
    return { bench: String(flags.bench), size: `${flags.benchSize.width}x${flags.benchSize.height}` };
  }
  if (flags.voiceLoad !== undefined) return { voiceload: String(flags.voiceLoad) };
  if (flags.lounge !== undefined && flags.join) {
    const { token } = flags.join;
    return { lounge: flags.lounge, token };
  }
  if (flags.voiceTest !== undefined && flags.join && flags.listenToken) {
    const { url, token } = flags.join;
    return { voice: String(flags.voiceTest), join: url, token, token2: flags.listenToken };
  }
  if (!flags.smoke) return {};
  if (!flags.join) return { smoke: '1' };
  const { url, token } = flags.join;
  return { smoke: '1', join: url, token };
}

/** The renderer's protocol check (protocol-check.ts), as it arrives in a smoke report. */
export interface ProtocolReport {
  cases?: unknown;
  failures?: unknown;
  error?: unknown;
}

/** A measuring run passes only if the scene drew on a known backend; a smoke run also needs every
 *  golden packet of the protocol to pass inside the renderer, and, when it was asked to join a
 *  world server, a join that worked. */
export function exitCodeFor(report: { backend?: unknown; protocol?: unknown; net?: unknown; ok?: unknown; error?: unknown }, mode: 'smoke' | 'bench' | 'voice' | 'crowd', options: { join?: boolean } = {}): 0 | 1 {
  if (mode === 'voice') return report.ok === true ? 0 : 1;
  // A crowd run that drew and finished exits 0; its pass lines are in the report.
  if (mode === 'crowd') return (report.backend === 'WebGPU' || report.backend === 'WebGL2') && report.error === undefined ? 0 : 1;
  if (report.backend !== 'WebGPU' && report.backend !== 'WebGL2') return 1;
  if (mode === 'bench') return 0;
  if (options.join && (report.net as { ok?: unknown } | undefined)?.ok !== true) return 1;
  const p = report.protocol as ProtocolReport | undefined;
  const passed =
    typeof p === 'object' && p !== null && typeof p.cases === 'number' && p.cases > 0 && Array.isArray(p.failures) && p.failures.length === 0 && p.error === undefined;
  return passed ? 0 : 1;
}
