---
title: The World Server on Node.js 24 — TypeScript Run Directly, the Fixed-Rate Ticker, Flags, JSON Log Lines and Clean Shutdown
impact: HIGH
impactDescription: Non-erasable TypeScript, an import without its .ts extension or a ticker that schedules from the last tick makes the server fail to start, drift under load, or stop without its final log line, and the process tests and the harness's server check fail.
tags: world server, world-server, server, node, node 24, typescript, type stripping, erasableSyntaxOnly, allowImportingTsExtensions, .ts imports, enum, namespace, parameter properties, ticker, tick, tick rate, hz, fixed rate, drift, setTimeout, udp, dgram, port, flags, parseArgs, json lines, log, ready, stopped, SIGINT, SIGTERM, shutdown, tick-limit, headless, process test, spawn
---

This rule governs `apps/world-server`: the server for one world, run headless on a host's PC or a Linux server. Node.js 24 runs its TypeScript files directly, with no build step, so the code must stay within the TypeScript that Node can strip. The server speaks only through one JSON object per line on stdout, which tests, the harness and later tools read.

## TypeScript That Node Runs Directly

Node 24 removes type annotations at load time; it does not compile. The repository's `erasableSyntaxOnly` makes the type check reject anything Node could not run.

| Allowed | Not allowed (fails the type check, or fails at run time) |
|---|---|
| Types, interfaces, `type` imports, generics, `as`, `satisfies`, `!` | `enum` (use a `const` object with `as const`) |
| `import { x } from './ticker.ts'` (relative imports name the `.ts` file) | `import { x } from './ticker'` (Node cannot resolve it) |
| `import type { T } from './types.ts'` | `namespace` and `module` blocks with code |
| Classes with plain fields | Constructor parameter properties (`constructor(private x: number)`) |
| | `import x = require('…')`, legacy decorators with metadata |

`apps/world-server/tsconfig.json` extends the base config and adds `allowImportingTsExtensions` and `types: ["node"]`. Run it with `node src/main.ts`; never add a build step to make non-erasable syntax work.

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
| `--port` | 7777 | 0–65535 | UDP port; 0 takes any free port |
| `--tick-hz` | 20 | 1–1000 | Tick rate |
| `--ticks` | none | 1 and up | Stop after N ticks |

A bad value prints `{"event":"error","message":"--port must be an integer from 0 to 65535, got …"}` and exits 2. Unknown flags make `parseArgs` throw (strict mode).

| Line (`event`) | Fields | When |
|---|---|---|
| `ready` | `version`, `port` (the bound one), `tickHz`, `node`, `pid`, `time` | The socket is bound and the ticker started |
| `stopped` | `reason` (`SIGINT`, `SIGTERM`, `tick-limit`, `stopped`), `ticks`, `uptimeMs`, `slowestTickMs`, `time` | After the ticker stopped and the socket closed; then exit 0 |
| `error` | `message` | A bad flag (exit 2) or a socket error (exit 1) |

Shutdown runs once: a `stopping` guard ignores a second signal, the ticker stops, the socket closes, the `stopped` line is written, and the process exits 0.

| Command | Use |
|---|---|
| `npm run server` | A server on UDP 7777 until Ctrl+C |
| `npm run server -- --port 0 --ticks 100` | A short run on any free port |
| `npm run harness -- --only server` | The harness's check: port 0, 50 Hz, 50 ticks; expects `ready` with a port and `stopped` with `tick-limit` and 50 ticks, exit 0 |

## Tests

`test/ticker.test.ts` tests the ticker's rate, `stop()` and the range check. `test/main.test.ts` spawns the real process (`node src/main.ts …`) and reads its lines: it stops at the tick limit, stops on SIGTERM, and exits 2 on a bad port. New server behaviour gets a process test of the same kind when it is about what the process prints or how it exits.

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
