---
title: The World Server on Node.js 24 — TypeScript Run Directly, the Fixed-Rate Ticker, Flags, JSON Log Lines and Clean Shutdown
impact: HIGH
impactDescription: Non-erasable TypeScript, an import without its .ts extension or a ticker that schedules from the last tick makes the server fail to start, drift under load, or stop without its final log line, and the process tests and the harness's server check fail.
tags: world server, world-server, server, main.ts, server.ts, metrics, cpuPct, mainThreadPct, FLATCHAT_WORLD_KEY, exports, node, node 24, typescript, type stripping, erasableSyntaxOnly, allowImportingTsExtensions, .ts imports, enum, namespace, parameter properties, ticker, tick, tick rate, hz, fixed rate, drift, setTimeout, udp, dgram, port, flags, parseArgs, json lines, log, ready, stopped, SIGINT, SIGTERM, shutdown, tick-limit, headless, process test, spawn
---

This rule governs `apps/world-server` as a Node.js program: the server for one world, run headless on a host's PC or a Linux server. Node.js 24 runs its TypeScript files directly, with no build step, so the code must stay within the TypeScript that Node can strip. The server speaks only through one JSON object per line on stdout, which tests, the harness, the bots and later tools read. What it does on the network (the transports, joins, interest management, voice) is in `world-networking`.

| File | Job |
|---|---|
| `src/main.ts` | The program: flags, the transports, the ready, metrics and stopped lines |
| `src/server.ts` | `WorldServer`: joins, the state tick, voice forwarding, chat, metrics |
| `src/world/grid.ts`, `interest.ts`, `world.ts`, `voice.ts` | The world model, pure: cells, tiers, poses and snapshots, voice bundles |
| `src/net/types.ts`, `udp.ts`, `rtc.ts` | The transports behind one `Link` interface |
| `src/metrics.ts` | Exact quantiles (`Samples`, `summarize`), byte tallies, memory, a seeded random |
| `src/ticker.ts` | The fixed-rate ticker |

`package.json` exports `./net`, `./metrics`, `./server` and nothing that starts a server; the bots import `@flatchat/world-server/net`. Its one native dependency is `node-datachannel` (`toolchain-versions`).

## TypeScript That Node Runs Directly

Node 24 removes type annotations at load time; it does not compile. The repository's `erasableSyntaxOnly` makes the type check reject anything Node could not run.

| Allowed | Not allowed (fails the type check, or fails at run time) |
|---|---|
| Types, interfaces, `type` imports, generics, `as`, `satisfies`, `!` | `enum` (use a `const` object with `as const`) |
| `import { x } from './ticker.ts'` (relative imports name the `.ts` file) | `import { x } from './ticker'` (Node cannot resolve it) |
| `import type { T } from './types.ts'` | `namespace` and `module` blocks with code |
| Classes with plain fields | Constructor parameter properties (`constructor(private x: number)`) |
| | `import x = require('…')`, legacy decorators with metadata |

`apps/world-server/tsconfig.json` extends the base config and adds `allowImportingTsExtensions` and `types: ["node"]`. Run it with `node --min-semi-space-size=16 --max-semi-space-size=16 src/main.ts` (what `npm run server` and the bots' `SERVER_V8_FLAGS` do: V8 otherwise grows the young generation in steps under the server's allocation rate, about 95 MB of resident memory at 200 players, which a soak reads as growth); never add a build step to make non-erasable syntax work.

Workspace packages are imported by name, with no extension: `import { decodeMessage } from '@flatchat/protocol'`. The server lists each in `dependencies` (`"@flatchat/protocol": "*"`); npm links it into `node_modules`, and Node strips its TypeScript because the link resolves to `packages/…`, outside `node_modules`. The protocol's rules are in `protocol-and-codecs`.

## The Ticker (`src/ticker.ts`)

`startTicker({ hz, onTick, maxTicks?, onTiming? })` returns `{ ticks, stop(), done }`.

| Property | Behaviour |
|---|---|
| `hz` | Ticks per second, more than 0 and at most 1000, or it throws `RangeError` |
| Scheduling | Tick *n* is due at `start + n × period`, measured from the start, so a late tick never pushes the later ones back (no drift) |
| `onTick(tick)` | The world's work for one tick |
| `onTiming(ms)` | How long each tick's work took; the server keeps the slowest for its `stopped` line |
| `maxTicks` | Stop after that many ticks (tests and checks) |
| `stop()` | Stops the loop: no tick runs after it; resolves to the number of ticks that ran |
| `done` | Resolves when the ticker has stopped, for any reason |

## Running the Server (`src/main.ts`)

