# S-VOICE: the voice chain (spike S0.08)

**Question.** Does proximity voice stay clear and quick on ordinary laptops: from one player's microphone, through the world server, to another player's ears, placed where the speaker stands?

**Status.** Built, and measured on one machine on 2026-10-17. Clear: yes, by every line measurable without a person. Quick: the chain alone takes 110 to 127 ms (p95, clean link), and this desktop's audio output adds about 100 ms on top, so the 150 ms line for mouth to ear is not met here (below). The parts only a person can judge wait for the owner's listening test with two machines: echo with laptop speakers and no headset, intelligibility at 5 % loss, the microphone under PipeWire, and each machine's real device latencies.

## The chain

| Step | What does it | Where |
|---|---|---|
| Microphone | `getUserMedia` with Chromium's echo cancellation, noise suppression and gain control | the lounge (`lounge/lounge.ts`) |
| 20 ms frames | an AudioWorklet gathers the 128-sample blocks into 960-sample frames | `voice/capture-worklet.ts` |
| Mouth shapes | loudness and the five VRM visemes from the frame's first two formants | `voice/mouth.ts` |
| Voice gate | frames under the speech level are not sent (200 ms of hangover); `seq` counts every 20 ms slot, and the first frame after silence has `start` (protocol 1) | `voice/chain.ts` |
| Opus | libopus 1.6.1 as WebAssembly: 24 kb/s, VoIP, in-band FEC | `voice/opus.ts` |
| The world server | one bundle per listener every 20 ms: one frame from each of the nearest 16 speakers within 25 m | `apps/world-server/src/world/voice.ts` |
| Playout buffer | one frame (20 ms) plus three times the measured jitter, at most 80 ms (7 ms of jitter assumed until measured); a pause told from a loss by the `start` bit; a lost frame rebuilt from the next packet's FEC, or concealed | `voice/jitter.ts` |
| Playback | one AudioWorklet per speaker, paced by the audio clock; a low-pass and a gain by distance (silent at 25 m); an HRTF panner at the speaker's position | `voice/playout-worklet.ts`, `voice/distance.ts` |

WebCodecs, which the decision record named (DR-09), can encode Opus but cannot rebuild a lost frame from the next packet's FEC; the loss line below needs it, so both ends use libopus compiled to WebAssembly (`libopus-wasm`, MIT, with Xiph's BSD libopus inside; both credited in `CREDITS.md`, and their licences travel with the packaged client in `THIRD_PARTY_NOTICES.txt`).

## Measured on one machine

The desktop (Arch Linux, PipeWire, the packaged Linux client drawing WebGPU on the GTX 1660 SUPER), 2026-10-17. `npm run bots -- voice-check` starts a world server and the client joins it twice, as a speaker and a listener in one AudioContext, so both ends read one clock: 1 kHz bursts every 400 ms go through the whole chain and the world server over WebRTC, and a detector marks when each comes out.

