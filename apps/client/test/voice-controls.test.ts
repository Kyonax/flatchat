// SPDX-License-Identifier: MPL-2.0
// Voice controls in the client (S3.08): a speaker's level follows the world's range and gain from
// its frames, this player's volume for that person and earmuffs; volumes are kept per account.
import { describe, expect, it } from 'vitest';
import { cleanSettings, cleanVolumes } from '../src/shared/settings';
import { EARMUFF_GAIN, speakerLevel, VOICE_RANGE_M, voiceGain } from '../src/renderer/src/voice/distance';

describe('a speaker’s level', () => {
  it('fades over the speaker’s own range, with the world’s gain and the player’s volume', () => {
    expect(speakerLevel(30, VOICE_RANGE_M, 1, 1, false)).toBe(0);
    // A stage carries 60 m: at 30 m it is still heard.
    expect(speakerLevel(30, 60, 1, 1, false)).toBeCloseTo(voiceGain(30, 60));
    expect(speakerLevel(30, 60, 1, 1, false)).toBeGreaterThan(0);
    expect(speakerLevel(5, VOICE_RANGE_M, 2, 1, false)).toBeCloseTo(2 * voiceGain(5));
    expect(speakerLevel(5, VOICE_RANGE_M, 1, 0.5, false)).toBeCloseTo(0.5 * voiceGain(5));
  });

  it('drops far voices to a murmur with earmuffs, and keeps near ones', () => {
    expect(speakerLevel(1, VOICE_RANGE_M, 1, 1, true)).toBe(1);
    expect(speakerLevel(10, VOICE_RANGE_M, 1, 1, true)).toBeCloseTo(EARMUFF_GAIN * voiceGain(10));
  });
});

describe('per-person volumes', () => {
  it('keep account ids with values 0 to 2, and drop the rest', () => {
    const id = '6b0e2c1a-7f3d-4e8a-9c21-5d4f3a2b1c0e';
    expect(cleanVolumes({ [id]: 1.5, 'not-an-id': 0.5, '0f8e2c1a-5b3d-4e6f-8a9b-1c2d3e4f5a6b': 9, 'c3a1f2e4-5b6d-4c7e-8f90-a1b2c3d4e5f6': 1 })).toEqual({ [id]: 1.5, '0f8e2c1a-5b3d-4e6f-8a9b-1c2d3e4f5a6b': 2 });
    expect(cleanSettings({ voice: { volumes: { [id]: 0 } } }).voice.volumes).toEqual({ [id]: 0 });
    expect(cleanSettings({}).keys.earmuffs).toEqual(['KeyN']);
  });
});
