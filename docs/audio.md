# 3D audio

Sounds in a world come from where they are (Stage 2's S2.14 and the voice chain): each voice through an HRTF panner at its speaker's mouth, each placed sound of the world through a panner at its emitter, footsteps and emote sounds where the players are. Stage 6's S6.06 (DR-10, Q-H1) adds the walls and the room: a sound or voice with a wall between it and the listener is muffled, and in a world's reverb zone everything heard has the room's echo. Each can be switched off in the settings (Sound: "Muffle sounds and voices behind walls", "Echo of the room you are in"; on until switched off).

## Behind a wall (occlusion)

Each frame the client casts rays from the listener's head to the sounds and voices within their reach through the world's solids (Rapier, the same solids the player walks among; the player's own body is never in the way). A sound with a solid between goes through a low-pass at 900 Hz and plays at 0.4 of its gain (about 8 dB down), eased over 80 ms so it never clicks; a voice takes the lower of that cutoff and its distance cutoff. The last half metre before a sound is not tested, so a sound inside its own fountain or speaker box is not behind it. At most 16 rays a frame, each sound in turn: with 16 voices and 64 emitters each is tested every five frames (about 80 ms at 60 frames a second).

## The room (reverb)

A world marks a room with a reverb zone (a box: `FLATCHAT_world`'s `zone` of kind `reverb`, its `room` and `mix`; see [the world format](world-format.md)). Inside one, every placed sound, footstep and emote sound, and every voice, also goes to one convolver per audio context (the world's sounds and the voices each have their own), whose impulse the client makes from the room: noise falling away by 60 dB over the room's reverberation time, darker as it falls, after a short delay, as loud as every other room, a different noise in each ear so the room is wide.

| Room | Reverberation time | Delay |
|---|---|---|
| `small` | 0.45 s | 4 ms |
| `room` | 0.9 s | 8 ms |
| `hall` | 1.9 s | 20 ms |
| `cave` | 3.2 s | 35 ms |
| `cathedral` | 4.8 s | 45 ms |

Music and ambience without a place (global emitters) are not sent to the room. Walking into another room crossfades to a new convolver over about 0.3 s; the old one is let go once silent. A listener in two reverb zones hears the smaller (a room inside a hall is the room); outside every reverb zone there is no echo.

## Measuring the cost

`flatchat --bench=SECONDS --bench-audio=1 [--bench-out=FILE]` renders the worst case the client allows (16 voices through HRTF panners and 64 placed sounds) offline, for the given seconds of audio, plain, with the occlusion's filters, with the longest room's reverb, and with both, and reports each one's share of one CPU core; then it casts the occlusion's rays for 80 sounds in a test room, 600 frames, and reports their milliseconds a frame. CI runs it on every change.

## Tests

- `apps/client/test/acoustics.test.ts`: a test room with walls (a sound behind the dividing wall occluded, through the door or on this side clear, the player's own body never in the way, a sound inside its own box not behind it), the ray budget, each room's impulse, the reverb zone the listener is in, the crossfade, the world's emitters muffled and opened again.
- `packages/content/test/world.test.ts` and `built.test.ts`: the reverb zone's room and mix read, unknown rooms and mixes out of range refused.
- The end-to-end test's garden has a hall around its arrivals and a sound behind a wall, and the test checks both are heard as such.
