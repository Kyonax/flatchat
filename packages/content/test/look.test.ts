// SPDX-License-Identifier: Apache-2.0
// A world's look (S6.05): [look] in world.toml read with its defaults and its ranges, unknown keys
// warned about, and kept in the built world, where a host's world.json is read again.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, parseBuiltWorld, parseManifest, readLook } from '../src/index.ts';

const TOML = `format = 1
name = "Neon Dock"
[[scenes]]
id = "main"
file = "scenes/main.glb"
`;
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'converter', 'test', 'golden', 'plaza.world.json');

describe("a world's look", () => {
  it('keeps the look every world had when the world gives none', () => {
    const { manifest, problems } = parseManifest(TOML);
    expect(problems).toEqual([]);
    expect(manifest!.look).toBeUndefined();
    expect(readLook(undefined).look).toEqual(DEFAULT_LOOK);
  });

  it('reads a full [look], its screen effects only where given', () => {
    const { manifest, problems } = parseManifest(`${TOML}
[look]
sky = "#10131A"
fog = { colour = "#20242e", near = 10, far = 80 }
sun = { colour = "#ffd9a8", intensity = 2.5, direction = [-0.5, 0.8, 0.2] }
ambient = { sky = "#334455", ground = "#111111", intensity = 0.8 }
bloom = { strength = 1.2, threshold = 0.6 }
filters = { crt = 0.5, grain = 0.2, saturation = 1.2, tint = "#E0F0FF" }
`);
    expect(problems).toEqual([]);
    const look = manifest!.look!;
    expect(look.sky).toBe('#10131a');
    expect(look.fog).toEqual({ colour: '#20242e', near: 10, far: 80 });
    expect(look.sun).toEqual({ colour: '#ffd9a8', intensity: 2.5, direction: [-0.5, 0.8, 0.2] });
    expect(look.bloom).toEqual({ strength: 1.2, threshold: 0.6, radius: 0.4 });
    expect(look.shafts).toBeNull();
    expect(look.reflections).toBeNull();
    expect(look.filters).toMatchObject({ crt: 0.5, grain: 0.2, vignette: 0, saturation: 1.2, contrast: 1, tint: '#e0f0ff' });
  });

  it('turns the fog off, and refuses what is out of range, warning of unknown keys', () => {
    expect(parseManifest(`${TOML}\n[look]\nfog = false\n`).manifest!.look!.fog).toBeNull();
    const { problems } = parseManifest(`${TOML}
[look]
sky = "blue"
glow = 3
fog = { near = 50, far = 20 }
sun = { direction = [0, 0, 0] }
bloom = { strength = 9, sparkle = true }
`);
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.at)).toEqual(['look.sky', 'look.fog', 'look.sun.direction', 'look.bloom.strength']);
    expect(problems.filter((p) => p.severity === 'warning').map((p) => p.at)).toEqual(['look.glow', 'look.bloom.sparkle']);
  });

  it("is kept in the built world, and a host's look is read again", () => {
    const w = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { manifest: Record<string, unknown> };
    w.manifest['look'] = { ...DEFAULT_LOOK, bloom: { strength: 1, threshold: 0.7, radius: 0.3 } };
    const r = parseBuiltWorld(w);
    expect('world' in r && r.world.manifest.look?.bloom).toEqual({ strength: 1, threshold: 0.7, radius: 0.3 });
    w.manifest['look'] = { ...DEFAULT_LOOK, sky: 'url(javascript:alert(1))' };
    expect(parseBuiltWorld(w)).toEqual({ error: expect.stringMatching(/manifest\.look\.sky/) });
  });
});
