# Contributing

Thanks for your interest in FlatChat. It is early: Stage 0 of the MVP is building the foundations, and nothing is playable yet.

## How the work is done

- The work follows a staged plan. Each change belongs to one step, with a check that proves it works.
- Most code is written by AI coding agents and reviewed by the creator, Kyonax, before it is merged. Changes from people are welcome on the same terms: reviewed, tested and small enough to read in one sitting.
- Open an issue before a large change, so the design can be agreed first.
- AI coding agents follow [AGENTS.md](AGENTS.md) and the project's skill in `.claude/skills/flatchat`.

## Before you open a pull request

1. `npm run harness` passes: the layout and licence check, the agent-skill check, the trap linter, ESLint, TypeScript, the tests and a headless world server.
2. Every new source file starts with its folder's SPDX identifier (see [LICENSING.md](LICENSING.md)), for example `// SPDX-License-Identifier: MPL-2.0`.
3. New logic comes with tests that run without a GPU, Electron or network (see [tools/harness](tools/harness/README.md) for examples).
4. Any third-party code, model, texture, sound or font you add has an entry in [CREDITS.md](CREDITS.md): who made it, where it came from, its licence and what you changed. Assets must be CC0 or CC BY. Credit the person who made a work, not the site where you found it.
5. Nothing from other games: no models, textures, sounds, names or logos.
6. A change to the network protocol raises its version and updates its golden packets and [docs/protocol.md](docs/protocol.md) (see "Changing the protocol" there).

## Licensing of contributions

A contribution is licensed under the licence of the folder it lands in (inbound = outbound). There is no contributor licence agreement.

## Languages

Issues and discussions are welcome in English or Spanish.
