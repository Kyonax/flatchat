# Animations: emotes and dances

FlatChat plays emotes and dances on every avatar, whatever its shape, because every animation is converted to **VRMA** (VRM Animation 1.0) before anyone sees it. A VRMA moves VRM's standard humanoid skeleton, and each client fits that motion to the avatar in front of it (Stage 5, S5.07).

## What to bring

| Format | From | Notes |
|---|---|---|
| VRMA (`.vrma`) | The VRM Add-on for Blender, VRoid's tools, UniVRM | Taken as it is, then checked |
| GLB clip (`.glb`) | Blender's glTF exporter, Mixamo through Blender, Unity, Quaternius and Mesh2Motion packs | A skeleton with an animation. Bones are recognised by their names: Mixamo's, Unity's, Blender's, VRoid's |
| BVH (`.bvh`) | Motion capture: CMU's library, Rokoko, MotionBuilder, Blender | Read directly |
| FBX (`.fbx`) | Mixamo, Maya, MotionBuilder, Unreal | FlatChat reads it with headless Blender first, then like a GLB clip. The character's mesh is dropped |

The skeleton needs the bones VRM requires: hips, spine, head, both upper arms, lower arms and hands, and both upper legs, lower legs and feet. Fingers, the chest, the neck, shoulders and toes are used when they are there. One animation per file (the longest one, if there are several), up to two minutes long. Bones named in Unreal's style (`lowerarm_r`, `ring_01_l`) read as well as Mixamo's and Rigify's.

## What the converter does

- It stands the skeleton up and turns it to face forward. A Z-up rig, or one facing away, is fine.
- It measures each bone's motion from VRM's T-pose. A rig that rests in an A-pose (arms down, as MakeHuman's and many VRoid and Blender rigs do) has its rest straightened into the T-pose first, so the arms move where they should. The warnings say when it did this.
- It samples the motion at 30 frames a second, and keeps each bone that never moves as a single key.
- It keeps the hips within 50 cm of where they start. An emote plays in place; a dance may sway.
- It finds out whether the animation loops: its first and last poses must meet within 2°.
- It writes one VRMA and a manifest, each named by its SHA-256, and checks the VRMA with the Khronos glTF-Validator and with the client's own check.

Scale doesn't matter: centimetres, inches or metres all work, because each client scales the hips' travel to the avatar.

## Where it is converted

FlatChat converts every animation on its own servers, in a sandbox. FBX needs Blender there; a server without it refuses FBX and says so, so export a GLB or a BVH instead. Your animations are listed with their status, use (an emote plays once, a dance loops), length, whether they loop, and any warnings or reasons for a refusal.

## Playing them

Upload an emote or a dance from the client's home screen (Upload an emote, Upload a dance). In a world, press B for your emotes and dances and pick one: everyone nearby sees it, in step, from the moment it started. Two gestures are there for everyone without an upload, Wave hello and Dance (the default clips' greeting and dance); every client carries them, so nothing is fetched to play them. A dance repeats until you stop it or walk; an emote plays once. Players far away, drawn as impostors, keep walking instead.

## Sounds

An emote or a dance can bring a sound: tick "With a sound" before uploading, then pick a WAV or an Ogg (Vorbis or Opus), up to 8 MB and two minutes. Everyone near the dancer hears it, from the dancer's place, in step with the motion. A dance's sound repeats with it; an emote's plays once. FlatChat bakes a mouth track from the sound with Rhubarb Lip Sync, so the avatar's mouth moves with the singing. Each player sets the volume of emote and dance sounds in Settings, Sound, and 0 turns them off. Only use sounds you have the right to share.

## The default clips

Every avatar also moves with the platform's own clips (Track P's P.05, in [kits/animations/](../kits/animations/)): idle, walk, jog and sprint; a jump's start, its air and the landing, and a fall; sitting down, sitting and getting up; a greeting and a dance. They come from two CC0 libraries, retargeted by the same converter: Mesh2Motion's human clips (by Scott Petrovic and the Mesh2Motion contributors) and Quaternius's Universal Animation Library. Each one passes four checks on all three standard bodies:

- it moves only by turning bones, plus the hips' travel: no scale tracks;
- a loop's last pose meets its first within 1°;
- idle keeps both hands out of the torso;
- on walk and jog, a planted foot slides at most 2 cm a step at both ends of the legs slider.

A foot counts as planted while it bears weight the way its gait does: flat on the ground in a walk, on the ball of the foot in a run. The ball rolling onto the toe tips at the end of a walk's step is not counted as sliding, since no bone marks the toe tips. Mesh2Motion's jog and sprint slid more than that (up to 2.7 cm and 6 cm a step), so those two come from Quaternius. Neither library has an in-place turn, so a body turning on the spot doesn't step.

## Making a good one

- Rest the skeleton in a T-pose, or close to it. An A-pose is straightened, but a pose far from either is measured from its own rest.
- Keep translation on the hips only. The converter ignores it anywhere else.
- For a dance that loops, end on the pose you started from.
