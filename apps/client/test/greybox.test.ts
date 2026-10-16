// SPDX-License-Identifier: MPL-2.0
// The scene graph builds without a GPU: three's scene objects work in plain Node.
import { describe, expect, it } from 'vitest';
import { animate, buildGreybox } from '../src/renderer/src/greybox';

describe('buildGreybox', () => {
  it('holds two lights, the grid and the block', () => {
    const box = buildGreybox();
    const types = box.scene.children.map((c) => c.type);
    expect(types).toEqual(['HemisphereLight', 'DirectionalLight', 'GridHelper', 'Mesh']);
    expect(box.block.position.y).toBe(0.5);
    expect(box.camera.aspect).toBeCloseTo(16 / 9);
  });

  it('turns the block with time', () => {
    const box = buildGreybox();
    animate(box, 1500);
    expect(box.block.rotation.y).toBeCloseTo(1.5);
  });
});
