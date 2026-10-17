# World server

The server for one world: joins and entry rules, movement checks, replication, chat, voice forwarding, moderation, world files, persistence and plugins. It runs headless on a host's PC or a Linux server, or inside the client for hosting and offline play.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Stack: Node.js 24 LTS running TypeScript directly (provisional until the Stage 0 bake-off; a .NET server in C# is the alternative)
- Status: Stage 0's prototype from the 200-bot spike (S0.07): joins with connect tokens and the version handshake, poses checked and corrected, interest management in 32 m cells, snapshots, proximity voice forwarding and chat, over WebRTC data channels or raw UDP with our own encryption. Entry rules, moderation, world files, persistence and plugins come in later stages.

```sh
npm run server -- --port 0 --ticks 100                    # raw UDP on any free port, 100 ticks
FLATCHAT_WORLD_KEY=<64 hex> npm run server -- --transport both   # joins open, both transports
```

`npm run server` starts Node with V8's young generation fixed at 16 MB per semi-space (`--min-semi-space-size=16 --max-semi-space-size=16`). Left to itself, V8 grows it in steps under the server's allocation rate, about 95 MB of resident memory in the first six minutes at 200 players; fixed, the server holds about 216 MB with the same tick times ([the S-NET report](../../docs/spikes/s-net.md#memory)). Start it the same way anywhere else.

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 7777 | Raw UDP port (0 picks a free one) |
| `--transport` | `udp` | `udp`, `rtc` or `both` |
| `--rtc-port`, `--signal-port` | 7778, 7779 | The one UDP port all WebRTC peers share, and the HTTP signaling port (`POST /rtc`) |
| `--bind`, `--rtc-bind` | all addresses | Where it listens; `--rtc-bind` restricts WebRTC's candidates to one address |
| `--tick-hz`, `--voice-hz` | 20, 50 | The state tick and the voice step |
| `--ticks` | none | Stop after that many ticks |
| `--capacity`, `--world-size` | 200, 256 | Players before `full`; the world square in metres |
| `--metrics-every` | 5 | Seconds between `metrics` lines (0: none) |
| `--trace FILE` | none | Every player's position four times a second, for the devlog view |
| `--world-id`, `--seed` | random, 1 | The world its tokens name; spawn positions |
| `--spawn X,Z,R` | anywhere | Players appear within R metres of (X, Z) |

The world's key comes from `FLATCHAT_WORLD_KEY`; without it the world takes no joins. It writes one JSON line per event: `ready`, `metrics`, `stopped`. Other programs reach its transports through `@flatchat/world-server/net`.
