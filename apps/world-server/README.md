# World server

The server for one world: joins and entry rules, movement checks, replication, chat, voice forwarding, moderation, world files, persistence and plugins. It runs headless on a host's PC or a Linux server, or inside the client for hosting and offline play.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Planned stack: Node.js 24 LTS and TypeScript (provisional until the Stage 0 bake-off; a .NET server in C# is the alternative)
- Status: the blank server of Stage 0. It binds its UDP port, runs an empty 20 Hz tick that keeps its schedule, and stops cleanly on Ctrl+C or SIGTERM, writing one JSON line per event. Flags: `--port` (0 picks a free one), `--tick-hz`, `--ticks` (stop after that many). The real work starts in Stage 0's 200-bot spike.