| Flag | Default | Range | Meaning |
|---|---|---|---|
| `--port` | 7777 | 0–65535 | The raw UDP port; 0 takes any free port |
| `--transport` | `udp` | `udp`, `rtc`, `both` | Which transports listen |
| `--rtc-port` | 7778 | 1–65535 | The one UDP port every WebRTC peer's ICE traffic shares |
| `--signal-port` | 7779 | 0–65535 | The HTTP port for WebRTC signaling (`POST /rtc`) |
| `--bind` | all | an address | Where the UDP and HTTP sockets listen |
| `--rtc-bind` | none | an address | Restricts ICE to one local address (`127.0.0.1` in an isolated network) |
| `--tick-hz` | 20 | 1–1000 | State tick rate |
| `--voice-hz` | 50 | 1–1000 | Voice forwarding rate (one bundle per listener per step) |
| `--ticks` | none | 1 and up | Stop after N ticks |
| `--capacity` | 200 | 1–65535 | Players before `full` |
| `--world-size` | 256 | 32–65536 | The world square's side, metres |
| `--metrics-every` | 5 | 0–3600 | Seconds between `metrics` lines; 0 for none |
| `--trace` | none | a file | Every player's position and speaking flag every 250 ms, as JSON lines (the devlog view) |
| `--world-id` | random | a lowercase UUID | The world its connect tokens must name |
| `--spawn` | anywhere | `X,Z,R` | Players appear within R metres of (X, Z), as at a world's spawn point (the voice test uses it) |
| `--seed` | 1 | 0–2³²−1 | Spawn positions |

The world key comes from the environment, `FLATCHAT_WORLD_KEY` (64 hexadecimal characters), never from a flag that a process listing would show; without it the world takes no joins (`ready` says `joins: false`).

A bad value prints `{"event":"error","message":"--port must be an integer from 0 to 65535, got …"}` and exits 2. Unknown flags make `parseArgs` throw (strict mode).

| Line (`event`) | Fields | When |
|---|---|---|
| `ready` | `version`, `protocol` (the protocol version), `schema` (its fingerprint, 8 hexadecimal digits), `port` (the bound UDP port, 0 without raw UDP), `udpPort`, `rtcPort`, `signalPort` (those that listen), `transports`, `world`, `joins`, `tickHz`, `voiceHz`, `capacity`, `worldSize`, `node`, `pid`, `time` | The transports listen and the tickers started |
| `metrics` | `players`, `cpuPct`, `mainThreadPct`, `tickMs`, `voiceMs`, `encodings`, `busyCells`, `joinSnapshotBytes`, `rosterBytes`, `joinMs` (each `{ n, mean, p50, p95, p99, max }` for the window), `sent`, `received` (bytes and messages by type), `events` (joins, refusals by reason, leaves, pose outcomes, throttles, malformed messages), `links`, `memory` | Every `--metrics-every` seconds |
| `stopped` | `reason` (`SIGINT`, `SIGTERM`, `tick-limit`, `stopped`), `ticks`, `uptimeMs`, `slowestTickMs`, `summary` (the whole run's statistics, `memoryStart`, `memoryWarm` at 2 minutes, `memoryEnd`), `time` | After the tickers stopped, a `leave` went to every player and the transports closed; then exit 0 |
| `error` | `message` | A bad flag (exit 2) or a socket error (exit 1) |

Shutdown runs once: a `stopping` guard ignores a second signal, the tickers stop, every player gets `leave` (reason `closing`), the transports close, the `stopped` line is written, and the process exits 0.

| Command | Use |
|---|---|
| `npm run server` | A server on UDP 7777 until Ctrl+C |
| `npm run server -- --port 0 --ticks 100` | A short run on any free port |
| `npm run harness -- --only server` | The harness's check: port 0, 50 Hz, 50 ticks; expects `ready` with a port and `stopped` with `tick-limit` and 50 ticks, exit 0 |

## Tests

`test/ticker.test.ts` tests the ticker's rate, `stop()` and the range check. `test/main.test.ts` spawns the real process (`node src/main.ts …`) and reads its lines: it starts with the protocol version and schema in its `ready` line, stops at the tick limit, stops on SIGTERM, and exits 2 on a bad port. `test/protocol.test.ts` runs every golden packet through the protocol as the server links it. `test/world.test.ts` drives the world model tick by tick (tiers, poses, encodings per busy cell, packing, voice routing); `test/net.test.ts` tests the raw UDP session over an in-memory wire that drops, repeats and tampers with datagrams, then both transports on loopback; `test/server.test.ts` joins real clients with real tokens over loopback UDP and checks every refusal, snapshots, corrections, voice, chat and pings. New server behaviour gets a process test of the same kind when it is about what the process prints or how it exits.

## Correct vs. Incorrect

**Incorrect:** an enum for message kinds.
```ts
enum Kind { Hello, Move }
```
**Correct:**
```ts
export const Kind = { Hello: 0, Move: 1 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
```
**Why:** enums generate code, so Node cannot strip them; `erasableSyntaxOnly` fails the type check.

**Incorrect:** scheduling each tick from the end of the last one.
```ts
const loop = () => { onTick(); setTimeout(loop, 1000 / hz); };
```
**Correct:** schedule tick *n* at `start + n * period` and set the timeout to the time left until then, as `startTicker` does.
**Why:** each tick's work time adds to the period, so a 20 Hz server drifts to 18 Hz under load.

**Incorrect:** printing free text.
```ts
console.log(`server ready on ${port}`);
```
**Correct:** `log('ready', { port: socket.address().port, … })`, one JSON object per line.
**Why:** the tests, the harness and later tools parse every line as JSON.
