// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's avatars. A VRM is loaded with three-vrm on three.js's WebGPU renderer (MToon as node
// materials) and then prepared about as the converter will prepare uploads (the plan's ASSETs AND
// CONVERSION), enough to measure a crowd before the converter exists:
// - textures fitted to a budget: every texture of the avatar scaled by one factor until the whole
//   set, as RGBA with mipmaps, fits. The plan's test avatar has at most 3 materials; as three
//   2,048 px KTX2 textures (BC7, one byte a pixel) with mipmaps that is about 16 MB, which RGBA
//   holds at half the edge, so 16 MB of RGBA stands for it;
// - MToon's outline pass dropped (the "low" preset) and one skeleton per avatar;
// - the lower level of detail simplified with meshoptimizer, without blend shapes;
// - the proxy: every part merged into one mesh of about 1,500 triangles, on the humanoid bones only
//   (the plan's impostor keeps about 20), in one flat colour, shared by every proxy of that avatar.
// trap-lint: allow T11 because spike S0.09 measures VRM avatars before the converter exists (Stage 4)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MToonMaterialLoaderPlugin, type VRM, VRMHumanBoneList, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import * as THREE from 'three/webgpu';
import { nearestKept, remapSkin } from './remap';
import type { WalkPose } from './walk';

let loader: GLTFLoader | undefined;

function vrmLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }) }));
  }
  return loader;
}

export interface AvatarFacts {
  triangles: number;
  materials: number;
  joints: number;
  morphTargets: number;
  /** Decoded texture bytes after the cap, RGBA with mipmaps. */
  textureBytes: number;
  springs: boolean;
}

/** Loads one VRM; it faces +z, with one skeleton and no outline pass. */
export async function loadAvatar(url: string): Promise<VRM> {
  const gltf = await vrmLoader().loadAsync(url);
  const vrm = gltf.userData['vrm'] as VRM | undefined;
  if (!vrm) throw new Error(`${url}: not a VRM`);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  shareTextures(vrm.scene);
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !Array.isArray(mesh.material)) return;
    // three-vrm draws MToon's outline as a second material over the same triangles.
    const surface = mesh.material.find((m) => !(m as { isOutline?: boolean }).isOutline);
    for (const m of mesh.material) if (m !== surface) m.dispose();
    if (surface) mesh.material = surface;
  });
  return vrm;
}

/**
 * One texture object per image and sampling: three-vrm gives each material slot its own copy, and
 * three.js's WebGPU renderer uploads every texture object on its own, so a VRoid avatar uploaded 68
 * to 72 textures from 28 images. Copies with the same image and the same settings are interchangeable.
 */
export function shareTextures(root: THREE.Object3D): void {
  const canonical = new Map<string, THREE.Texture>();
  const ids = new Map<unknown, number>();
  const keyOf = (t: THREE.Texture): string => {
    if (!ids.has(t.source)) ids.set(t.source, ids.size);
    t.updateMatrix();
    return [ids.get(t.source), t.colorSpace, t.wrapS, t.wrapT, t.magFilter, t.minFilter, t.anisotropy, t.flipY, t.generateMipmaps, t.channel, t.format, t.type, ...t.matrix.elements].join('|');
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const slots = m as unknown as Record<string, unknown>;
      for (const [slot, v] of Object.entries(slots)) {
        const texture = v as THREE.Texture | null;
        if (!texture?.isTexture) continue;
        const key = keyOf(texture);
        const kept = canonical.get(key);
        if (!kept) canonical.set(key, texture);
        else if (kept !== texture) slots[slot] = kept;
      }
    }
  });
}

export function texturesOf(root: THREE.Object3D): Set<THREE.Texture> {
  const out = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) out.add(v as THREE.Texture);
    }
  });
  return out;
}

/** RGBA8 with a full mip chain: 4 bytes a pixel, a third more for the mipmaps. */
export function textureBytes(width: number, height: number): number {
  return (width * height * 4 * 4) / 3;
}

/** Each image once: textures that share an image (three.js's Source) share it on the GPU too. */
function imagesOf(root: THREE.Object3D): Map<THREE.Texture['source'], THREE.Texture[]> {
  const out = new Map<THREE.Texture['source'], THREE.Texture[]>();
  for (const t of texturesOf(root)) {
    const list = out.get(t.source) ?? [];
    list.push(t);
    out.set(t.source, list);
  }
  return out;
}

