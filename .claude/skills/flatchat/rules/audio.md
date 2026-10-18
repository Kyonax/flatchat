---
title: 3D Audio — Occlusion by Ray, Reverb Zones on a Convolver per Context, the Ray Budget and the Audio Bench
impact: MEDIUM
impactDescription: A ray that starts inside the player's capsule finds every sound occluded; a sound inside its own fountain is muffled by it without a clearance; one ray per sound per frame grows with the world; a convolver swapped in place clicks and one per sound costs a core; a reverb sent before the panner is heard past a sound's silent distance; an audio bench timed once is noise.
tags: audio, 3D audio, occlusion, reverb, reverb zone, room, mix, REVERB_ROOMS, ReverbRoom, REVERB_MIX, acoustics.ts, Occlusion, OCCLUSION_RAYS, OCCLUDED_HZ, OCCLUDED_GAIN, OCCLUSION_EASE, SOURCE_CLEARANCE, Reverb, impulseResponse, ROOM_ACOUSTICS, IMPULSE_MAX_S, reverbAt, Physics.blocked, castRay, ConvolverNode, BiquadFilterNode, PannerNode, HRTF, settings.sound.occlusion, settings.sound.reverb, data-test=audio, audio bench, --bench-audio, OfflineAudioContext, S6.06, DR-10, Q-H1
---

Stage 6's S6.06 (DR-10, Q-H1): walls muffle, rooms echo. The picture is `docs/audio.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/scene.ts` | Zone kind `reverb` with `room` (`REVERB_ROOMS`: small, room, hall, cave, cathedral; `room` by default) and `mix` (0 to 1, `REVERB_MIX` 0.35 by default); refused with `marker-invalid` otherwise |
| `packages/content/src/built.ts` | `BuiltZone` keeps `room` and `mix`; a host's reverb zone read again (room listed, mix 0 to 1) |
| `apps/world-server/src/server.ts` | `updateVoice` applies range and gain from `voice` zones only: a reverb zone is the client's |
| `apps/client/src/renderer/src/world/acoustics.ts` | `Occlusion` (rays a frame within `OCCLUSION_RAYS` 16, each sound in turn, out-of-reach ones forgotten, `takeCounts`), `impulseResponse` (seeded noise, 60 dB down over the room's RT60, darker as it falls, unit energy, two channels apart), `ROOM_ACOUSTICS`, `Reverb` (one convolver at a time per context, crossfaded on a change, the old one let go after 1 s), `reverbAt` (the smallest reverb zone holding the head) |
| `apps/client/src/renderer/src/world/physics.ts` | `blocked(from, to, clearance)`: Rapier's `castRay`, solid, excluding the player's own capsule, stopping `clearance` short of the sound |
| `apps/client/src/renderer/src/world/sounds.ts` | Each placed emitter: source, gain, low-pass (open at 20 kHz), panner, master; the panner also to `reverb.input`; `audibles`, `occlude`, `room`; footsteps sent to the room; global emitters never |
| `apps/client/src/renderer/src/voice/chain.ts` | Each speaker's panner also to the chain's own `Reverb`; `occluded` lowers the gain by `OCCLUDED_GAIN` and caps the cutoff at `OCCLUDED_HZ`; `audibles`, `occlude`, `room` |
| `apps/client/src/renderer/src/world/emote-sounds.ts` | `sendTo(node)`: the emotes' master also to the world's reverb |
| `apps/client/src/renderer/src/world/session.ts` | `acoustics()` each joined frame: the head (feet + eye height × scale), every audible sound and voice, `occlusion.update` unless switched off, `reverbAt` unless switched off; `state.audio` (audible, occluded, room; rays, rayMs, worstMs every 500 ms) |
| `apps/client/src/renderer/src/crowd/audio-bench.ts` | `--bench=S --bench-audio=1`: an `OfflineAudioContext` worst case (16 HRTF voices, 64 placed sounds) plain, with filters, with two cathedral convolvers, with both, each rendered twice (the faster kept) after a warm-up; then 600 frames of rays in a test room with a triangle ground |

## The Rules

| Rule | Why |
|---|---|
| Cast from the head, excluding the player's capsule (`filterExcludeCollider`), solid | The head is inside the capsule: without the exclusion every ray hits the player at once |
| Stop each ray `SOURCE_CLEARANCE` (0.5 m) short of the sound | Emitters sit inside fountains, speaker boxes and lamps: their own solid would muffle them forever |
| At most `OCCLUSION_RAYS` a frame, each sound in turn; the state eased over `OCCLUSION_EASE` (80 ms) | 80 sounds at one ray each per frame is 80 ray casts; in turn, each is tested every five frames and the ease hides the step |
| Send to the reverb after the panner | Its distance gain then applies to the echo too: a sound past its silent distance is not heard in the room |
| One convolver per audio context (the world's and the voices' are two), crossfaded by a new one on a change of room | A convolver per sound costs a core; a buffer swapped in place clicks |
| Make each impulse in code, seeded, unit energy, `normalize = false` | No sound files to ship or check; every room as loud as the others; the same room always the same |
| Global emitters (music, ambience) stay dry | Music echoing in a hall is not what a world maker means |
| A voice's cutoff under occlusion is the lower of `OCCLUDED_HZ` and its distance cutoff | Occlusion must never brighten a far voice |
| The audio bench: a warm-up render, each run twice and the faster kept, its share of one core = render time / audio length; its exit code passes on no error (`exitCodeFor`, mode `audio-bench`, no GPU backend) | The first render loads the HRTF database; anything else on the machine only slows a run; a bench report without a GPU backend otherwise exits 1 |
| The budget: the worst case at most a quarter of one core, the rays at most 0.5 ms a frame (on this desktop: 13 % and 0.02 ms) | The reference laptop's numbers are the owner's run of the same bench |

## The Test Room

- `apps/client/test/acoustics.test.ts`: a 10 m room in Rapier, split by a wall with a 1.2 m door; behind the wall occluded, through the door and on this side clear, the capsule and a speaker box never in the way; 80 sounds in 16-ray frames (30 behind the wall occluded, the 10 in line with the door heard); the impulses; `reverbAt` (nested, turned); the reverb's crossfade with a fake context; emitters muffled and opened.
- The e2e's garden (`make-travel.ts --acoustics`, the park only): a hall reverb zone around the arrivals, a `flatchat:wall-4` 4 m south with a sound 2 m behind it, a sound 1.5 m west in the open; the e2e waits for `[data-test=audio][data-room="hall"][data-audible="2"][data-occluded="1"]` (`worldAudio`).
