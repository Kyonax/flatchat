# AGENTS.md

Instructions for AI coding agents working in this repository (Claude Code, Codex, OpenCode, Cursor, Grok and others). People start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What This Is

FlatChat (a codename) is a social world platform like VRChat or Second Life, played on a flat screen: anyone hosts a world from their own PC, friends join it, talk with proximity voice and appear as the avatars they made. Stage 0 of the MVP is building the foundations; nothing is playable yet. The stack is TypeScript end to end: an Electron 44 client with three.js r186 (WebGPU, falling back to WebGL2) and Vue 3.5, and a world server that Node.js 24 runs directly.

## Start Here

Read [.claude/skills/flatchat/SKILL.md](.claude/skills/flatchat/SKILL.md), the project's skill. It routes each kind of task to the rule files it needs; load only those.

## Commands

```sh
mise install && npm install                   # Node.js 24 from .tool-versions, then every workspace
npm run harness                               # every headless check; required before calling work done
npm run lint:traps                            # the trap linter alone
npm run client                                # the client, with live reload
npm run client:smoke                          # build the client, draw for 3 s, report, quit (needs a display)
npm run server -- --port 0 --ticks 100        # a short headless world server run
npm run bots -- smoke                         # 12 bots on each transport for 4 s (part of the harness)
npm run bots -- run --transport rtc --bots 200 --minutes 30 --server-cpus 0-1 --bot-cpus 2-7   # a measured load test
npm run golden -w @flatchat/protocol          # check the protocol's golden files; -- --write after a version bump
npm run core:db -- start                      # a private PostgreSQL for the core (no root); prints FLATCHAT_CORE_DB
npm run core:admin -- invite                  # the core's admin command line (needs its environment: apps/core/README.md)
npm run standin -- plan --target iris-xe      # print the weak-laptop stand-in's commands; changes nothing
```

## Rules That Always Apply

1. **Done means `npm run harness` passes.** When the client's drawing or window changed, also run `npm run client:smoke`.
2. **Licences by folder.** Every source file starts with its folder's SPDX header ([LICENSING.md](LICENSING.md)); a new licensed folder is registered in [tools/repo/layout.json](tools/repo/layout.json), LICENSING.md and both READMEs.
3. **The client stays locked down.** Never loosen its window settings (context isolation, sandbox, no Node.js in the page) or its content security policy, and never hand the page raw IPC.
4. **Strangers' input stays inert.** Never run it (`eval`, `new Function`), render it as HTML (`innerHTML`, `v-html`), load it with a raw asset loader in the client, or sandbox it with `node:vm`. The trap linter enforces these; fix findings rather than silencing them.
5. **Tests need no GPU, Electron, sudo or network.** Put decisions in pure modules and test them with Vitest; the hardware is for smoke and bench runs.
6. **The protocol changes only with its version.** A change to a message or a codec raises `PROTOCOL_VERSION`, rewrites the golden files and updates [docs/protocol.md](docs/protocol.md); `packages/` use only APIs that Node.js and the browser share.
7. **No system changes.** Do not run `sudo`, lock GPU clocks or edit system configuration yourself: prepare the command (the stand-in's `plan` prints them) and let the machine's owner run it.
8. **Assets are CC0 or CC BY, credited in [CREDITS.md](CREDITS.md).** Nothing from other games: no models, textures, sounds, names or logos.
9. **Version control belongs to the maintainer.** Do not commit, push, rewrite history or open pull requests unless the person you work for asks; when asked for a commit message, write it to a file. The maintainer publishes through shipwright, under the policy in [.shipwright/contract.toml](.shipwright/contract.toml): the harness passes before every commit, the push goes to `main`, and nothing is ever force-pushed. An agent the maintainer has asked to publish runs `shipwright now flatchat`, never `git commit` or `git push`.
10. **Never quote software rendering as performance.** CI runners and VMs without a GPU draw with SwiftShader or WARP; performance comes from real hardware or the stand-in, with the backend and adapter named.

## Repository Map

| Path | What |
|---|---|
| `apps/client` | The Electron client: `src/main` (window, flags, sign-in through the browser, the settings file, the bridge's handlers, the avatar protocol), `src/preload`, `src/shared` (settings and key bindings), `src/renderer` (`ui/` the app's screens, `world/` the world view, `i18n/`, `net/`, `voice/`, and the spikes' `lounge/` and `crowd/`); `scripts/` (the notices file, the voice sample) |
| `apps/world-server` | The world server: `src/main.ts` (the program), `src/server.ts` (joins, ticks, voice, chat), `src/world/` (cells, interest, snapshots, voice routing), `src/net/` (raw UDP and WebRTC transports) |
| `packages/protocol` | The wire protocol: codecs, messages, connect tokens, the version handshake, golden packets ([docs/protocol.md](docs/protocol.md)) |
| `apps/core` | The central service: `src/app.ts` (the routes), `src/main.ts` (the program), `src/admin.ts` (the admin command line), accounts, the age rule, sign-in and sessions, worlds and connect tokens, `src/migrations/` (PostgreSQL) |
| `packages/sim` | Movement rules shared by client and server: the controller, the move checks, the greybox plaza |
| `packages/content` | The world format's manifest, markers and validator ([docs/world-format.md](docs/world-format.md)) |
| `packages/*` | The plugin SDK (not started) |
| `tools/harness` | The harness, the trap linter, the skill check and the stand-in |
| `tools/repo` | The layout check and `layout.json` |
| `tools/bots` | Headless bots on the real protocol and the load-test runner (`npm run bots`) |
| `tools/converter` | World folders into built worlds (avatars in Stage 4) |
| `tools/host-tool` | The host's command: make, check, build, request, key, run, advise; its package and container image |
| `tools/blender` | The Blender bridge (not started) |
| `kits`, `docs` | Body kits and the base library; specs and Stage 0's spike reports |
| `.github/workflows/ci.yml` | CI: the harness, then the client packaged and smoke-tested on Linux and Windows |
| `.claude/skills/flatchat` | The agent skill |
| `.shipwright/contract.toml` | The maintainer's commit and push policy: the harness before each commit, direct pushes to `main` |
