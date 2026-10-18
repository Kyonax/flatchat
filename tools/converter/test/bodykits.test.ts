// SPDX-License-Identifier: MPL-2.0
// The three standard bodies (Track P's P.03) as the repository holds them: each kit's VRM is the
// one kits/bodies/kits.json records (its SHA-256), and it converts as the generator's run said:
// a humanoid, LOD0 within 30,000 triangles and 70 bones, all 18 expressions, no warning, the same
// rank. Making them takes Blender (tools/blender/bodykit/run.mts); checking them does not.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertAvatar } from '../src/avatar/convert.ts';

const KITS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'bodies');
const record = JSON.parse(readFileSync(join(KITS, 'kits.json'), 'utf8')) as {
  kits: Record<string, { vrm: string; vrmSha256: string; bones: number; expressions: string[]; converter: { rank: string } }>;
};

describe('the body kits', () => {
  it('are three, as their record says', () => {
    expect(Object.keys(record.kits).sort()).toEqual(['feminine', 'masculine', 'neutral']);
  });

  for (const [name, kit] of Object.entries(record.kits)) {
    it(`${name}: is the recorded file and converts within P.03's limits`, async () => {
      const bytes = new Uint8Array(readFileSync(join(KITS, name, kit.vrm)));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(kit.vrmSha256);
      const m = (await convertAvatar(bytes, { ktx2: false })).manifest;
      expect(m.shape).toBe('humanoid');
      expect(m.levels.lod0.triangles).toBeLessThanOrEqual(30_000);
      expect(m.levels.lod0.bones).toBeLessThanOrEqual(70);
      expect(m.expressions).toHaveLength(18);
      expect(m.warnings).toEqual([]);
      expect(m.rank).toBe(kit.converter.rank);
    }, 60_000);
  }
});
