# Quality settings

What FlatChat draws and at what quality (Stage 6's S6.08; Q-M4, Q-D7, Q-B1). A preset per hardware tier sets the resolution, smoothed edges, which of a world's screen effects may run and the room's echo; the frame-rate tuner takes more away while frames are slow and gives it back when they recover; the stats panel shows what each frame costs.

## The presets

Settings, Graphics, Quality:

| | Low | Medium | High |
|---|---|---|---|
| Resolution (share of the window) | 75 % | 100 % | 100 % |
| Most screen pixels per CSS pixel | 1 | 1.5 | 2 |
| Smoothed edges (from the next world) | off | on | on |
| Screen effects allowed | bloom, filters | bloom, light shafts, filters | all four |
| The room's echo (reverb zones) | off | on | on |
| Avatars at lower detail, and with spring bones (S4.05; how many in full is the player's own number) | 12, 2 | 20, 6 | 28, 8 |
| Strangers' creator shaders | never | when allowed | when allowed |

**Automatic** (the default) takes the tier this computer measured on its first visit to a world (S4.05: the frames over its first seconds). **Custom** keeps the player's own resolution, pixel density and smoothed edges, with every screen effect allowed. Within what the preset allows, the player's own switches still decide (each screen effect, the echo, occlusion).

## The frame-rate tuner

Settings, Avatars, "The frame-rate tuner" (on by default). Every two seconds the slowest tenth of the frames decides: past 33 ms (under 30 frames a second) it steps down, under 20 ms three times running it steps back up, and it never steps more often than every four seconds, so it does not flicker.

| Step | Avatars in full | Resolution | Screen effects |
|---|---|---|---|
| 0 | all the preset allows | the preset's | the preset's |
| 1 | 75 % | | |
| 2 | 50 % | 85 % | |
| 3 | 50 % | 70 % | no reflections or light shafts |
| 4 | 25 % | 60 % | no bloom either |

The resolution never goes below half a pixel per CSS pixel.

## The stats panel

F3 in a world (rebindable; also Settings, Graphics): frames a second; the mean and 95th-percentile frame time over the last 120 frames; this frame's draw calls and triangles (the look's passes included); meshes and textures held and the page's memory; the resolution drawn and its pixel ratio; the preset and the tuner's step; the avatars at each level; effect instances; the round trip and the players; the 3D audio's rays and their milliseconds a frame; the renderer. It stays open across worlds until pressed again.

## For tests

`flatchat --quality=low|medium|high` draws at that preset for one run, whatever the settings say, with the tuner off, so a run draws exactly that. CI's end-to-end runs use it: the first at high, the one through a TURN relay at low (S6.08's Verify: the acceptance run on the low preset), which checks that the room's echo is off and everything else still works.

## Where

`apps/client/src/renderer/src/world/quality.ts` (`PRESETS`, `presetOf`, `qualityOf`, `QualityTuner`, `TUNER_STEPS`, `allowedLook`, `pixelRatioFor`), the session (`quality`, the pixel ratio each frame, `statsNow`), `ui/StatsPanel.vue`, the settings' `graphics` group; tests in `apps/client/test/quality.test.ts`.
