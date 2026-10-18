---
title: The Voice Chain — Capture, Opus Through WebAssembly, the Playout Buffer, Distance, HRTF, Mouth Shapes and the S0.08 Tests
impact: HIGH
impactDescription: Decoding without in-band FEC, a sender whose sequence numbers skip silent slots, a playout buffer that counts silence as jitter or stretches speech mid-spurt, transferring a decoder's WebAssembly memory, a worklet left out of the rendered graph, or a page without 'wasm-unsafe-eval' makes voice choppy, silent or broken, and the S0.08 pass lines unmeasurable.
tags: voice, voice chain, protocol 1, start bit, slot, gap, voice-sample, audio, web audio, AudioContext, AudioWorklet, worklet, capture, playout, getUserMedia, echo cancellation, noise suppression, opus, libopus, libopus-wasm, wasm, webassembly, wasm-unsafe-eval, webcodecs, fec, in-band fec, packet loss concealment, plc, jitter, jitter buffer, playout buffer, talk spurt, latency, mouth to ear, distance, fade, 25 m, gain, low-pass, hrtf, PannerNode, mouth shapes, visemes, lipsync, formants, voice test, voice load, voice-check, --voice-test, --voice-load, S0.08, S-VOICE, DR-09, DR-10
---

This rule governs `apps/client/src/renderer/src/voice/`: how the client turns a microphone into voice frames and heard voices into sound placed in the world. The world server only forwards frames (`world-networking`); everything about sound happens here.

## The Files

| File | Job |
|---|---|
| `opus.ts` | The codec: libopus 1.6.1 compiled to WebAssembly (`libopus-wasm`, MIT, Xiph's BSD libopus inside): mono 48 kHz, 20 ms frames, 24 kb/s, VoIP, in-band FEC |
| `capture-worklet.ts` | Audio thread: the source's 128-sample blocks gathered into 960-sample (20 ms) frames, posted to the main thread |
| `playout-worklet.ts` | Audio thread, one per heard speaker: plays decoded frames and asks for the next whenever less than about 28 ms of audio (one frame and three 128-sample blocks) is queued or asked for, so the audio clock paces decoding without adding a second frame of delay |
| `jitter.ts` | The playout buffer, pure: per speaker, what to play every 20 ms |
| `distance.ts` | Gain and low-pass by distance, pure |
| `mouth.ts` | Viseme weights and loudness from a frame, pure |
| `chain.ts` | `VoiceChain`: wires the above with Web Audio |
| `voice-test.ts`, `onset-worklet.ts`, `load-test.ts` | Spike S0.08's measurements |

## Why Opus Runs as WebAssembly, Not WebCodecs

DR-09 named WebCodecs. Its `AudioDecoder` cannot rebuild a lost frame from the next packet's in-band FEC, and S0.08's line (at 5 % loss and 40 ms jitter, at most 2 % of frames concealed) needs that. `libopus-wasm` exposes it: `decodeFloat(next, { decodeFec: true, frameSize: 960 })` rebuilds the missing frame, and `decodePacketLossFloat(960)` conceals when the next packet is not there either. Measured in Node on 2026-10-17: 24 kb/s packets of 53 to 77 bytes, encoding about 0.3 ms and decoding about 0.024 ms per 20 ms frame on the desktop. The page's CSP needs `'wasm-unsafe-eval'` in `script-src` to compile it (`client-electron`).

## The Playout Buffer (`jitter.ts`)

| Point | Rule |
|---|---|
| Delay | Each talk spurt starts playing `delay` after its first frame arrived: one frame (20 ms) plus three times the measured jitter, at most 80 ms; chosen at each spurt's start, never mid-spurt, so speech is never stretched. On a clean link about 21 ms: the world server forwards each speaker's frames on its 20 ms step, so they arrive evenly (the floor was 40 ms until 2026-10-17; the chain's latency is the S0.08 line) |
| Slots (protocol 1) | `seq` counts the sender's 20 ms slots, silent ones too, and `start` marks the first frame after silence (RTP's sequence number and marker bit). Without them a pause between words shifts every later frame: the buffer waits for frames that were never sent, conceals, then drops the real ones as late |
| Jitter estimate | RFC 3550's interarrival jitter against the slot clock, only between arrivals less than 200 ms apart: across a long silence the sender's clock may have paused (a suspended audio context), and one such sample would push the delay to its maximum |
| Each 20 ms step | The next frame in order (`frame`); a missing slot before a buffered `start` frame is the speaker's silence (`gap`, played as silence); any other missing frame is lost: rebuilt from the following packet when it is already here and is not a `start` frame (`fec`), otherwise concealed (`conceal`) |
| Pauses concealed | Steps concealed while the `start` frame after a pause is still on its way were the pause: when that frame plays, they move from `concealed` to `gaps` |
| End of a spurt | Five empty steps (100 ms); the concealed steps of that tail are the speech ending, not losses, and are not counted |
| Late, duplicate | Counted and dropped; sequence numbers compare across the 16-bit wrap (`seqDiff`) |
| Measured (simulation, 20 seeds of 2 minutes) | At 5 % loss and 40 ms jitter: 0.25 % concealed on average (worst 0.40 %), 4.6 % rebuilt from FEC, a 58 ms delay; with a pause between words every 500 ms, 0.72 % (worst 1.25 %), because a lost `start` frame leaves its pause counted as concealed; at 10 % loss, 1 to 1.7 % |
| Measured (real speech) | `scripts/voice-sample.ts`, a 30 s LibriVox reading, 2026-10-17: before protocol 1, 3.7 to 4 % concealed and 12 late frames even on a clean link; with it, 0 % on a clean link, 0.34 % at 5 % loss and 40 ms jitter (0.08 % of the sent frames truly concealed), 0.92 % at 10 % loss and 60 ms jitter |

## The Chain (`chain.ts`)

| Point | Rule |
|---|---|
| Sending | Source → capture worklet (its silent output goes to the destination, which keeps it in the rendered graph) → mouth shapes → a voice gate (level ≥ 2 of 15 opens it, 200 ms of hangover) → Opus → `send`. `seq` goes up every 20 ms slot, sent or not; the first frame after a shut gate has `start` |
| Muting | `chain.muted = true` keeps the gate shut, so the first frame after unmuting has `start`; never drop frames after the chain made them (the listener would wait for them). `chain.micLevel` is the last frame's loudness, sent or not, for a microphone meter |
| Hearing | Up to 16 speakers, each with a decoder from a pool made at start (decoders are created asynchronously, so none is made while frames arrive), a playout worklet, a low-pass filter, a gain and an HRTF `PannerNode`, the panner also sent to the chain's own reverb (S6.06, rule `audio`); a speaker behind a wall (`occlude`) plays at `OCCLUDED_GAIN` with its cutoff at most `OCCLUDED_HZ` |
| Distance | `voiceGain`: full to 1 m, then `(1 − x)²` to silence at 25 m; `voiceCutoffHz`: 18 kHz near to 2.5 kHz at 25 m. The panner's own distance model is off (`rolloffFactor: 0`), so the curve is one function, tested |
| Decoder output | Copied (`Float32Array.from`) before it is transferred to a worklet: it may sit in WebAssembly memory |
| Forgetting | A speaker unheard for 3 s gives its decoder back to the pool |

## Latency (measured for S0.08, 2026-10-17)

| Part | Time |
|---|---|
| The chain, scheduled sound to the listener's output, clean link | p50 97 to 121 ms, p95 110 to 127 ms over four runs (the three 20 ms clocks line up differently each run) |
| The same over about 5 % loss and 40 ms of jitter | p50 157 ms, p95 177 ms |
| Where it goes, on average | about 10 ms filling the capture frame, a few ms encoding and sending, about 10 ms to the world server's next voice step, the playout delay (about 21 ms clean), about 10 ms to the playout worklet's next request, about 27 ms queued in the worklet, 6.5 ms of Opus |
| This desktop's devices (Linux, PipeWire) | Chromium reports a base latency of 10.7 ms and an output latency of 80 to 96 ms; neither `--audio-buffer-size` nor `PULSE_LATENCY_MSEC` changes the output part (the PipeWire graph and the sound card) |
| Cuts left in our code | the worklet's 28 ms queue (one frame and three blocks) toward one frame and one block; a 10 ms voice step on the server; folding the request wait into the playout delay: perhaps 20 to 30 ms together |

Mouth to ear is the chain plus the speaker's input latency and the listener's output latency. The lounge shows each machine's on its "Audio devices" line (`ctx.baseLatency + ctx.outputLatency`, and the microphone track's `latency` setting), so a two-machine test records them.

