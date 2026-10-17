# FlatChat

> **FlatChat is a codename.** The platform gets its own name and logo before it launches.

A social world platform like VRChat or Second Life, played on a flat screen. Anyone can host a world from their own PC; friends and followers join it, talk with proximity voice and show up as the avatars they made. Worlds grow through plugins.

It is free: no payments, no crypto, no ads or tracking, no kernel anti-cheat.

Created by [Kyonax](https://github.com/Kyonax). · [Leer en español](README.es.md)

## Status

**Stage 0 of the MVP: foundations and proof spikes. Nothing is playable yet.**

Stage 0 sets up this repository, the toolchain, CI and the test harness, and measures the four biggest unknowns before the first playable stage depends on them:

- **200 players in one world:** bots on the real protocol, against a world server on a home PC.
- **Voice:** echo, noise, delay and fading with distance, on ordinary laptops.
- **Crowds on a weak laptop:** Intel Iris Xe or AMD Radeon 680M graphics, 720p, 30 frames per second.
- **Reaching a home PC:** through home routers and carrier-grade NAT, with a relay when nothing else works.

Then the MVP, stage by stage: the core greybox (accounts, the creator's world, joining, moving, text chat and proximity voice), worlds and travel, plugins and moderation, avatars, effects, and a closed test with the community.

## The parts

| Folder | What it is |
|---|---|
| `apps/client` | The desktop app for Windows and Linux: sign-in, settings, the world browser, the 3D world, voice and an offline mode |
| `apps/world-server` | The server for one world, run headless by its host |
| `apps/core` | The central service: accounts, the server registry, uploads, the asset store, the gallery and moderation |
| `packages/protocol` | The network messages every program speaks |
| `packages/sim` | Movement rules, shared by the client's prediction and the server's checks |
| `packages/content` | World and avatar manifests, performance ranks and the world format's validator |
| `packages/plugin-sdk` | What a world plugin can call |
| `tools/converter` | Turns uploaded models into the platform's format |
| `tools/host-tool` | The world server, the converter and a capacity advisor in one download for hosts |
| `tools/bots` | Headless clients that speak the real protocol, for load tests |
| `tools/blender` | The Blender bridge script |
| `tools/repo` | Checks for this repository |
| `tools/harness` | Every headless check in one command, the trap linter and the weak-laptop stand-in |
| `kits` | The three body kits and the base library |
| `docs` | The protocol, the world format, the plugin API, spike reports and help pages |

**The toolchain is provisional** until a Stage 0 bake-off: TypeScript throughout, three.js in Electron for the client, Node.js for the servers. If the bake-off picks Godot with C#, the client and the world server change and everything else stays.

## Licences

Each folder has its own licence, chosen for its role ([LICENSING.md](LICENSING.md)):

| Folder | Licence |
|---|---|
| `apps/core` | AGPL-3.0-or-later |
| `apps/client`, `apps/world-server`, `tools/converter`, `tools/host-tool`, `tools/bots`, `tools/harness` | MPL-2.0 |
| `packages/*` | Apache-2.0 |
| `tools/blender` | GPL-3.0-or-later |
| `kits`, `docs` | CC BY 4.0 |
| Anything else | MPL-2.0 (the root [LICENSE](LICENSE)) |

Third-party material keeps its own licence and is listed in [CREDITS.md](CREDITS.md).

## Working on it

You need [mise](https://mise.jdx.dev) (or asdf), which installs the Node.js 24 LTS pinned in `.tool-versions`, or Node.js 24 installed your own way.

```sh
mise install           # Node.js 24 LTS, as pinned in .tool-versions
npm install            # every workspace
npm run client         # the client, with live reload (the first run downloads Electron, about 110 MB)
npm run server         # a world server on UDP port 7777; Ctrl+C stops it
npm test               # unit and process tests
npm run lint           # ESLint with the TypeScript and Vue rules
npm run typecheck      # TypeScript in every workspace
npm run check:layout   # the folder layout, licence files and SPDX headers
npm run client:smoke   # builds the client, draws for 3 s, prints its graphics backend and frame rate, quits
npm run harness        # every check above that needs no display, plus the trap linter, the agent-skill check, a headless world server and 12 bots on each transport
npm run lint:traps     # only the trap linter: the security and setup mistakes this project has met
npm run golden -w @flatchat/protocol   # checks the protocol's golden packets are up to date
npm run bots -- smoke  # a world server and 12 bots on each transport (raw UDP, WebRTC) for 4 s
```

The world server takes `--port` (0 picks a free one), `--transport udp|rtc|both`, `--tick-hz` and `--ticks` (stop after that many ticks), for example `npm run server -- --port 0 --ticks 100`; [apps/world-server](apps/world-server/README.md) lists the rest. To load-test it, `npm run bots -- run --transport rtc --bots 200 --minutes 30` starts a server and 200 bots in an isolated network and writes a report ([tools/bots](tools/bots/README.md)).

The core needs PostgreSQL's programs (not a running service): `npm run core:db -- start` makes a private database in your home folder and prints its connection string; [apps/core](apps/core/README.md) explains the rest (its settings, the admin command line, invitations, approving a world).

To package the client: `npm run dist:linux -w @flatchat/client` builds an unpacked Linux folder, and `npm run dist:win -w @flatchat/client` builds a Windows zip on Linux, without Wine. Both land in `apps/client/release/`.

To measure the client on a weak-laptop stand-in (an NVIDIA card locked to Iris Xe-class clocks, the client held to four cores), `npm run standin -- plan --target iris-xe` prints every command it would run; `run` runs them, asking sudo only for the clock lines, and always puts the card back. It reads a profile written for the machine, described in [tools/harness](tools/harness/README.md).

AI coding agents start from [AGENTS.md](AGENTS.md).

Every push and pull request runs the harness on GitHub Actions, then builds the client for Linux and Windows and smoke-tests both ([ci.yml](.github/workflows/ci.yml)).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
