# Bots

Headless clients that speak the real protocol over a real transport: they join with connect tokens, move between gathering places, chat, send synthetic voice, and count every byte they receive. They load-test a world server on a PC and in CI.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Status: Stage 0's 200-bot spike (S0.07); its report is [docs/spikes/s-net.md](../../docs/spikes/s-net.md)

```sh
npm run bots -- smoke                                   # 12 bots on each transport for 4 s (the harness runs this)
npm run bots -- run --transport rtc --bots 200 --minutes 30 --server-cpus 0-1 --bot-cpus 2-7 --trace
npm run bots -- run --transport udp --bots 200 --minutes 5 --scenario crowd --netem "delay 20ms 2ms loss 1%"
npm run bots -- report tools/bots/out/<run>             # rebuild a run's report
npm run bots -- render tools/bots/out/<run>             # the top-down devlog clip (needs ffmpeg)
npm run bots -- client-check -- <client> --smoke        # the real client joins a world server over WebRTC (CI runs this)
npm run bots -- voice-check --seconds 20 -- <client>    # spike S0.08: the client measures its own voice chain
npm run bots -- voice-check --netem "delay 10ms 10ms loss 2.5%" -- <client>   # the same over a lossy link
npm run bots -- lounge --players 2                      # S0.08's listening test: a LAN world server and one command per player
```

netem acts on each crossing of the loopback interface, and a voice frame crosses it twice (speaker to server to listener), so `delay 10ms 10ms loss 2.5%` is about 5 % loss and 40 ms of jitter end to end. Inside the namespace the client runs as the user who started the run (a nested user namespace), since Electron will not start as root. Every world server the bots start runs with V8's young generation fixed at 16 MB per semi-space, as `npm run server` does; `run --semi-space MB` changes it (0 leaves V8's own sizing, which grows in steps: see the S-NET report's memory section). The bots' voice follows protocol 1: `seq` counts every 20 ms slot, silent ones too, and a burst's first frame has `start`.

On Linux a run starts itself inside a new user and network namespace (`unshare -Urn`, no root): only its own loopback, so nothing else's traffic mixes in, with nftables counting every datagram to and from the server and netem adding delay and loss when asked. `taskset` keeps the server and the bots on separate cores. Each run writes `run.json`, the server's and every swarm's JSON lines, the wire counters, `report.json` and `report.md` to `tools/bots/out/`.

| File | Job |
|---|---|
| `src/brain.ts` | How a bot moves (scenarios `hubs` and `crowd`) |
| `src/talker.ts` | When it talks: voice bursts, Opus-sized frames, mouth shapes, chat lines |
| `src/bot.ts` | One player on the protocol |
| `src/swarm.ts` | A process of bots |
| `src/run.ts` | The command line |
| `src/netns.ts`, `src/report.ts`, `src/render.ts` | The isolated network, the report and its pass lines, the devlog view |