| Pass line | Measured | Result |
|---|---|---|
| Mouth to ear p95 ≤ 150 ms on a good link | The chain, from the scheduled sound to the listener's output, without the devices: p50 97 to 121 ms and p95 110 to 127 ms over four runs. This desktop's output adds 10.7 ms (Chromium's base latency) and 80 to 96 ms (its reported output latency), which neither Chromium's `--audio-buffer-size` nor `PULSE_LATENCY_MSEC` changed: the PipeWire graph and the sound card. Mouth to ear here is therefore about 200 to 235 ms with the microphone's own latency | **not met on this desktop** |
| ≤ 250 ms across the internet | Over a link with about 5 % loss and 40 ms of jitter (netem below), the chain is p50 157 ms and p95 177 ms; with this desktop's devices, about 270 to 290 ms | **not met on this desktop**; the internet case is the owner's test |
| No audible echo with laptop speakers and no headset | Chromium's echo cancellation is on in the lounge | the owner's test |
| The voice fades to silence by 25 m | Walking away at 5 m/s, the loudest level heard per 2.5 m: −12 dB up to 5 m, −17 dB at 7.5 to 10 m, −25 dB at 15 to 17.5 m, −36 dB at 20 to 22.5 m, −45 dB at 22.5 to 25 m, −66 dB just past 25 m (the gain eases over 50 ms while walking), silence beyond 27.5 m | **pass** |
| At most 16 voices heard | The world server forwards at most 16 speakers per listener, nearest first (`voice.ts`, tested) | **pass** |
| At 5 % loss and 40 ms jitter, concealed frames ≤ 2 % | The real client over an isolated network with netem `delay 10ms 10ms loss 2.5%` on each loopback crossing (a voice frame crosses twice: about 5 % loss and 40 ms of jitter end to end): 75 of 75 bursts heard, 0.18 % of frames concealed, 50 rebuilt from FEC, 112 slots of silence told from losses by `start`. Real speech through the same code (`apps/client/scripts/voice-sample.ts`, below): 0.34 % concealed by the buffer's count, 0.08 % of the sent frames truly concealed | **pass**; "speech stays intelligible" is the owner's test |
| 16 incoming voices cost ≤ 10 % of one laptop core | `--voice-load=30`: 16 speakers of real Opus through the whole hearing side, decoding 0.038 ms per frame (3.1 % of one core on the main thread); the renderer's process 2.7 %, the GPU process 3.9 %, the audio service 0.1 % of one desktop core | **pass** on the desktop; a laptop core is slower, with room to spare |
| The microphone works under PipeWire on Linux | The lounge asks for it with the three processing options on | the owner's test |

Other numbers: encoding takes 0.23 ms per 20 ms frame (about 1 % of a core while talking); 24 kb/s packets are 53 to 77 bytes.

### The chain's latency, step by step

The bursts all fall at the same place in the three 20 ms clocks (capture, the world server's voice step, the playout worklet's requests), so each run's p50 and p95 sit close together and the runs differ by how those clocks happen to line up. On average: about 10 ms waiting for the capture frame to fill, a few ms of encoding and sending, about 10 ms waiting for the world server's next voice step, the playout buffer's delay (about 21 ms on a clean link), about 10 ms waiting for the playout worklet's next request, about 27 ms queued in the worklet ahead of the output, and Opus's 6.5 ms. Cuts available in our own code, for S1.11: the worklet keeps 28 ms queued (one frame and three 128-sample blocks) where one frame and one block might do; the world server's voice step could run every 10 ms; the request wait could fold into the playout delay. Together perhaps 20 to 30 ms. The device part is each machine's own, and it is the larger share on this desktop.

### Found and fixed on the way

- **The sequence number skipped silence.** In protocol 0 a sender numbered only the frames it sent, so after a pause between words the listener's buffer waited for frames that were never sent, concealed them, then dropped the real ones as late: real speech read 3.7 to 4 % concealed and 12 late frames even on a clean link. Protocol 1 counts every 20 ms slot and marks the first frame after silence (`start`), as RTP's sequence number and marker bit do; the buffer plays a known pause as silence. Real speech now reads 0 % concealed on a clean link.
- **The spawn could be lost.** The world server sent a player's spawn once, in a snapshot on the unreliable channel, and a client that asked for it after another join had already passed it by never got it (the voice test timed out). The world server now repeats the spawn until the player's first pose arrives, and the client's join waits for it, so every caller has it.
- **A real client could not run inside the isolated network.** Electron will not start as root, which the run is inside its namespace, and Chromium leaves loopback out of WebRTC's candidates. The client now runs as the user who started the run (a nested user namespace, its sandbox intact) and the world server listens on a private address on a dummy interface, whose traffic still crosses loopback, where netem acts.

### Real speech

`node apps/client/scripts/voice-sample.ts IN.wav OUTDIR --loss 5 --jitter 40` sends a recording through the client's own gate, Opus and playout buffer over a simulated lossy link, and writes the original, the clean Opus and the lossy Opus as WAV files to listen to side by side. The sample is 30 s of a public-domain LibriVox reading of Wordsworth's "Daffodils" (archive.org, `short_poetry_001_librivox`), kept outside the repository.

| Link | Sent | Lost | Concealed (the buffer's count) | Concealed (truly) | Rebuilt from FEC | Late |
|---|---|---|---|---|---|---|
| clean | 1,188 | 0 | 0 % | 0 % | 0 % | 0 |
| 5 % loss, 40 ms jitter | 1,188 | 70 | 0.34 % | 0.08 % | 5.8 % | 0 |
| 10 % loss, 60 ms jitter | 1,188 | 126 | 0.92 % | 0.67 % | 9.9 % | 0 |

The buffer counts a few more than the truth because when the `start` frame after a pause is lost, the pause before it looks like a loss.

## The listening test (the owner)

Two machines on the same network (or the same Tailscale network, for the internet case), each with speakers and a microphone; no headsets for the echo check.

1. On the desktop, from the repository: `npm install`, `npm run build -w @flatchat/client`, then `npm run bots -- lounge`. It prints the lounge's address and one command per player.
2. On the desktop, run player 1's line with `<client>` replaced by `npx electron apps/client`. On the laptop, run player 2's line with the packaged client (`FlatChat.exe` from the latest CI run's `client-windows` zip, or `apps/client/release/linux-unpacked/flatchat`). If the laptop cannot join, allow TCP 7779 and UDP 7778 in the desktop's firewall.
3. Talk with laptop speakers and no headset: is there any echo of your own voice? Walk apart with WASD (the map shows the distance): the voice should fade and be gone by 25 m. M mutes the microphone.
4. Write down what each screen shows on its "Audio devices" line (the output and input latency Chromium reports there): mouth to ear is about the chain (110 to 130 ms on a good link) plus the speaker's input and the listener's output.
5. For the loss check, on one machine: `npm run bots -- voice-check --netem "delay 10ms 10ms loss 2.5%" -- npx electron apps/client` measures it. To hear real speech at 5 % loss, `node apps/client/scripts/voice-sample.ts` writes the WAV files above from any mono 48 kHz recording.
6. Write down: echo (none, faint, clear), how the fade sounded, anything choppy, the two "Audio devices" lines. The agents record it in the brain and close the spike.