/**
 * Scales every image by one factor until the set fits `budgetBytes` (0 keeps them). Resizing an
 * image costs the main thread several milliseconds, so with `pace` (wait for the next frame) it does
 * one image at a time, between frames.
 */
export async function fitTextures(root: THREE.Object3D, budgetBytes: number, pace?: () => Promise<void>): Promise<void> {
  if (budgetBytes <= 0) return;
  const images = [...imagesOf(root)].filter(([source]) => (source.data as ImageBitmap | undefined)?.width);
  const total = images.reduce((s, [source]) => s + textureBytes((source.data as ImageBitmap).width, (source.data as ImageBitmap).height), 0);
  if (total <= budgetBytes) return;
  const factor = Math.sqrt(budgetBytes / total);
  const fit = async ([source, textures]: [THREE.Texture['source'], THREE.Texture[]]): Promise<void> => {
      const image = source.data as ImageBitmap;
      const resized = await createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(image.width * factor)),
        resizeHeight: Math.max(1, Math.round(image.height * factor)),
        resizeQuality: 'high',
        // As GLTFLoader decodes them: straight alpha, no colour conversion.
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      source.data = resized;
      for (const texture of textures) texture.needsUpdate = true;
      image.close?.();
  };
  if (!pace) {
    await Promise.all(images.map(fit));
    return;
  }
  for (const image of images) {
    await pace();
    await fit(image);
  }
}

export function avatarFacts(vrm: VRM): AvatarFacts {
  let triangles = 0;
  let morphTargets = 0;
  const materials = new Set<THREE.Material>();
  const joints = new Set<THREE.Object3D>();
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    morphTargets = Math.max(morphTargets, g.morphAttributes['position']?.length ?? 0);
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
    for (const b of mesh.skeleton?.bones ?? []) joints.add(b);
  });
  let bytes = 0;
  for (const source of imagesOf(vrm.scene).keys()) {
    const image = source.data as { width?: number; height?: number } | undefined;
    bytes += textureBytes(image?.width ?? 0, image?.height ?? 0);
  }
  return { triangles: Math.round(triangles), materials: materials.size, joints: joints.size, morphTargets, textureBytes: Math.round(bytes), springs: (vrm.springBoneManager?.joints.size ?? 0) > 0 };
}

function positionsOf(geometry: THREE.BufferGeometry): Float32Array {
  const attr = geometry.getAttribute('position');
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return out;
}

type AlphaGroup = 'opaque' | 'cutout' | 'blend';

function alphaGroup(m: THREE.Material): AlphaGroup {
  if (m.transparent) return 'blend';
  return m.alphaTest > 0 ? 'cutout' : 'opaque';
}

/** The texture slots a merged material drops: the atlas replaces the colour, the rest are not kept. */
const DROPPED_SLOTS = ['normalMap', 'emissiveMap', 'shadingShiftTexture', 'matcapTexture', 'rimMultiplyTexture', 'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture'];

/**
 * The converter's material merge, emulated so the bench measures the plan's test avatar (at most 3
 * materials) from avatars exported with 15 to 17: the parts that share the skeleton are grouped by
 * how they blend (opaque, cut-out, blended), and each group becomes one mesh with one material whose
 * colour is an atlas of its parts' textures, each part's UVs moved into its own cell. Blend shapes
 * are dropped, and with them the expressions (the mouth shapes are a handful on the face, not
 * measured here). Returns the number of meshes it made.
 */
