---
title: CI on GitHub Actions — the Three Jobs, GPU-less Runners, Chromium's Sandbox on Ubuntu, Time Limits and Reading a Red Run
impact: HIGH
impactDescription: A smoke test on a GPU-less runner without SwiftShader or the AppArmor fix fails or passes for the wrong reason, a job without a time limit can hang for six hours, and a red run read as one result instead of job by job sends the fix to the wrong place (traps T14, T15).
tags: ci, github actions, workflow, ci.yml, jobs, checks, harness, client-linux, client-windows, ubuntu-24.04, windows-2025, runner, no gpu, gpu-less, xvfb, xvfb-run, apparmor, apparmor_restrict_unprivileged_userns, chromium sandbox, user namespaces, swiftshader, enable-unsafe-swiftshader, warp, timeout-minutes, time limit, actions/checkout, actions/setup-node, actions/upload-artifact, v7, node-version-file, npm cache, artifacts, red run, green run, planted failure, gh run list, gh run view, log-failed, concurrency, T14, T15
---

This rule governs `.github/workflows/ci.yml`: what runs on every push and pull request, why each odd-looking step is there, and how to read a run. GitHub's hosted runners are free for public repositories and have no GPU, which shapes everything about testing the client there.

## The Workflow

Triggers: `push` and `pull_request`. Permissions: `contents: read`. Concurrency: one run per ref (`ci-${{ github.ref }}`), cancelling an older one in progress.

| Job | Runner | Limit | Steps |
|---|---|---|---|
| `checks` (Harness) | `ubuntu-24.04` | 15 min | checkout, setup-node, `npm ci`, `npm run harness` |
| `client-linux` | `ubuntu-24.04` | 20 min | checkout, setup-node, `npm ci`, `npm run dist:linux -w @flatchat/client`, the AppArmor sysctl, the smoke test under Xvfb with SwiftShader, joining a world server over WebRTC (`npm run bots -- client-check -- …`), the no-renderer smoke test that must fail, upload `linux-unpacked` (7 days) |
| `client-windows` | `windows-2025` | 20 min | checkout, setup-node, `npm ci`, `node tools/bots/src/run.ts smoke` (node-datachannel's Windows binary, both transports; `node` directly, so PowerShell and npm cannot reshape the `--` arguments), `npm run dist:win -w @flatchat/client`, the smoke test joining a world server, from PowerShell, upload the zip (7 days) |

Actions used (all at major v7 on 2026-10-16): `actions/checkout@v7`, `actions/setup-node@v7` with `node-version-file: .tool-versions` and `cache: npm`, `actions/upload-artifact@v7`.

## Why the Odd Steps Exist

| Step | Without it | Trap |
|---|---|---|
| `timeout-minutes` on every job | A hung smoke test runs until GitHub's six-hour cap | T14 |
| `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before running Electron on Ubuntu 24.04 | Ubuntu blocks the unprivileged user namespaces Chromium's sandbox needs; Electron aborts | T15 |
| `xvfb-run -a … --smoke --enable-unsafe-swiftshader` | No display, or no WebGL at all: Chromium no longer falls back to SwiftShader for WebGL by itself, so the scene cannot start | T15 |
| The smoke run with `--disable-gpu` that must exit non-zero | Nothing proves the smoke test can fail; a client that draws nothing could pass | — |
| The smoke tests through `npm run bots -- client-check -- CLIENT …` | It starts a WebRTC world server on loopback, seals a connect token, runs the client with `--join` and `--join-token`, waits for it (Node waits for a GUI program, where PowerShell alone would not) and exits non-zero unless the client passed and the server saw its join; on Windows `exit $LASTEXITCODE` after printing the file | — |
| `--smoke-out=FILE`, then printing the file | A GUI program's stdout is not captured on Windows | — |

A smoke run with `--disable-gpu` is the deliberate exception to T15; the linter skips it.

## What the Runners Render With

| Runner | Backend in the smoke JSON | Adapter |
|---|---|---|
| `ubuntu-24.04` | WebGL2 | ANGLE on Vulkan SwiftShader (about 8 fps at 1280×720) |
| `windows-2025` | WebGL2 | ANGLE on Direct3D 11, Microsoft Basic Render Driver (WARP; about 38 fps) |

These prove the client starts and draws; they are never performance numbers. Each smoke JSON also carries the `protocol` check (the golden packets run in the packaged renderer; a single failing packet fails the job) and the `net` check (Chromium's own WebRTC joined the world server: `joinMs`, `entity`, `snapshots`; `ok: false` fails the job).

## Reading a Run (Read-Only)

| Question | Command |
|---|---|
| Recent runs and their results | `gh run list --repo <owner>/<repo> --limit 10` |
| Each job's result | `gh run view <run-id> --repo <owner>/<repo> --json jobs --jq '.jobs[] \| "\(.name): \(.conclusion)"'` |
| The failing step's log | `gh run view <run-id> --repo <owner>/<repo> --log-failed` |
| The smoke results | `gh run view <run-id> --repo <owner>/<repo> --log \| grep '"event":"smoke'` |

Read a red run **job by job**: a planted source file without its SPDX header fails only the `checks` job, while both client jobs still pass. The fix goes where the failing step is.

## Proving CI Works (Green and Red)

A new or changed pipeline is proven twice: a green run on a normal change, and a red run on a planted failure pushed to a throwaway branch, for example a file `packages/protocol/planted.ts` containing only `export const planted = 1;`, which must fail at the layout check with `no SPDX header: packages/protocol/planted.ts (wants Apache-2.0)`. Delete the branch after reading the run.

## Correct vs. Incorrect

**Incorrect:** a Linux smoke step on its own.
```yaml
- run: xvfb-run -a apps/client/release/linux-unpacked/flatchat --smoke
```
**Correct:**
```yaml
- run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
- run: xvfb-run -a apps/client/release/linux-unpacked/flatchat --smoke --enable-unsafe-swiftshader --smoke-out=smoke-linux.json
```
**Why:** without the sysctl Electron's sandbox cannot start on Ubuntu 24.04, and without SwiftShader there is no WebGL on a GPU-less runner (T15).

**Incorrect:** a new job without a time limit.
```yaml
bots:
  runs-on: ubuntu-24.04
  steps: [...]
```
**Correct:** `timeout-minutes: 15` (or what the job needs, with room) under `runs-on`.
**Why:** one hung process otherwise holds the run for six hours (T14).
