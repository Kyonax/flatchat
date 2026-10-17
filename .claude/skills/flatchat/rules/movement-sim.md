---
title: Movement — the Shared Character Controller, the Server's Move Checks, the Greybox Plaza and Map Options
impact: HIGH
impactDescription: Movement constants that differ between client and server make honest players rubber-band; a check that refuses falling or ignores rounding corrects every jump; a controller that trusts exact heights sinks players into the floor at spawn.
tags: movement, sim, packages/sim, character controller, step, advance, BODY, MOVE, JUMP_APEX, SNAP, gravity, jump, run, walk, stairs, step height, collision, boxes, AABB, checkMove, DEFAULT_LIMITS, too-fast, too-high, flying, corrections, sf-004, plaza, PLAZA, flatWorld, WorldMap, Solid, Surface, --map, mapOptions, spawn, Rapier, S1.08, S1.09
---

`packages/sim` (Apache-2.0, Web APIs only like `packages/protocol`) holds what client and server must agree on about movement (sf-004: each client moves itself; the server checks and corrects). It replaces nothing in the protocol; it decides what poses mean.

## The Controller

| Fact | Value |
|---|---|
| Axes | y up; yaw 0 faces -z and grows turning left (three.js cameras) |
| Body | an upright box of half-width `BODY.radius` 0.3 m and height 1.75 m; eyes at 1.62 m; ledges up to `BODY.step` 0.45 m are stepped onto |
| Speeds | walk 3.6 m/s, run 7 m/s; ground velocity changes at 40 m/s² (30 % of that in the air); diagonals are not faster |
| Jump | 5.2 m/s up, gravity 15 m/s²: `JUMP_APEX` 0.9 m |
| `step(state, input, dt, boxes)` | one step; keep dt at most 1/20 s. `advance` sub-steps a frame of any length in steps of at most 1/60 s (and caps it at 0.25 s) |
| `SNAP` | 1 cm: the feet stand on a surface up to this far above them. Positions travel rounded to 1/128 m, so a player placed on a 0.15 m floor arrives at 0.1484 m; without the snap it sank into the floor until it moved |

Horizontal movement resolves one axis at a time against the boxes (step up, else stop flush at the face); vertical movement lands on `groundBelow` or bumps a ceiling. The full movement set (slopes, seats, flying, click to move) moves to Rapier with the world format (S2.06, DR-13).

## The Server's Check

`checkMove(from, to, dt, limits, boxes)` returns `ok`, `too-fast` (more ground than `maxSpeed × dt + slack`; running plus 15 %, slack 0.75 m) or `too-high` (rising, with flying off, above the highest surface within 4 m plus `JUMP_APEX` plus slack). Falling is always allowed; walls are not checked yet. `World.applyPose` corrects any verdict but `ok`: the next snapshot carries the server's position with the pose's sequence number, and the client snaps back to it. Moves a walk cannot make (a seat, a teleport, S2.06) go through `teleport` and the world server's own rules (`world-networking`), never through a pose.

## Maps

`WorldMap` = `{ name, size, spawn: { x, y, z, radius, yaw }, solids, flying }`. `PLAZA` is Stage 1's greybox world (128 m: a paved square, the fountain, a stage with steps, two low platforms to jump onto, two high ones with stairs, benches, pillars, a wall around); `flatWorld(size)` is an empty square for load tests. The world server takes `--map plaza` (its own size and spawn: `--world-size` and `--spawn` are refused) or the default `flat`; `mapOptions(map)` turns a map into `WorldServer` options. The client builds the plaza's meshes from the same `solids` (one merged mesh per surface) and collides with them. Worlds become files in S2.01; until then a map is code both ends import.

## Tests

`packages/sim/test/sim.test.ts`: speeds, the jump's height, walls, steps, edges, rounding; the plaza crossed by its steps and stairs; the check's verdicts on the plaza. The world server's `Stage 1` tests join the plaza and are corrected for floating 5 m up.

## Correct vs. Incorrect

**Incorrect:** a speed limit written into the server alone.
```ts
if (Math.hypot(dx, dz) > 8 * dt) correct();
```
**Correct:** the limit comes from the controller the client runs.
```ts
if (checkMove(player, next, dt, { ...DEFAULT_LIMITS, flying: map.flying }, map.solids) !== 'ok') correct();
```
**Why:** when running gets faster in `MOVE`, the check follows; two hand-kept numbers drift apart and honest players get corrected.