export async function mergeAvatar(vrm: VRM, atlasEdge: number, pace?: () => Promise<void>): Promise<number> {
  const meshes: THREE.SkinnedMesh[] = [];
  vrm.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  const first = meshes[0];
  if (!first) return 0;
  const parts = meshes.filter((m) => m.skeleton === first.skeleton && m.bindMatrix.equals(first.bindMatrix) && !Array.isArray(m.material));
  const groups = new Map<AlphaGroup, THREE.SkinnedMesh[]>();
  for (const m of parts) {
    const g = alphaGroup(m.material as THREE.Material);
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  const before = texturesOf(vrm.scene);
  let made = 0;
  for (const list of groups.values()) {
    if (pace) await pace();
    type Toon = THREE.Material & { map?: THREE.Texture | null; shadeMultiplyTexture?: THREE.Texture | null };
    const materials = [...new Set(list.map((m) => m.material as Toon))];
    const n = Math.ceil(Math.sqrt(materials.length));
    const cell = Math.floor(atlasEdge / n);
    const canvas = new OffscreenCanvas(atlasEdge, atlasEdge);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas for the atlas');
    ctx.fillStyle = '#ffffff';
    for (const [i, material] of materials.entries()) {
      // Scaling a large image costs the main thread milliseconds: one a frame when paced.
      if (pace && i > 0) await pace();
      const x = (i % n) * cell;
      const y = Math.floor(i / n) * cell;
      const image = material.map?.image as ImageBitmap | undefined;
      if (image?.width) ctx.drawImage(image, x, y, cell, cell);
      else ctx.fillRect(x, y, cell, cell);
    }
    const atlas = new THREE.Texture(canvas.transferToImageBitmap());
    atlas.flipY = false;
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.needsUpdate = true;

    // One geometry: positions, normals, skins, and UVs moved into each material's cell (half a texel in).
    // Typed arrays sized up front: growing JavaScript arrays here left tens of MB for the garbage collector.
    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of list) {
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      vertexCount += count;
      indexCount += mesh.geometry.index ? mesh.geometry.index.count : count;
    }
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const skinIndex = new Uint16Array(vertexCount * 4);
    const skinWeight = new Float32Array(vertexCount * 4);
    const indices = new Uint32Array(indexCount);
    const inset = 0.5 / atlasEdge;
    let base = 0;
    let at = 0;
    for (const mesh of list) {
      const g = mesh.geometry;
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      const uv = g.getAttribute('uv');
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      if (!pos || !si || !sw) continue;
      const k = materials.indexOf(mesh.material as Toon);
      const cx = ((k % n) * cell) / atlasEdge;
      const cy = (Math.floor(k / n) * cell) / atlasEdge;
      const size = cell / atlasEdge - 2 * inset;
      for (let v = 0; v < pos.count; v++) {
        const o = base + v;
        positions[o * 3] = pos.getX(v);
        positions[o * 3 + 1] = pos.getY(v);
        positions[o * 3 + 2] = pos.getZ(v);
        normals[o * 3] = nor ? nor.getX(v) : 0;
        normals[o * 3 + 1] = nor ? nor.getY(v) : 1;
        normals[o * 3 + 2] = nor ? nor.getZ(v) : 0;
        uvs[o * 2] = cx + inset + (uv ? Math.min(1, Math.max(0, uv.getX(v))) : 0.5) * size;
        uvs[o * 2 + 1] = cy + inset + (uv ? Math.min(1, Math.max(0, uv.getY(v))) : 0.5) * size;
        for (let c = 0; c < 4; c++) {
          skinIndex[o * 4 + c] = si.getComponent(v, c);
          skinWeight[o * 4 + c] = sw.getComponent(v, c);
        }
      }
      const index = g.index;
      if (index) for (let i = 0; i < index.count; i++) indices[at++] = base + index.getX(i);
      else for (let i = 0; i < pos.count; i++) indices[at++] = base + i;
      base += pos.count;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, base * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, base * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.subarray(0, base * 2), 2));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex.subarray(0, base * 4), 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight.subarray(0, base * 4), 4));
    geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, at), 1));
    geometry.computeBoundingSphere();

    const material = materials[0]!.clone() as Toon;
    const slots = material as unknown as Record<string, unknown>;
    material.map = atlas;
    if (material.shadeMultiplyTexture) material.shadeMultiplyTexture = atlas;
    for (const slot of DROPPED_SLOTS) if (slot in slots) slots[slot] = null;
    const merged = new THREE.SkinnedMesh(geometry, material);
    merged.bind(first.skeleton, first.bindMatrix);
    (first.parent ?? vrm.scene).add(merged);
    for (const mesh of list) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    for (const m of materials) m.dispose();
    made += 1;
  }
  // The old textures are no longer drawn: let their images go.
  const kept = texturesOf(vrm.scene);
  for (const t of before) {
    if (kept.has(t)) continue;
    t.dispose();
    (t.image as ImageBitmap | undefined)?.close?.();
  }
  vrm.scene.userData['merged'] = true;
  return made;
}

/** The lower level of detail: each part simplified to `ratio` of its triangles, blend shapes dropped. */
export async function simplifyAvatar(vrm: VRM, ratio: number): Promise<void> {
  await MeshoptSimplifier.ready;
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.index) return;
    const g = mesh.geometry;
    const indices = Uint32Array.from(g.index!.array as ArrayLike<number>);
    const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
    const [simplified] = MeshoptSimplifier.simplify(indices, positionsOf(g), 3, target, 0.02, ['Prune']);
    g.setIndex(new THREE.BufferAttribute(simplified, 1));
    g.morphAttributes = {};
    mesh.morphTargetInfluences = undefined;
    mesh.morphTargetDictionary = undefined;
  });
}

