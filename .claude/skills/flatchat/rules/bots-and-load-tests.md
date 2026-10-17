---
title: The Bots and Load Tests — tools/bots, the Smoke Test, Measured Runs in an Isolated Network, the Report's Pass Lines and the Devlog View
impact: HIGH
impactDescription: A load test that times the server while bots share its cores, counts only application bytes, mixes other traffic in, or reads a one-minute run as a memory verdict gives numbers nobody can trust; a bot process that throws in a timer silently drops its bots from the report.
tags: bots, tools/bots, @flatchat/bots, load test, load testing, soak, 200 bots, swarm, swarm.ts, bot.ts, brain.ts, talker.ts, run.ts, report.ts, render.ts, netns.ts, smoke, npm run bots, bots smoke, measured run, scenario, hubs, crowd, netem, delay, loss, unshare, user namespace, network namespace, nftables, nft, counters, wire bytes, taskset, cores, pinning, report.md, report.json, pass lines, kbps, Mbps, tick p99, memory growth, trace, devlog, ffmpeg, mp4, png, S0.07, S-NET
---

This rule governs `tools/bots` (workspace `@flatchat/bots`, MPL-2.0): headless players that speak the real protocol over a real transport, and the command line that runs them against a world server and measures it. What the world server does with them is in `world-networking`.

## The Parts

| File | Job |
|---|---|
| `src/brain.ts` | Movement, deterministic per seed: six hubs (scenario `hubs`) or one 15 m stage (`crowd`), walking 1.4 m/s, sometimes running 4 m/s, idling 3–15 s (sometimes seated), a fifth of the bots wandering between hubs |
| `src/talker.ts` | Voice bursts (1.5–6 s on, 4–20 s off, about a quarter of the time) of synthetic Opus frames, 50–80 bytes every 20 ms with mouth shapes; a chat line every 30–120 s |
| `src/bot.ts` | One player: seals its own connect token (the bots stand in for the core and hold the world key), joins, waits for its spawn, then pose 20 Hz, voice 50 Hz while talking, chat, ping 1 Hz; decodes everything and counts bytes by message type |
| `src/swarm.ts` | A process of bots on one 100 Hz scheduler; config in `FLATCHAT_SWARM` (JSON) and the key in `FLATCHAT_WORLD_KEY`; JSON lines `joined`, `window` (every 5 s), `summary` |
| `src/run.ts` | The command line: `run`, `smoke`, `report`, `render` |
| `src/netns.ts` | The isolated network: a rootless user and network namespace, nftables counters, netem |
| `src/report.ts` | A run's records → results, pass lines, `report.md` |
| `src/render.ts` | The devlog view: an MP4 and a PNG from the server's trace |

## Commands

