// SPDX-License-Identifier: MPL-2.0
// The client's command-line flags for its two measuring modes, and the exit code of a finished
// run. Free of Electron, so the unit tests run in plain Node.
//
//   --smoke [--smoke-out=FILE]                       draw for a few seconds, report once, quit
//   --bench=SECONDS [--bench-out=FILE] [--bench-size=WxH]
//                                                    draw a fixed-size frame with no frame-rate cap
//                                                    and log every frame time (default 1280x720)

export interface Size {
  width: number;
  height: number;
}

export interface ClientFlags {
  smoke: boolean;
  smokeOut?: string;
  /** Seconds to measure, after the warm-up. */
  bench?: number;
  benchOut?: string;
  benchSize: Size;
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
  return { flags, errors };
}

/** The query string the renderer reads to pick its mode. */
export function rendererQuery(flags: ClientFlags): Record<string, string> {
  if (flags.bench !== undefined) {
    return { bench: String(flags.bench), size: `${flags.benchSize.width}x${flags.benchSize.height}` };
  }
  return flags.smoke ? { smoke: '1' } : {};
}

/** A measuring run passes only if the scene drew on a known backend. */
export function exitCodeFor(report: { backend?: unknown }): 0 | 1 {
  return report.backend === 'WebGPU' || report.backend === 'WebGL2' ? 0 : 1;
}
