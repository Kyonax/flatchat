---
title: Offline Testing — Proving Client, Server and Tool Logic Without a GPU, Electron, sudo or the Network
impact: HIGH
impactDescription: Logic left inside Electron or GPU code can only be checked by hand on one machine, so bugs surface on a tester's laptop or in CI's slow jobs; tests that touch real hardware, sudo or the network fail on runners and contributors' machines for reasons unrelated to the change.
tags: testing, tests, unit test, offline test, offline testing, vitest, headless, no gpu, no electron, fake, fakes, stand-in, stand-ins, recorder, runner, mock, pure function, pure module, process test, spawn, three in node, scene graph test, flags test, frame stats test, harness test, test fixtures, inline sources, temporary directory, mkdtemp, deterministic, ci, workspace tests, npm test
---

This rule governs how code is tested when the real thing (a GPU, Electron, an NVIDIA driver, sudo, another player) is not available, which is always true in CI and usually true for agents. The method: keep decisions in **pure modules** that take data and return data, test those in plain Node with Vitest, and push the parts that touch the machine behind a **small interface** that tests replace with a **recorder** (a fake that records what it was asked to do). The real hardware is then exercised by a short smoke run, not by unit tests.

## What Runs Where

| Kind | Runs in | Proves | Examples in the repository |
|---|---|---|---|
| Pure-module tests | `vitest run` in each workspace, plain Node | Decisions, parsing, maths, plans | `apps/client/test/flags.test.ts`, `frame-stats.test.ts`, `tools/harness/test/standin.test.ts` |
| Scene-graph tests | Plain Node, `three/webgpu` imported without a renderer | The scene's contents and motion | `apps/client/test/greybox.test.ts` |
| Recorder tests | Plain Node, a fake runner | The order of machine actions, and that clean-up always happens | `tools/harness/test/standin.test.ts` (`execute` with `recorder()`) |
| Inline-source tests | Plain Node, sources as strings | A checker's findings on planted mistakes | `tools/harness/test/trap-lint.test.ts` |
| Temporary-folder tests | `mkdtempSync` under the OS temp folder, removed in `afterEach` | A checker over a whole folder tree | `tools/harness/test/skill-check.test.ts` |
| Process tests | `spawn(process.execPath, ['src/main.ts', …])`, reading stdout | Flags, log lines, exit codes, signals | `apps/world-server/test/main.test.ts` |
| Simulated-wire tests | Plain Node: two transport sessions joined by an in-memory wire that drops, repeats or tampers with datagrams, serviced as time passes | Reliability under loss, replay and tamper refusal, reassembly | `apps/world-server/test/net.test.ts` (`wire()`) |
| Loopback tests | Real sockets on 127.0.0.1 (raw UDP, WebRTC with `iceBind: '127.0.0.1'`), any free port | Handshakes and both channels end to end; the join flow with real tokens | `apps/world-server/test/net.test.ts`, `server.test.ts`; the harness's `bots` check |
| Golden-file tests | Plain Node, fixed values against exact bytes in checked-in files | That an encoding never changes by accident, in every program that links it | `packages/protocol/test/golden.test.ts`, `apps/world-server/test/protocol.test.ts` |
| Fuzz tests | Plain Node, seeded random and damaged inputs | That a parser of strangers' bytes fails only in its own error type | `packages/protocol/test/messages.test.ts` |
| Smoke runs | The built client on a display (CI: Xvfb or the Windows desktop) | That it draws on some backend, and the protocol's golden packets pass in the bundled renderer | `--smoke` (client rule) |

Tests never need a GPU, Electron's binary, sudo, `nvidia-smi`, network access or a display. Anything that does is a smoke or bench run, not a test.

## How to Make Code Testable

| Situation | Move the logic to | Test it with |
|---|---|---|
| Electron main-process decisions (flags, exit codes) | A module with no `electron` import (`src/main/flags.ts`) | Plain Vitest |
| Renderer maths (frame statistics, percentiles) | A module with no DOM access (`frame-stats.ts`) | Plain Vitest |
| Scene construction | A builder that returns three objects (`greybox.ts`) | Assertions on `scene.children`, positions, rotations |
| A script that runs commands (sudo, `nvidia-smi`, `systemd-run`) | A planner that returns the commands, and an executor that takes a `Runner` | A recorder `Runner`: assert the calls and their order, and simulate failures and interrupts |
| A checker over files | A function over `{ rel, text }` sources, separate from file walking | Inline strings; one test per finding and one clean case |
| A long-running process | Its CLI, printing JSON lines | A process test with a timeout |
| A world tick, interest tiers, voice routing | `World` and `VoiceRouter`, which take the time and return encoded messages | Tick them by hand and decode what they return |
| A transport's reliability | A session class whose datagram sender is injected | The in-memory wire above |

The recorder pattern, as the stand-in's tests use it:
```ts
function recorder(codes: Record<string, number> = {}): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd) => { calls.push(cmd.join(' ')); return { code: codes[cmd[0]!] ?? 0, stdout: '' }; },
    background: (cmd, file) => { calls.push(`bg ${cmd[0]} > ${file}`); return { stop: async () => void calls.push(`stop ${file}`) }; },
    log: () => {},
  };
}
```
Then assert the full call sequence, and run it again with a failing step to prove the clean-up still runs.

## Conventions

| Item | Convention |
|---|---|
| Location | `<workspace>/test/*.test.ts`; the workspace's `tsconfig.json` includes `test` so tests are type-checked |
| Runner | `vitest run` as the workspace's `test` script; the root `npm test` runs every workspace |
| Imports | Node-run workspaces import with `.ts` extensions (`'../src/standin-plan.ts'`); the client (bundled) imports without (`'../src/main/flags'`) |
| Header | Test files carry their folder's SPDX header like any source file |
| Fixtures | Inline strings or files written to a temporary folder in the test; no fixture files with real traps or secrets in the tree |
| Timing | Allow slack in timing tests (the ticker test checks "about the requested rate"); never assert exact wall-clock durations |
| `.only` | Never commit `it.only` or `describe.only`; Vitest fails on them in CI |

## Correct vs. Incorrect

**Incorrect:** testing the stand-in by running it.
```ts
it('locks the clocks', async () => { await main(['run', '--target', 'iris-xe']); });
```
**Correct:** plan with pure functions and execute against a recorder.
```ts
const r = recorder({ 'systemd-run': 1 });
const outcome = await execute(planRun(options), r);
expect(outcome.resetCodes).toEqual([0, 0]);
```
**Why:** the real run needs sudo, an NVIDIA card and a built client; the recorder proves the same sequence, including the reset after a failure, on any machine.

**Incorrect:** importing `electron` in a module under test.
```ts
import { app } from 'electron';
export const exitCodeFor = (r: Report) => (r.backend === 'none' ? 1 : 0);
```
**Correct:** keep the decision in a module with no Electron import, and let `index.ts` call it.
**Why:** Electron's main APIs exist only inside Electron; Vitest in plain Node cannot load them.

**Incorrect:** a checker test that writes a planted trap into `apps/`.
**Correct:** pass `{ rel: 'apps/client/src/main/index.ts', text: '…' }` to `lintSources`.
**Why:** a planted file in the tree breaks the layout check and the real lint run, and can be committed by accident.