| Need | Command |
|---|---|
| The harness's check (both transports at once, 12 bots each, 4 s, plain loopback) | `npm run bots -- smoke` |
| A measured run | `npm run bots -- run --transport udp --bots 200 --minutes 30 --server-cpus 0-1 --bot-cpus 2-7 --trace` |
| The worst case for interest management | `… run --scenario crowd …` |
| A real network's delay and loss | `… run --netem "delay 20ms 2ms loss 1%" …` (each direction crosses loopback once, so this is a 40 ms round trip) |
| Rebuild a report | `npm run bots -- report tools/bots/out/<run>` |
| The devlog clip | `npm run bots -- render tools/bots/out/<run> [--from 300] [--seconds 45]` |
| The real client joins a world server over WebRTC (CI's smoke steps) | `npm run bots -- client-check -- <client> --smoke [--smoke-out=FILE]` (a WebRTC world server on loopback, a sealed token, `--join` and `--join-token` appended; exit 0 only when the client passed and the server saw one join) |
| The world browser with every real program (S2.09, CI) | `node tools/bots/src/browse.ts [--recommended 4] [--capacity 6]`: a private PostgreSQL, the core, a world reporting over its host channel, bots joining one at a time; listed below the recommended count, off the list at it, the core and the world refusing once full |
| Travel between worlds (S2.11, CI) | `node tools/bots/src/hop.ts [--bots 20] [--loops 5]`: two plazas whose portals lead to each other (`tools/converter/scripts/make-travel.ts`), bots that walk into the portal (`goal`), take `portal` (`onPortal`), leave with `stop('travel')` and join the other world with the portal's `spawn` group; every arrival must land on the arrival spawn, and each world counts its `portal` and `leave:travel` events |
| A player behind a blocking NAT (S2.12, CI's Linux client job) | `node tools/bots/src/e2e.ts CLIENT --relay` (coturn's `turnserver` on the PATH; CI installs it with apt): the real client relay-only, refused while no relay runs, then through coturn |
| The voice chain end to end (spike S0.08) | `npm run bots -- voice-check --seconds 20 -- <client>` (a world server with `--spawn 8,32,1` in a 64 m world and two tokens; the client's `--voice-test` joins twice and reports) |

A run's folder (default `tools/bots/out/<time>-<transport>-<bots>`, ignored by git) holds `run.json`, `server.jsonl`, `swarm-N.jsonl`, `wire.jsonl`, `trace.jsonl` (with `--trace`), `report.json`, `report.md`, and after a render `devlog.mp4` and `devlog.png`.

## How a Measured Run Stays Honest

| Point | Rule |
|---|---|
| Isolation | On Linux `run` starts itself again under `unshare -Urn`: a new user and network namespace with only its own loopback, no root and no change to the machine. Nothing else's traffic mixes in |
| A real client inside it | `voice-check --netem` runs the client there too, which needs two things: `asOuterUser()` starts it in a nested user namespace as the user who began the run (inside the namespace this process is root, and Electron refuses root; the client's own sandbox stays on), and `addPrivateAddress()` gives the namespace 10.77.0.1 on a dummy interface for the world server, because Chromium leaves loopback out of WebRTC's candidates (ICE gathering never completes otherwise). Traffic to that address is local, so it still crosses loopback, where netem and the counters act. `--allow-loopback-in-peer-connection` did not help |
| netem and voice | netem acts on each loopback crossing; a voice frame crosses twice (speaker to server to listener), so `delay 10ms 10ms loss 2.5%` is S0.08's line end to end (about 5 % loss, 40 ms of jitter) |
| Wire bytes | nftables counters on the world server's port in both directions (`from-PORT`, `to-PORT`), IP and UDP headers included; the transports count only message bytes. The loopback MTU is set to 1,500 so packets are the size a real network carries |
| Cores | `taskset`: the server on cores 0–1, the swarms on 2–7, so the bots never steal the server's tick. While a run is going, run other work with `taskset -c 2-7 …` too |
| Steady state | Rates come from the windows when every bot that joined is in; per-client rates from each bot's own totals over its time in the world |
| Memory | Judged on RSS from the first metrics line after 5 minutes to the end, for runs of 10 minutes or more, with the least-squares trend after 5 minutes (MB per 10 minutes) beside it and the growth from 2 minutes shown too. The server starts with V8's young generation fixed at 16 MB (`--semi-space`, default 16; 0 gives V8's own sizing): left to itself V8 grew it in steps, the WebRTC server's last one at 5.5 minutes (25.8 % read as growth); fixed, 2.7 % in 30 minutes. Whether live data grows shows in the heap floor (the smallest `heapUsedMB` in each window), not in RSS: in S0.07 it stayed at 10 to 12 MB |
| CPU | Each metrics line has `cpuPct` (the whole process, every thread, so libdatachannel's too) and `mainThreadPct` (the event loop's busy share) |
| Node | Run with the repository's Node (`mise exec -- …` from the repository), never a newer global Node |

## The Pass Lines (spike S0.07)

| Line | Limit | How it is judged |
|---|---|---|
| No disconnects | every bot joined, none lost, for 30 minutes | a bot whose link closed before the run stopped it |
| Server tick | p99 ≤ 15 ms at 20 Hz | the whole run's ticks, exactly |
| Download per client, state | ≤ 350 kbps | p95 across clients of everything but `voiceBundle` |
| Download per client, with voice | ≤ 750 kbps | p95 across clients of everything |
| Serialisations | ≤ 2 per busy cell, independent of the clients | `encodings` against `busyCells` per tick |
| Join snapshot | ≤ 64 KB | the largest; the full roster beside it is reported too |
| Server upload | ≤ 30 Mbps at 50 bots; logged at 200 | the wire counters (application bytes without isolation) |
| Memory growth | < 10 % | RSS, 5 minutes to the end; the trend after 5 minutes beside it |

`smoke` fails when a bot did not join, lost its link, got no snapshot or no pong, nobody heard any voice, or a correction or malformed message appeared.

## The End-to-End Test

`node tools/bots/src/e2e.ts -- CLIENT [--shot FILE] [--shots DIR]` runs Stage 1's path with the core, two plaza world servers whose portals lead to each other and the packaged client under Playwright: the world browser, the join, walking, chat, and the walk back through the portal into the second world (S2.11); it lives here because, like `client-check`, it orchestrates real programs. Read `client-app` for what it checks. The checks that start programs share `src/procs.ts` (`start` waits for a JSON line, `stop` asks through standard input, `waitFor` polls); world servers they start get `--data` in their own folder, never the default under the home directory.

## Correct vs. Incorrect

**Incorrect:** bots and server on the same cores.
```sh
npm run bots -- run --transport rtc --bots 200 --minutes 30
```
**Correct:**
```sh
npm run bots -- run --transport rtc --bots 200 --minutes 30 --server-cpus 0-1 --bot-cpus 2-7
```
**Why:** 200 bots decode every snapshot; on shared cores their work lands inside the server's ticks and the tick p99 measures the bots.

**Incorrect:** reading `pc.bytesSent()` or a link's `sentBytes` as bandwidth.
**Correct:** the `wire.jsonl` counters of an isolated run.
**Why:** both count message bytes only; on the wire the raw UDP transport added 22 % to 49 % and WebRTC about 100 % at 50 bots (small snapshots pay the headers).

**Incorrect:** a bot sending from its scheduler after `stop()`.
**Correct:** `tick()` returns once `stopping` is set; the link closes 200 ms after the `leave`.
**Why:** a send on a closing WebRTC channel throws inside the timer and kills the swarm before its `summary`, and its bots vanish from the report.
