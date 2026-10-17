# Sim

FlatChat's movement rules: the character controller the client runs every frame to move its own avatar, and the checks the world server makes on the poses clients send (sf-004). Pure TypeScript with no engine, so both ends compute the same thing.

- Licence: Apache-2.0 ([LICENSE](LICENSE))
- Status: Stage 1. Walking, running, jumping, falling and steps among boxes; the speed and height checks; the greybox plaza both ends share until worlds become files (S2.01). The full movement set (slopes, seats, flying, click to move) moves to Rapier in Stage 2.

| File | What |
|---|---|
| `src/movement.ts` | `BODY`, `MOVE`, `JUMP_APEX`; `step` and `advance` (sub-steps of at most 1/60 s) |
| `src/check.ts` | `checkMove`: too fast, or rising above a jump's reach where flying is off |
| `src/plaza.ts` | `PLAZA`, the first world, as boxes with a surface each; `flatWorld(size)` for load tests |

Axes: y is up; a yaw of 0 faces -z and grows turning left, as three.js cameras do.
