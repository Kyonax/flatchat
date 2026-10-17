// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { advance, BODY, type Box, checkMove, DEFAULT_LIMITS, flatWorld, JUMP_APEX, MOVE, type MoveInput, type MoveState, PLAZA, standing, wishVelocity } from '../src/index.ts';

const idle: MoveInput = { forward: 0, right: 0, run: false, jump: false, yaw: 0 };
const flat = flatWorld(128).solids;

function run(s: MoveState, input: MoveInput, seconds: number, boxes: readonly Box[] = flat): MoveState {
  let state = s;
  for (let t = 0; t < seconds; t += 1 / 60) state = advance(state, input, 1 / 60, boxes);
  return state;
}

describe('the controller', () => {
  it('faces -z at yaw 0 and turns left as yaw grows', () => {
    const f = wishVelocity({ ...idle, forward: 1 });
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-MOVE.walk);
    const left = wishVelocity({ ...idle, forward: 1, yaw: Math.PI / 2 });
    expect(left.x).toBeCloseTo(-MOVE.walk);
    expect(left.z).toBeCloseTo(0);
    const right = wishVelocity({ ...idle, right: 1 });
    expect(right.x).toBeCloseTo(MOVE.walk);
    // Diagonals are not faster.
    const diag = wishVelocity({ ...idle, forward: 1, right: 1, run: true });
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(MOVE.run);
  });

  it('walks and runs at their speeds on flat ground, and stays on it', () => {
    const walked = run(standing(64, 0, 64), { ...idle, forward: 1 }, 2);
    expect(64 - walked.z).toBeGreaterThan(MOVE.walk * 2 - 0.5);
    expect(64 - walked.z).toBeLessThan(MOVE.walk * 2 + 0.01);
    expect(walked.y).toBe(0);
    expect(walked.grounded).toBe(true);
    const ran = run(standing(64, 0, 64), { ...idle, forward: 1, run: true }, 2);
    expect(64 - ran.z).toBeGreaterThan(MOVE.run * 2 - 0.5);
  });

  it('jumps as high as JUMP_APEX and lands again', () => {
    let s = standing(64, 0, 64);
    let peak = 0;
    s = advance(s, { ...idle, jump: true }, 1 / 60, flat);
    for (let i = 0; i < 120; i++) {
      s = advance(s, idle, 1 / 60, flat);
      peak = Math.max(peak, s.y);
    }
    expect(JUMP_APEX).toBeCloseTo(0.901, 2);
    expect(peak).toBeGreaterThan(JUMP_APEX - 0.06);
    expect(peak).toBeLessThanOrEqual(JUMP_APEX + 1e-9);
    expect(s.y).toBe(0);
    expect(s.grounded).toBe(true);
  });

  it('stops at a wall, steps up a low ledge, and cannot walk up a high one', () => {
    const wall: Box = { min: { x: 60, y: 0, z: 60 }, max: { x: 68, y: 3, z: 61 } };
    const stopped = run(standing(64, 0, 64), { ...idle, forward: 1 }, 2, [...flat, wall]);
    expect(stopped.z).toBeCloseTo(61 + BODY.radius, 2);
    const ledge: Box = { min: { x: 60, y: 0, z: 58 }, max: { x: 68, y: 0.3, z: 61 } };
    const up = run(standing(64, 0, 64), { ...idle, forward: 1 }, 1.5, [...flat, ledge]);
    expect(up.y).toBeCloseTo(0.3);
    const high: Box = { min: { x: 60, y: 0, z: 58 }, max: { x: 68, y: 0.6, z: 61 } };
    expect(run(standing(64, 0, 64), { ...idle, forward: 1 }, 1.5, [...flat, high]).y).toBe(0);
  });

  it('stands on a floor it arrives slightly inside, as the protocol rounds heights', () => {
    const floor: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 128, y: 0.15, z: 128 } };
    const s = run(standing(64, Math.round(0.15 * 128) / 128, 64), idle, 1, [...flat, floor]);
    expect(s.y).toBe(0.15);
    expect(s.grounded).toBe(true);
  });

  it('falls off an edge and lands below', () => {
    const block: Box = { min: { x: 60, y: 0, z: 60 }, max: { x: 68, y: 2, z: 68 } };
    const s = run(standing(64, 2, 64), { ...idle, forward: 1 }, 2, [...flat, block]);
    expect(s.z).toBeLessThan(60);
    expect(s.y).toBe(0);
  });
});

describe('the plaza', () => {
  it('can be crossed from the spawn to the stage by its steps, and the high platforms by their stairs', () => {
    const { y, z } = PLAZA.spawn;
    // Walk north to the stage, past the fountain's west side: up two steps and onto it.
    const atStage = run(standing(59.5, y, z), { ...idle, forward: 1 }, 8, PLAZA.solids);
    expect(atStage.y).toBeCloseTo(0.15 + 0.9, 5);
    // Walk up the west high platform's stairs (they climb toward +z from z = C + 10.4).
    const start = standing(62 - 20 + 2, 0.15, 64 + 9);
    const onTop = run(start, { ...idle, forward: -1 }, 2.2, PLAZA.solids);
    expect(onTop.y).toBeCloseTo(0.15 + 1.8, 5);
  });

  it('is enclosed: walking far never leaves the world', () => {
    const s = run(standing(64, 0.15, 64), { ...idle, right: 1, run: true }, 20, PLAZA.solids);
    expect(s.x).toBeLessThan(PLAZA.size - 1);
  });
});

describe('the server check', () => {
  const at = (x: number, y: number, z: number) => ({ x, y, z });

  it('accepts running and falling, refuses teleports and flying', () => {
    expect(checkMove(at(64, 0, 64), at(64, 0, 64 - MOVE.run * 0.05), 0.05, DEFAULT_LIMITS, flat)).toBe('ok');
    expect(checkMove(at(64, 0, 64), at(64, 0, 54), 0.05, DEFAULT_LIMITS, flat)).toBe('too-fast');
    expect(checkMove(at(64, 0, 64), at(64, 0.8, 64), 0.05, DEFAULT_LIMITS, flat)).toBe('ok');
    expect(checkMove(at(64, 1, 64), at(64, 6, 64), 0.05, DEFAULT_LIMITS, flat)).toBe('too-high');
    expect(checkMove(at(64, 6, 64), at(64, 5.5, 64), 0.05, DEFAULT_LIMITS, flat)).toBe('ok');
    expect(checkMove(at(64, 1, 64), at(64, 6, 64), 0.05, { ...DEFAULT_LIMITS, flying: true }, flat)).toBe('ok');
  });

  it('lets a player stand and jump on a high platform', () => {
    // On top of the west high platform (top 1.95): jumping from it reaches about 2.85.
    expect(checkMove(at(40, 1.95, 66), at(40, 2.8, 66), 0.05, DEFAULT_LIMITS, PLAZA.solids)).toBe('ok');
    expect(checkMove(at(40, 1.95, 30), at(40, 2.8, 30), 0.05, DEFAULT_LIMITS, PLAZA.solids)).toBe('too-high');
  });
});