export interface ProxyTemplate {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** The kept humanoid bones, by name, in skeleton order. */
  names: string[];
  /** Each kept bone's parent among the kept bones; −1 for a root. */
  parent: Int32Array;
  restPosition: THREE.Vector3[];
  restQuaternion: THREE.Quaternion[];
  /** Each kept bone's parent's world rotation at rest: turns a normalized rotation into this bone's. */
  parentWorld: THREE.Quaternion[];
  inverses: THREE.Matrix4[];
  triangles: number;
}

/** Builds the proxy of a freshly loaded VRM (before any other preparation changes it). */
export async function buildProxy(vrm: VRM, color: THREE.ColorRepresentation, targetTriangles = 1500): Promise<ProxyTemplate> {
  await MeshoptSimplifier.ready;
  vrm.scene.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(vrm.scene.matrixWorld).invert();
  const meshes: THREE.SkinnedMesh[] = [];
  vrm.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });

  // The kept bones: every humanoid bone the avatar has.
  const kept: Array<{ name: string; node: THREE.Object3D }> = [];
  for (const name of VRMHumanBoneList) {
    const node = vrm.humanoid.getRawBoneNode(name);
    if (node) kept.push({ name, node });
  }
  // Every joint any part is skinned to, then the kept bones, with each one's nearest listed ancestor.
  const all: THREE.Object3D[] = [];
  const at = new Map<THREE.Object3D, number>();
  const add = (o: THREE.Object3D): void => {
    if (!at.has(o)) {
      at.set(o, all.length);
      all.push(o);
    }
  };
  for (const m of meshes) for (const b of m.skeleton.bones) add(b);
  for (const k of kept) add(k.node);
  const parents = all.map((o) => {
    for (let p = o.parent; p; p = p.parent) {
      const i = at.get(p);
      if (i !== undefined) return i;
    }
    return -1;
  });
  const keptAt = kept.map((k) => at.get(k.node)!);
  const map = nearestKept(parents, keptAt);

  // One geometry in the avatar's own space: positions, normals, and skins on the kept bones.
  const positions: number[] = [];
  const normals: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const indices: number[] = [];
  const toRoot = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) continue;
    toRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
    normalMatrix.getNormalMatrix(toRoot);
    const base = positions.length / 3;
    const boneAt = mesh.skeleton.bones.map((b) => at.get(b) ?? -1);
    const meshIndex: number[] = [];
    const meshWeight: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      positions.push(v.x, v.y, v.z);
      if (nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        normals.push(v.x, v.y, v.z);
      } else {
        normals.push(0, 1, 0);
      }
      for (let k = 0; k < 4; k++) {
        meshIndex.push(boneAt[si.getComponent(i, k)] ?? -1);
        meshWeight.push(sw.getComponent(i, k));
      }
    }
    // A joint outside the list carries no weight.
    const remapped = remapSkin(
      meshIndex.map((j) => (j < 0 ? 0 : j)),
      meshWeight.map((w, n) => ((meshIndex[n] ?? -1) < 0 ? 0 : w)),
      map,
    );
    for (const j of remapped.index) skinIndex.push(j);
    for (const w of remapped.weight) skinWeight.push(w);
    const index = g.index;
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  }

  // Down to about `targetTriangles`; hair cards and loose parts stop the careful simplifier early,
  // so the sloppy one finishes the job.
  const flat = new Float32Array(positions);
  let simplified = MeshoptSimplifier.simplify(Uint32Array.from(indices), flat, 3, targetTriangles * 3, 0.05, ['Prune'])[0];
  if (simplified.length > targetTriangles * 3 * 1.5) simplified = MeshoptSimplifier.simplifySloppy(simplified, flat, 3, null, targetTriangles * 3, 0.1)[0];

  // Keep only the vertices the simplified triangles use.
  const remap = new Map<number, number>();
  const outIndex = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) {
    const old = simplified[i]!;
    let n = remap.get(old);
    if (n === undefined) {
      n = remap.size;
      remap.set(old, n);
    }
    outIndex[i] = n;
  }
  const count = remap.size;
  const p = new Float32Array(count * 3);
  const nn = new Float32Array(count * 3);
  const sIdx = new Uint16Array(count * 4);
  const sW = new Float32Array(count * 4);
  for (const [old, n] of remap) {
    for (let k = 0; k < 3; k++) {
      p[n * 3 + k] = positions[old * 3 + k]!;
      nn[n * 3 + k] = normals[old * 3 + k]!;
    }
    for (let k = 0; k < 4; k++) {
      sIdx[n * 4 + k] = skinIndex[old * 4 + k]!;
      sW[n * 4 + k] = skinWeight[old * 4 + k]!;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sW, 4));
  geometry.setIndex(new THREE.BufferAttribute(outIndex, 1));
  geometry.computeBoundingSphere();

  // The kept bones' rest transforms, each relative to its nearest kept ancestor.
  const world = kept.map((k) => new THREE.Matrix4().multiplyMatrices(rootInv, k.node.matrixWorld));
  const parentOfKept = new Int32Array(kept.length).fill(-1);
  kept.forEach((k, i) => {
    for (let q = k.node.parent; q; q = q.parent) {
      const j = kept.findIndex((x) => x.node === q);
      if (j >= 0) {
        parentOfKept[i] = j;
        break;
      }
    }
  });
  const restPosition: THREE.Vector3[] = [];
  const restQuaternion: THREE.Quaternion[] = [];
  const parentWorld: THREE.Quaternion[] = [];
  const scale = new THREE.Vector3();
  kept.forEach((_, i) => {
    const parentIndex = parentOfKept[i]!;
    const parentMatrix = parentIndex >= 0 ? world[parentIndex]! : new THREE.Matrix4();
    const local = new THREE.Matrix4().copy(parentMatrix).invert().multiply(world[i]!);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    local.decompose(position, rotation, scale);
    restPosition.push(position);
    restQuaternion.push(rotation);
    const pw = new THREE.Quaternion();
    parentMatrix.decompose(new THREE.Vector3(), pw, scale);
    parentWorld.push(pw);
  });
  return {
    geometry,
    material: new THREE.MeshLambertNodeMaterial({ color }),
    names: kept.map((k) => k.name),
    parent: parentOfKept,
    restPosition,
    restQuaternion,
    parentWorld,
    inverses: world.map((m) => m.clone().invert()),
    triangles: outIndex.length / 3,
  };
}

