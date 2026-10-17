// SPDX-License-Identifier: MPL-2.0
// Reference avatars made in code (S4.02's golden set): one humanoid, 1.75 m, in T-pose, written the
// three ways the converter takes, standing in for three creation tools: VRM 1.0 (as VRoid Studio
// 1.x writes it: facing +Z), VRM 0.x (as UniVRM 0.x and Blender's VRM exporter write it: facing
// -Z, blend shapes on meshes, MToon in materialProperties) and a plain GLB with Mixamo's bone
// names and Ready Player Me's shape names. Each body part is a box divided into a grid, so the
// levels of detail have something to take away; the head carries the mouth and blink shapes, a
// three-bone hair chain swings on spring bones around a head collider, and a 64 px checker is the
// texture. Nothing here comes from outside the repository.
import { Document, Format, GLB_BUFFER, type Material, type Mesh, type Node, NodeIO, type Primitive, type Texture } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import { VRMExtension } from './vrm.ts';

export type SampleKind = 'vrm1' | 'vrm0' | 'glb';
type V3 = [number, number, number];

interface BoneDef {
  name: string;
  parent: string | null;
  at: V3;
  mixamo: string;
}

/** The skeleton, relative positions, facing +Z with the left hand at +X. */
function skeleton(): BoneDef[] {
  const b: BoneDef[] = [];
  const add = (name: string, parent: string | null, at: V3, mixamo: string): void => void b.push({ name, parent, at, mixamo });
  add('hips', null, [0, 0.95, 0], 'Hips');
  add('spine', 'hips', [0, 0.1, 0], 'Spine');
  add('chest', 'spine', [0, 0.12, 0], 'Spine1');
  add('upperChest', 'chest', [0, 0.12, 0], 'Spine2');
  add('neck', 'upperChest', [0, 0.14, 0], 'Neck');
  add('head', 'neck', [0, 0.08, 0], 'Head');
  for (const [side, s, M] of [['left', 1, 'Left'], ['right', -1, 'Right']] as const) {
    add(`${side}Eye`, 'head', [0.03 * s, 0.07, 0.08], `${M}Eye`);
    add(`${side}Shoulder`, 'upperChest', [0.04 * s, 0.1, 0], `${M}Shoulder`);
    add(`${side}UpperArm`, `${side}Shoulder`, [0.1 * s, 0, 0], `${M}Arm`);
    add(`${side}LowerArm`, `${side}UpperArm`, [0.25 * s, 0, 0], `${M}ForeArm`);
    add(`${side}Hand`, `${side}LowerArm`, [0.24 * s, 0, 0], `${M}Hand`);
    const fingers = [
      ['Thumb', ['Metacarpal', 'Proximal', 'Distal'], [0.02, 0, 0.03]],
      ['Index', ['Proximal', 'Intermediate', 'Distal'], [0.08, 0, 0.025]],
      ['Middle', ['Proximal', 'Intermediate', 'Distal'], [0.085, 0, 0.005]],
      ['Ring', ['Proximal', 'Intermediate', 'Distal'], [0.08, 0, -0.015]],
      ['Little', ['Proximal', 'Intermediate', 'Distal'], [0.07, 0, -0.035]],
    ] as const;
    for (const [finger, parts, base] of fingers) {
      parts.forEach((part, i) => {
        const at: V3 = i === 0 ? [base[0] * s, base[1], base[2]] : [0.028 * s, 0, 0];
        add(`${side}${finger}${part}`, i === 0 ? `${side}Hand` : `${side}${finger}${parts[i - 1]}`, at, `${M}Hand${finger === 'Little' ? 'Pinky' : finger}${i + 1}`);
      });
    }
    add(`${side}UpperLeg`, 'hips', [0.09 * s, -0.05, 0], `${M}UpLeg`);
    add(`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.42, 0], `${M}Leg`);
    add(`${side}Foot`, `${side}LowerLeg`, [0, -0.42, 0], `${M}Foot`);
    add(`${side}Toes`, `${side}Foot`, [0, -0.05, 0.12], `${M}ToeBase`);
  }
  add('hair1', 'head', [0, 0.12, -0.1], 'Hair1');
  add('hair2', 'hair1', [0, -0.08, -0.01], 'Hair2');
  add('hair3', 'hair2', [0, -0.08, 0], 'Hair3');
  return b;
}

/** A box between two points, its six faces each a `n`×`n` grid, all weighted to one joint. */
function box(out: Geometry, a: V3, b: V3, half: number, joint: number, n = 4): void {
  const min: V3 = [Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half, Math.min(a[2], b[2]) - half];
  const max: V3 = [Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half, Math.max(a[2], b[2]) + half];
  const faces: Array<{ axis: number; sign: number }> = [0, 1, 2].flatMap((axis) => [-1, 1].map((sign) => ({ axis, sign })));
  for (const { axis, sign } of faces) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const base = out.positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const p: V3 = [0, 0, 0];
        p[axis] = sign > 0 ? max[axis]! : min[axis]!;
        p[u] = min[u]! + ((max[u]! - min[u]!) * i) / n;
        p[v] = min[v]! + ((max[v]! - min[v]!) * j) / n;
        out.positions.push(...p);
        const nn: V3 = [0, 0, 0];
        nn[axis] = sign;
        out.normals.push(...nn);
        out.uvs.push(i / n, j / n);
        out.joints.push(joint, 0, 0, 0);
        out.weights.push(1, 0, 0, 0);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const q = base + j * (n + 1) + i;
        const quad = [q, q + 1, q + n + 2, q, q + n + 2, q + n + 1];
        // Counter-clockwise seen from outside: (u, v) follow the axis cyclically, so a face looking
        // down its axis is the one turned round.
        if (sign < 0) out.indices.push(quad[0]!, quad[2]!, quad[1]!, quad[3]!, quad[5]!, quad[4]!);
        else out.indices.push(...quad);
      }
    }
  }
}

interface Geometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  joints: number[];
  weights: number[];
  indices: number[];
}
const geometry = (): Geometry => ({ positions: [], normals: [], uvs: [], joints: [], weights: [], indices: [] });

function checker(side = 64, a: number[] = [230, 200, 180, 255], b: number[] = [90, 120, 200, 255]): Uint8Array {
  const png = new PNG({ width: side, height: side });
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) png.data.set(((x >> 3) + (y >> 3)) % 2 ? a : b, (y * side + x) * 4);
  return new Uint8Array(PNG.sync.write(png));
}

interface Built {
  doc: Document;
  nodes: Map<string, Node>;
  body: Mesh;
  bodyNode: Node;
  material: Material;
  texture: Texture;
  thumbnail: Texture;
}

/** The avatar as a glTF-Transform document; `flip` builds it facing -Z (VRM 0.x's way). */
function build(kind: SampleKind, flip: boolean): Built {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const defs = skeleton();
  const nodes = new Map<string, Node>();
  const world = new Map<string, V3>();
  const f = (v: V3): V3 => (flip ? [-v[0], v[1], -v[2]] : v);
  const armature = doc.createNode('Armature');
  scene.addChild(armature);
  for (const d of defs) {
    const node = doc.createNode(kind === 'glb' ? `mixamorig:${d.mixamo}` : d.name).setTranslation(f(d.at));
    nodes.set(d.name, node);
    (d.parent ? nodes.get(d.parent)! : armature).addChild(node);
    const p = d.parent ? world.get(d.parent)! : ([0, 0, 0] as V3);
    world.set(d.name, [p[0] + d.at[0], p[1] + d.at[1], p[2] + d.at[2]]);
  }
  // The body: a box per segment (bone to its first child), the hands, feet and head their own.
  const g = geometry();
  const joints = defs.map((d) => d.name);
  const ji = (name: string): number => joints.indexOf(name);
  const children = (name: string): BoneDef[] => defs.filter((d) => d.parent === name);
  for (const d of defs) {
    if (d.name.endsWith('Eye') || d.name === 'head') continue;
    const kid = children(d.name).find((c) => !c.name.endsWith('Eye') && !c.name.startsWith('hair'));
    const from = world.get(d.name)!;
    if (kid) {
      const to = world.get(kid.name)!;
      const finger = /Thumb|Index|Middle|Ring|Little/.test(d.name);
      box(g, from, to, finger ? 0.008 : d.name.startsWith('hair') ? 0.015 : 0.045, ji(d.name), finger ? 1 : 3);
    } else if (d.name.startsWith('hair')) box(g, from, [from[0], from[1] - 0.06, from[2]], 0.015, ji(d.name), 1);
    else if (/Distal/.test(d.name)) box(g, from, [from[0] + (from[0] > 0 ? 0.018 : -0.018), from[1], from[2]], 0.007, ji(d.name), 1);
  }
  // The head, its front grid moved by the shapes (mouth open: the lower front row down; blink: the
  // upper front rows down), in a primitive of its own so the shapes sit on one mesh with it.
  const head = geometry();
  const h = world.get('head')!;
  box(head, [h[0], h[1] + 0.02, h[2]], [h[0], h[1] + 0.2, h[2]], 0.09, ji('head'), 6);
  const count = head.positions.length / 3;
  const aa = new Float32Array(count * 3);
  const blink = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [head.positions[i * 3]!, head.positions[i * 3 + 1]!, head.positions[i * 3 + 2]!];
    if (z > h[2] + 0.085 && Math.abs(x - h[0]) < 0.05) {
      if (y < h[1] + 0.07) aa[i * 3 + 1] = -0.02;
      if (y > h[1] + 0.11 && y < h[1] + 0.15) blink[i * 3 + 1] = -0.012;
    }
  }
  const all = (geo: Geometry): Geometry => ({ ...geo, positions: geo.positions.map((v, i) => (flip && i % 3 !== 1 ? -v : v)), normals: geo.normals.map((v, i) => (flip && i % 3 !== 1 ? -v : v)) });
  const flipTarget = (t: Float32Array): Float32Array<ArrayBuffer> => Float32Array.from(t, (v, i) => (flip && i % 3 !== 1 ? -v : v));
  const texture = doc.createTexture('checker').setMimeType('image/png').setImage(checker());
  const thumbnail = doc.createTexture('thumbnail').setMimeType('image/png').setImage(checker(64, [255, 255, 255, 255], [240, 60, 60, 255]));
  const material = doc.createMaterial('Body').setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(1);
  // glTF-Transform writes a mesh's shape names (extras.targetNames) from its targets' names.
  const shapeNames = kind === 'glb' ? ['viseme_aa', 'eyeBlinkLeft'] : ['aa', 'blink'];
  const prim = (geo: Geometry, targets: Float32Array[] = []): Primitive => {
    const p = doc
      .createPrimitive()
      .setMaterial(material)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(all(geo).positions)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(all(geo).normals)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(geo.uvs)).setBuffer(buffer))
      .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(geo.joints)).setBuffer(buffer))
      .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(geo.weights)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(geo.indices)).setBuffer(buffer));
    targets.forEach((t, k) => p.addTarget(doc.createPrimitiveTarget(shapeNames[k]).setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(flipTarget(t)).setBuffer(buffer))));
    return p;
  };
  // The body's primitive takes zero shapes, the head's two: glTF wants the same count on a mesh, so
  // the body's primitive gets empty ones.
  const zeros = (n: number): Float32Array => new Float32Array(n * 3);
  const body = doc
    .createMesh('Body')
    .addPrimitive(prim(g, [zeros(g.positions.length / 3), zeros(g.positions.length / 3)]))
    .addPrimitive(prim(head, [aa, blink]))
    .setWeights([0, 0]);
  const skin = doc.createSkin('Body');
  const ibm: number[] = [];
  for (const name of joints) {
    const w = f(world.get(name)!);
    skin.addJoint(nodes.get(name)!);
    ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1);
  }
  skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(new Float32Array(ibm)).setBuffer(buffer));
  const bodyNode = doc.createNode('Body').setMesh(body).setSkin(skin);
  scene.addChild(bodyNode);
  return { doc, nodes, body, bodyNode, material, texture, thumbnail };
}

const META = {
  name: 'FlatChat sample',
  version: '1',
  authors: ['FlatChat tests'],
  licenseUrl: 'https://vrm.dev/licenses/1.0/',
  avatarPermission: 'everyone',
  allowExcessivelyViolentUsage: false,
  allowExcessivelySexualUsage: false,
  commercialUsage: 'personalNonProfit',
  allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false,
  creditNotation: 'unnecessary',
  allowRedistribution: true,
  modification: 'allowModificationRedistribution',
};

async function glb(doc: Document, patch?: (json: Record<string, unknown>) => void): Promise<Uint8Array> {
  const io = new NodeIO().registerExtensions([VRMExtension]);
  if (!patch) return io.writeBinary(doc);
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLB });
  patch(json as unknown as Record<string, unknown>);
  const bin = resources[GLB_BUFFER] ?? Object.values(resources)[0] ?? new Uint8Array(0);
  for (const b of (json.buffers ?? []) as unknown as Array<Record<string, unknown>>) delete b['uri'];
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(enc.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20);
  out.fill(0x20, 20 + enc.length, 20 + jsonLen);
  if (bin.length) {
    v.setUint32(20 + jsonLen, binLen, true);
    v.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
  }
  return out;
}

/** A reference avatar's file. */
export async function sampleAvatar(kind: SampleKind): Promise<Uint8Array> {
  const b = build(kind, kind === 'vrm0');
  const index = (n: Node): number => b.doc.getRoot().listNodes().indexOf(n);
  const bodyIndex = index(b.bodyNode);
  if (kind === 'glb') {
    b.thumbnail.dispose();
    return glb(b.doc);
  }
  if (kind === 'vrm1') {
    return glb(b.doc, (json) => {
      const humanBones = Object.fromEntries([...b.nodes].filter(([n]) => !n.startsWith('hair')).map(([n, node]) => [n, { node: index(node) }]));
      (json['extensions'] ??= {}) as Record<string, unknown>;
      const ext = json['extensions'] as Record<string, unknown>;
      ext['VRMC_vrm'] = {
        specVersion: '1.0',
        meta: { ...META, thumbnailImage: b.doc.getRoot().listTextures().indexOf(b.thumbnail) },
        humanoid: { humanBones },
        expressions: { preset: { aa: { morphTargetBinds: [{ node: bodyIndex, index: 0, weight: 1 }] }, blink: { morphTargetBinds: [{ node: bodyIndex, index: 1, weight: 1 }] } } },
        lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.07, 0.06] },
        firstPerson: { meshAnnotations: [{ node: bodyIndex, type: 'auto' }] },
      };
      ext['VRMC_springBone'] = {
        specVersion: '1.0',
        colliders: [{ node: index(b.nodes.get('head')!), shape: { sphere: { offset: [0, 0.1, 0], radius: 0.1 } } }],
        colliderGroups: [{ name: 'head', colliders: [0] }],
        springs: [{ name: 'hair', joints: ['hair1', 'hair2', 'hair3'].map((n) => ({ node: index(b.nodes.get(n)!), hitRadius: 0.02, stiffness: 1, gravityPower: 0, gravityDir: [0, -1, 0], dragForce: 0.4 })), colliderGroups: [0] }],
      };
      const m = (json['materials'] as Array<Record<string, unknown>>)[0]!;
      m['extensions'] = { VRMC_materials_mtoon: { specVersion: '1.0', shadeColorFactor: [0.8, 0.7, 0.7], shadingToonyFactor: 0.9 } };
      json['extensionsUsed'] = ['VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon'];
    });
  }
  return glb(b.doc, (json) => {
    const textures = (json['textures'] as Array<Record<string, unknown>>) ?? [];
    const images = b.doc.getRoot().listTextures();
    // VRM 0.x names textures (not images) everywhere: give the thumbnail a texture of its own.
    textures.push({ source: images.indexOf(b.thumbnail) });
    json['textures'] = textures;
    (json['extensions'] ??= {}) as Record<string, unknown>;
    (json['extensions'] as Record<string, unknown>)['VRM'] = {
      exporterVersion: 'FlatChat sample',
      specVersion: '0.0',
      meta: { title: 'FlatChat sample (VRM 0)', version: '1', author: 'FlatChat tests', texture: textures.length - 1, allowedUserName: 'Everyone', violentUssageName: 'Disallow', sexualUssageName: 'Disallow', commercialUssageName: 'Disallow', licenseName: 'CC0' },
      humanoid: { humanBones: [...b.nodes].filter(([n]) => !n.startsWith('hair')).map(([n, node]) => ({ bone: n.replace(/Thumb(Metacarpal|Proximal)/, (_, p: string) => (p === 'Metacarpal' ? 'ThumbProximal' : 'ThumbIntermediate')), node: index(node), useDefaultValues: true })) },
      blendShapeMaster: {
        blendShapeGroups: [
          { name: 'A', presetName: 'a', binds: [{ mesh: 0, index: 0, weight: 100 }], materialValues: [] },
          { name: 'Blink', presetName: 'blink', binds: [{ mesh: 0, index: 1, weight: 100 }], materialValues: [] },
          { name: 'Joy', presetName: 'joy', binds: [], materialValues: [{ materialName: 'Body', propertyName: '_Color', targetValue: [1, 0.9, 0.9, 1] }] },
        ],
      },
      firstPerson: {
        firstPersonBone: index(b.nodes.get('head')!),
        firstPersonBoneOffset: { x: 0, y: 0.07, z: 0.06 },
        meshAnnotations: [{ mesh: 0, firstPersonFlag: 'Auto' }],
        lookAtTypeName: 'Bone',
        lookAtHorizontalInner: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
        lookAtHorizontalOuter: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
        lookAtVerticalDown: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
        lookAtVerticalUp: { curve: [0, 0, 0, 1, 1, 1, 1, 0], xRange: 90, yRange: 10 },
      },
      secondaryAnimation: {
        boneGroups: [{ comment: 'hair', stiffiness: 1, gravityPower: 0, gravityDir: { x: 0, y: -1, z: 0 }, dragForce: 0.4, center: -1, hitRadius: 0.02, bones: [index(b.nodes.get('hair1')!)], colliderGroups: [0] }],
        colliderGroups: [{ node: index(b.nodes.get('head')!), colliders: [{ offset: { x: 0, y: 0.1, z: 0 }, radius: 0.1 }] }],
      },
      materialProperties: [
        {
          name: 'Body',
          shader: 'VRM/MToon',
          renderQueue: 2000,
          floatProperties: { _Cutoff: 0.5, _ShadeShift: 0, _ShadeToony: 0.9, _CullMode: 2, _OutlineWidthMode: 0, _ZWrite: 1 },
          vectorProperties: { _Color: [1, 1, 1, 1], _ShadeColor: [0.8, 0.7, 0.7, 1], _MainTex: [0, 0, 1, 1] },
          textureProperties: { _MainTex: 0 },
          keywordMap: {},
          tagMap: { RenderType: 'Opaque' },
        },
      ],
    };
    json['extensionsUsed'] = ['VRM'];
  });
}