## Mouth Shapes (`mouth.ts`)

A 1,024-point spectrum of the Hann-windowed frame, F1 (the strongest smoothed peak from 250 to 1,000 Hz) and F2 (from 800 or F1 + 200 Hz to 2,800 Hz), and each viseme's closeness to its vowel's typical formants on a log scale (aa 750/1,250 Hz, ih 300/2,300, ou 320/850, ee 480/1,900, oh 500/900), scaled by loudness (−48 dB closed, −12 dB fully open). No calibration; uLipSync's MFCC method (rr-013) can replace it behind `mouthShape`.

## The S0.08 Tests

| Test | Command | Measures |
|---|---|---|
| Pure parts | `npm test -w @flatchat/client` (`test/voice.test.ts`) | The playout buffer under loss and jitter (the 2 % line, with and without pauses between words), pauses told from losses by `start`, the distance curve, mouth shapes for synthetic vowels |
| Real speech | `node apps/client/scripts/voice-sample.ts IN.wav OUTDIR --loss 5 --jitter 40` | A mono 48 kHz WAV through the client's gate, Opus and playout buffer over a simulated lossy link; writes WAVs to listen to and `stats.json` with the buffer's counts and the truth per sent frame |
| The chain end to end | `npm run bots -- voice-check --seconds 20 -- <client>` | One client joins twice (speaker and listener in one AudioContext, so one clock): 1 kHz bursts every 400 ms through the whole chain and the world server; latency from scheduled sound to played sound, the output device's latency beside it; then the listener walks away at 5 m/s and the heard level is recorded by distance |
| Sixteen voices | `<client> --voice-load=30` | 16 speakers of real Opus through the hearing side with no network; the renderer's, audio service's and GPU process's CPU from `app.getAppMetrics()` |
| What only the owner can judge | his listening test with two machines | No audible echo on laptop speakers, intelligibility at 5 % loss, the microphone under PipeWire |