const euler = new THREE.Euler();
const qn = new THREE.Quaternion();
const qInv = new THREE.Quaternion();

/** One proxy: the template's mesh on its own small skeleton. */
export class Proxy {
  readonly object = new THREE.Group();
  private readonly template: ProxyTemplate;
  private readonly bones: THREE.Bone[];

  constructor(template: ProxyTemplate) {
    this.template = template;
    this.bones = template.names.map((name, i) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.copy(template.restPosition[i]!);
      b.quaternion.copy(template.restQuaternion[i]!);
      return b;
    });
    const mesh = new THREE.SkinnedMesh(template.geometry, template.material);
    this.bones.forEach((b, i) => {
      const parent = template.parent[i]!;
      if (parent >= 0) this.bones[parent]!.add(b);
      else mesh.add(b);
    });
    mesh.bind(new THREE.Skeleton(this.bones, template.inverses), new THREE.Matrix4());
    this.object.add(mesh);
  }

  get triangles(): number {
    return this.template.triangles;
  }

  /** The walk, on raw bones: rotation = parent⁻¹ · normalized · parent · rest, as three-vrm's rig does. */
  pose(p: WalkPose): void {
    const t = this.template;
    this.bones.forEach((b, i) => {
      const angles = p.bones[t.names[i]!];
      if (!angles) {
        b.quaternion.copy(t.restQuaternion[i]!);
        return;
      }
      qn.setFromEuler(euler.set(angles[0], angles[1], angles[2]));
      const pw = t.parentWorld[i]!;
      qInv.copy(pw).invert();
      b.quaternion.copy(qInv).multiply(qn).multiply(pw).multiply(t.restQuaternion[i]!);
    });
  }
}

/**
 * A full or lower-detail avatar's walk, through three-vrm's normalized rig. A VRM 0.x rig was built
 * facing −z, before rotateVRM0 turned the avatar round, so its rotations about x and z flip (as
 * three-vrm's own VRMA player does).
 */
export function poseAvatar(vrm: VRM, p: WalkPose): void {
  const flip = vrm.meta?.metaVersion === '0' ? -1 : 1;
  for (const [name, angles] of Object.entries(p.bones)) {
    vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.rotation.set(angles[0] * flip, angles[1], angles[2] * flip);
  }
  vrm.humanoid.update();
}
