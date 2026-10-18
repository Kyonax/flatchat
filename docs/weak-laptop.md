# The weak-laptop check

The plan's floor (S7.05, OQ-6): FlatChat at 30 frames a second at 720p on the low preset, with 55 avatars in view, on a tester's own Intel Iris Xe or AMD 680M laptop, with real avatars, effects and the full interface. The same scene runs on the Iris Xe stand-in beside them (`npm run standin`, the weak-laptop stand-in in the engine skill).

## The scene

The owner hosts a world (the hangout, `kits/worlds/hangout/`, or any other) on his PC and fills it with bots that look like players: each is an account on his core wearing one of the three standard bodies, and the first ten also wear the starter aura (an Effekseer effect). On the host's PC, beside the world server:

```sh
node --env-file=$HOME/.config/flatchat/core.env tools/bots/src/scene.ts \
  --core https://core.example.org --world WORLD_ID --udp 127.0.0.1:WORLD_UDP_PORT \
  --bots 55 --effects 10 --minutes 30
```

The first run makes the accounts with the core's admin tool (`scene-bot-0@example.org` and on, testers, signed in after); a later run signs them in again. Every bot's requests come from that one PC, so the script asks gently and waits when the core's per-address limit answers. It prints one line when the bots are in (`joined`, `effects`) and one when they leave.

## The testers

1. Install FlatChat (the latest build) and sign in.
2. Join the world. In Settings, Graphics: Quality **Low**; the window at 1280×720 (or the laptop's screen at 720p).
3. Stand where the bots mingle, facing them, so most of them are in view.
4. Press **F3**: the stats panel shows the frames a second, the mean and 95th-percentile frame time, the draw calls, the resolution drawn, the preset and the tuner's step, and the avatars at each level.
5. Stay two minutes, walking a little and talking; then take a screenshot of the stats panel and send it with the laptop's model, its GPU and its power mode (plugged in or on battery).

The pass line is 30 frames a second (a frame time near 33 ms at the 95th percentile) with the tuner at step 0 or 1; a tuner further down means the laptop needed less to keep up, which the report says too.

## The stand-in

On the owner's desktop, the same scene through the Iris Xe stand-in (`npm run standin -- run …`), and the converted crowd's bench beside it for the numbers without a network: `node tools/bots/src/avatar-bench.ts --from AVATARS --out DIR --client CLIENT --tier low --in-view 55`.
