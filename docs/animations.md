# Animations: emotes and dances

FlatChat plays emotes and dances on every avatar, whatever its shape, because every animation is converted to **VRMA** (VRM Animation 1.0) before anyone sees it. A VRMA moves VRM's standard humanoid skeleton, and each client fits that motion to the avatar in front of it (Stage 5, S5.07).

## What to bring

| Format | From | Notes |
|---|---|---|
| VRMA (`.vrma`) | The VRM Add-on for Blender, VRoid's tools, UniVRM | Taken as it is, then checked |
| GLB clip (`.glb`) | Blender's glTF exporter, Mixamo through Blender, Unity, Quaternius and Mesh2Motion packs | A skeleton with an animation. Bones are recognised by their names: Mixamo's, Unity's, Blender's, VRoid's |
| BVH (`.bvh`) | Motion capture: CMU's library, Rokoko, MotionBuilder, Blender | Read directly |
| FBX (`.fbx`) | Mixamo, Maya, MotionBuilder, Unreal | FlatChat reads it with headless Blender first, then like a GLB clip. The character's mesh is dropped |

The skeleton needs the bones VRM requires: hips, spine, head, both upper arms, lower arms and hands, and both upper legs, lower legs and feet. Fingers, the chest, the neck, shoulders and toes are used when they are there. One animation per file (the longest one, if there are several), up to two minutes long.

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

## Making a good one

- Rest the skeleton in a T-pose, or close to it. An A-pose is straightened, but a pose far from either is measured from its own rest.
- Keep translation on the hips only. The converter ignores it anywhere else.
- For a dance that loops, end on the pose you started from.
