// SPDX-License-Identifier: MPL-2.0
// A world's look in the client (S6.05, Q-E6): its sky, fog and light (applyLook), and its screen
// effects drawn by a three.js render pipeline (LookPipeline): reflections on glossy surfaces (SSR),
// light shafts from the sun (godrays, which need the sun's shadows), bloom and neon glow, and the
// screen filters (colour grading, a CRT's curve, scanlines and colour bleed, film grain, a vignette).
// Each runs only when the world asks for it and the viewer allows it (settings.look, T-14: on until
// switched off); none in safe mode. Without a screen effect there is no pipeline: the scene is drawn
// as before. Effekseer's effects draw after it, over the picture, with the scene pass's depth.
import type { WorldLook } from '@flatchat/content';
import { barrelUV, colorBleeding, scanlines, vignette } from 'three/addons/tsl/display/CRT.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import * as T from 'three/tsl';
import * as THREE from 'three/webgpu';

/** Which screen effects the viewer allows (the settings' `look`). */
export interface LookAllowed {
  bloom: boolean;
  shafts: boolean;
  reflections: boolean;
  filters: boolean;
}

const colour = (hex: string): THREE.Color => new THREE.Color(hex);

/** The world's sky, fog and light on a scene built by buildWorldScene (its hemisphere and its sun). */
export function applyLook(scene: THREE.Scene, look: WorldLook, worldSize: number): { sun: THREE.DirectionalLight | undefined } {
  scene.background = colour(look.sky);
  scene.fog = look.fog ? new THREE.Fog(colour(look.fog.colour), look.fog.near, look.fog.far > 0 ? look.fog.far : Math.max(look.fog.near + 1, worldSize * 0.9)) : null;
  let sun: THREE.DirectionalLight | undefined;
  scene.traverse((o) => {
    if ((o as THREE.HemisphereLight).isHemisphereLight) {
      const h = o as THREE.HemisphereLight;
      h.color.copy(colour(look.ambient.sky));
      h.groundColor.copy(colour(look.ambient.ground));
      h.intensity = look.ambient.intensity;
    } else if ((o as THREE.DirectionalLight).isDirectionalLight && !sun) {
      sun = o as THREE.DirectionalLight;
      sun.color.copy(colour(look.sun.colour));
      sun.intensity = look.sun.intensity;
      sun.position.set(...look.sun.direction).normalize().multiplyScalar(50);
    }
  });
  return { sun };
}

/** The effects a world's look asks for and the viewer allows; none in safe mode. */
export function lookEffects(look: WorldLook, allowed: LookAllowed, safeMode: boolean): { bloom: boolean; shafts: boolean; reflections: boolean; filters: boolean } {
  if (safeMode) return { bloom: false, shafts: false, reflections: false, filters: false };
  return { bloom: !!look.bloom && allowed.bloom, shafts: !!look.shafts && allowed.shafts, reflections: !!look.reflections && allowed.reflections, filters: !!look.filters && allowed.filters };
}

type N = ReturnType<typeof T.vec4>;

/** The screen effects as one render pipeline; `render()` draws the frame, `depth()` is the scene
 *  pass's depth for whatever draws after it (the Effekseer layer). */
export class LookPipeline {
  readonly on: ReturnType<typeof lookEffects>;
  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: THREE.PassNode;
  private readonly shadowed: THREE.Object3D[] = [];
  private readonly renderer: THREE.WebGPURenderer;
  private readonly sun: THREE.DirectionalLight | undefined;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, look: WorldLook, on: ReturnType<typeof lookEffects>, sun: THREE.DirectionalLight | undefined) {
    this.renderer = renderer;
    this.on = on;
    this.sun = sun;
    const scenePass = T.pass(scene, camera);
    this.scenePass = scenePass;
    if (on.reflections) scenePass.setMRT(T.mrt({ output: T.output, normal: T.normalView, metalrough: T.vec2(T.metalness, T.roughness) }));
    let out = scenePass.getTextureNode('output') as unknown as N;
    const depth = scenePass.getTextureNode('depth');
    if (on.reflections && look.reflections) {
      const metalrough = scenePass.getTextureNode('metalrough');
      const normal = scenePass.getTextureNode('normal') as unknown as Parameters<typeof ssr>[2];
      const r = ssr(out, depth, normal, { metalnessNode: metalrough.r, roughnessNode: metalrough.g, camera }) as unknown as N;
      out = T.vec4(T.mix(out.rgb, r.rgb, r.a.mul(look.reflections.strength).min(1)), out.a) as unknown as N;
    }
    if (on.shafts && look.shafts && sun) {
      // The light shafts need the sun's shadows, on everything in the world.
      renderer.shadowMap.enabled = true;
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !mesh.castShadow) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.shadowed.push(mesh);
        }
      });
      const rays = godrays(depth, camera, sun) as unknown as N;
      out = T.vec4(out.rgb.add(rays.rgb.mul(look.shafts.strength)), out.a) as unknown as N;
    }
    if (on.bloom && look.bloom) out = T.vec4(out.rgb.add((bloom(out, look.bloom.strength, look.bloom.radius, look.bloom.threshold) as unknown as N).rgb), out.a) as unknown as N;
    if (on.filters && look.filters) {
      const f = look.filters;
      let c = out.rgb;
      // Colour grading: exposure, saturation (around the luminance), contrast (around grey), a tint.
      c = c.mul(f.exposure);
      c = T.mix(T.vec3(T.luminance(c)), c, f.saturation);
      c = c.sub(0.5).mul(f.contrast).add(0.5).max(0);
      c = c.mul(T.color(f.tint));
      if (f.crt > 0) {
        c = colorBleeding(c, T.float(f.crt * 0.004)) as unknown as typeof c;
        c = scanlines(c, T.float(f.crt * 0.4), T.float(480), T.float(0), barrelUV(T.float(f.crt * 0.12))) as unknown as typeof c;
      }
      if (f.vignette > 0) c = vignette(c, T.float(f.vignette), T.float(0.5)) as unknown as typeof c;
      out = T.vec4(c, out.a) as unknown as N;
      if (f.grain > 0) out = film(out, T.float(f.grain)) as unknown as N;
    }
    this.pipeline = new THREE.RenderPipeline(renderer, out);
  }

  render(): void {
    this.pipeline.render();
  }

  /** The scene pass's depth texture, for the effects drawn after the pipeline. */
  depth(): THREE.Texture | undefined {
    return (this.scenePass as unknown as { renderTarget?: { depthTexture?: THREE.Texture } }).renderTarget?.depthTexture ?? undefined;
  }

  dispose(): void {
    for (const o of this.shadowed) {
      (o as THREE.Mesh).castShadow = false;
      (o as THREE.Mesh).receiveShadow = false;
    }
    if (this.sun) this.sun.castShadow = false;
    this.renderer.shadowMap.enabled = false;
    this.pipeline.dispose();
    this.scenePass.dispose();
  }
}
