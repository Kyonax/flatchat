---
name: flatchat
description: "The engine skill for this repository, FlatChat (a social world platform, VRChat on a flat screen): TypeScript end to end on Node.js 24 with npm workspaces; the Electron 44 client (main, preload, renderer, Vue 3.5, three.js r186 WebGPU with its WebGL2 fallback, smoke and bench modes); the world server run as TypeScript by Node; licences by folder and SPDX headers; untrusted-input security; offline tests without GPU or Electron; the harness (npm run harness) and its trap linter (T01-T16); GitHub Actions CI on GPU-less runners; Linux and Windows packaging; the weak-laptop stand-in (Iris Xe, Radeon 680M) with nvidia-smi clock locks. Use for any change, test, CI failure, build or performance measurement in this repository, and before calling work done."
user-invocable: true
metadata:
  version: "1.0.0"
  verified: "2026-10-16"
---

# FlatChat

How to build, test and verify FlatChat in this repository: where each kind of code lives and under which licence, the client's security model, how it draws and how frames are measured, the world server, how to test without a GPU, the harness that every change must pass, CI, packaging, and the stand-in that turns a desktop into a weak laptop. Every fact here was checked on the code and on real runs (Linux desktop with an NVIDIA card, a Windows VM without a GPU, GitHub's runners) on 2026-10-16.

## Core Principle: Prove It Headless, Keep Strangers' Input Inert

Everything that can be decided without a GPU is decided in pure modules and proven by `npm run harness`; the hardware is exercised only by short smoke and bench runs. And because every world, avatar, name and message comes from other people, nothing they made is ever run, rendered as HTML or loaded raw: the trap linter enforces the patterns, the rules explain them.

## Fast Path

| Step | Command |
|---|---|
| Install (Node.js 24 from `.tool-versions`) | `mise install && npm install` |
| Verify any change (required before "done") | `npm run harness` |
| Only the trap linter | `npm run lint:traps` |
| The client, live | `npm run client` |
| The client draws (needs a display) | `npm run client:smoke` |
| A world server | `npm run server -- --port 0 --ticks 100` |
| Measure on the weak-laptop stand-in (read first) | `npm run standin -- plan --target iris-xe` |

## When to Apply

Reference these guidelines when:

*   Adding or changing any code, folder, package or workspace in this repository.
*   Touching the client's main process, preload, IPC, window settings, content security policy or menu.
*   Drawing anything, choosing a three.js entry point, or quoting a frame rate.
*   Changing the world server, its tick loop, flags or log lines.
*   Handling chat, names, world or avatar files, uploads, plugins or network messages.
*   Writing tests, or making code testable without a GPU, Electron or sudo.
*   A harness check, a trap-linter finding or a CI job fails.
*   Upgrading Node, npm, TypeScript, ESLint, Electron, Vite, Vue or three.
*   Packaging the client, or checking it on Windows.
*   Measuring performance against the integrated-graphics laptop floor.

## When to Read Which Rules

| If working on... | Read these rules |
|---|---|
| Finishing any change: what "verified" means, the harness, a trap finding | `rules/harness-and-trap-linter.md` |
| A new file, folder, package or workspace; a licence or SPDX header; third-party assets | `rules/repository-and-licences.md` |
| The client's main process, preload, IPC, window settings, CSP, menu, smoke or bench flags | `rules/client-electron.md` + `rules/security-untrusted-input.md` |
| Chat, display names, world or avatar files, uploads, plugins, network messages | `rules/security-untrusted-input.md` |
| Rendering, three.js, WebGPU or WebGL2, adapters, frame rates and frame times | `rules/rendering-three-webgpu.md` |
| The world server: ticks, flags, JSON log lines, shutdown, Node-run TypeScript | `rules/world-server-node.md` |
| Writing or fixing tests; testing without a GPU, Electron, sudo or the network | `rules/offline-testing.md` |
| Adding a trap to the linter or a check to the harness | `rules/harness-and-trap-linter.md` + `rules/offline-testing.md` |
| A failing or changed CI workflow; reading a red run | `rules/ci-github-actions.md` |
| Installing, upgrading or pinning tools; install-time warnings | `rules/toolchain-versions.md` |
| Packaging for Linux or Windows; checking a Windows build | `rules/packaging-windows-linux.md` |
| Measuring against the laptop floor; nvidia-smi clock locks; stand-in profiles | `rules/weak-laptop-stand-in.md` + `rules/rendering-three-webgpu.md` |

A trap-linter finding names its rule; read that rule.

## Quick Reference

| Rule | Description |
|---|---|
| `repository-and-licences` | Folder map with licences and workspaces, what the layout check enforces, SPDX header per file type, adding folders, third-party assets. |
| `toolchain-versions` | Node 24 via `.tool-versions`, npm workspaces commands, every pinned version and why (TypeScript ~6.0), install quirks, upgrades. |
| `client-electron` | Main/preload/renderer split, locked window settings, the bridge and IPC, CSP, menu, smoke and bench flags and exit codes (T01–T04, T07–T10, T16). |
| `rendering-three-webgpu` | WebGPURenderer start-up, backend and adapter, software renderers per machine, fixed-size bench, frame-time statistics. |
| `world-server-node` | TypeScript Node can strip, the drift-free ticker, flags, JSON log lines, clean shutdown, process tests. |
| `security-untrusted-input` | Never run, render as HTML or load raw what strangers made: eval, innerHTML/v-html, raw loaders, node:vm, exec (T05, T06, T11–T13). |
| `offline-testing` | Pure modules, scene-graph and recorder tests, inline sources, process tests, test conventions. |
| `harness-and-trap-linter` | The harness's checks and options, the skill check, the linter's inputs and 16 traps, allow comments, adding traps and checks. |
| `ci-github-actions` | The three jobs, AppArmor and SwiftShader steps, time limits, runner renderers, reading red runs, green/red proof (T14, T15). |
| `packaging-windows-linux` | electron-builder settings, Linux folder and Windows zip from Linux, checking a Windows build without a GPU or desktop. |
| `weak-laptop-stand-in` | Imitating Iris Xe or 680M: clock locks, CPU and memory caps, profile derivation and format, commands, verdicts, tuning. |
