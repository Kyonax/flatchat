// SPDX-License-Identifier: MPL-2.0
// VRM 0.x to VRM 1.0, at the JSON level, before glTF-Transform reads the file (vrm.ts reads the
// result). The rules are three-vrm's, the runtime the client uses, so a migrated avatar behaves as
// three-vrm would have shown the original:
// - humanoid: the same bones, the thumb's three renamed (proximal, intermediate become
//   metacarpal, proximal);
// - expressions from blendShapeMaster: presets renamed (a, i, u, e, o become aa, ih, ou, ee, oh;
//   joy, sorrow, fun become happy, sad, relaxed; and so on), morph binds moved from meshes to every
//   node using the mesh with their weight from 0–100 to 0–1, material values to colour binds and
//   texture-transform binds;
// - first person: mesh annotations moved to the nodes using the meshes; look-at with its type, its
//   range maps and its offset;
// - spring bones: each bone group's roots become chains (a node's first child continues its chain,
//   other children start their own), a leaf getting the 7 cm tail three-vrm gives it as a new node;
//   collider groups become colliders and groups; VRM 0.x's flipped z is undone;
// - MToon and the unlit shaders from materialProperties into VRMC_materials_mtoon, ported from
//   @pixiv/three-vrm-materials-v0compat (MIT, Copyright (c) 2019-2026 pixiv Inc.).
// The file is still in VRM 0.x's frame (facing -Z): the converter then turns the whole avatar
// round (axes.ts), vectors in the VRM data included.
import type { Json, JsonObject } from './vrm.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const PRESETS: Record<string, string> = {
  a: 'aa',
  e: 'ee',
  i: 'ih',
  o: 'oh',
  u: 'ou',
  blink: 'blink',
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  neutral: 'neutral',
};
const THUMBS: Record<string, string> = {
  leftThumbProximal: 'leftThumbMetacarpal',
  leftThumbIntermediate: 'leftThumbProximal',
  rightThumbProximal: 'rightThumbMetacarpal',
  rightThumbIntermediate: 'rightThumbProximal',
};
const COLOUR_BINDS: Record<string, string> = { _Color: 'color', _EmissionColor: 'emissionColor', _ShadeColor: 'shadeColor', _RimColor: 'rimColor', _OutlineColor: 'outlineColor' };

/** What the VRM 0.x file said about its licence, kept as it was for the avatar's manifest. */
export type SourceMeta = Record<string, string | number | boolean>;

export interface Migrated {
  sourceMeta: SourceMeta;
  notes: string[];
}

/** Rewrites a VRM 0.x glTF JSON as VRM 1.0 (in VRM 0.x's frame), in place. */
export function migrateVrm0(json: Obj): Migrated {
  const notes: string[] = [];
  const ext = obj(obj(json['extensions'])?.['VRM']);
  if (!ext) throw new Error('no VRM extension');
  const nodes = arr(json['nodes']) as Obj[];
  const materials = arr(json['materials']) as Obj[];
  const textures = arr(json['textures']) as Obj[];
  json['nodes'] = nodes;
  const nodesUsingMesh = (mesh: unknown): number[] => (typeof mesh === 'number' ? nodes.flatMap((n, i) => (n['mesh'] === mesh ? [i] : [])) : []);

  // ----------------------------------------------------------------- meta
  const meta = obj(ext['meta']) ?? {};
  const sourceMeta: SourceMeta = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') sourceMeta[k] = v;
  const licence = String(meta['licenseName'] ?? 'Other');
  const cc = /^CC/.test(licence);
  const ccUrl: Record<string, string> = {
    CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
    CC_BY: 'https://creativecommons.org/licenses/by/4.0/',
    CC_BY_NC: 'https://creativecommons.org/licenses/by-nc/4.0/',
    CC_BY_SA: 'https://creativecommons.org/licenses/by-sa/4.0/',
    CC_BY_NC_SA: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    CC_BY_ND: 'https://creativecommons.org/licenses/by-nd/4.0/',
    CC_BY_NC_ND: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
  };
  const thumbTexture = meta['texture'];
  const thumbnailImage = typeof thumbTexture === 'number' ? (textures[thumbTexture]?.['source'] as number | undefined) : undefined;
  const v1meta: JsonObject = {
    name: String(meta['title'] ?? '') || 'Untitled',
    version: String(meta['version'] ?? ''),
    authors: [String(meta['author'] ?? '') || 'Unknown'],
    contactInformation: String(meta['contactInformation'] ?? ''),
    references: meta['reference'] ? [String(meta['reference'])] : [],
    // The VRM Public Licence as VRM 1.0 requires; the original licence goes in otherLicenseUrl, and
    // the original fields stay in the manifest. Unknown terms are read the strict way.
    licenseUrl: 'https://vrm.dev/licenses/1.0/',
    avatarPermission: meta['allowedUserName'] === 'Everyone' ? 'everyone' : meta['allowedUserName'] === 'ExplicitlyLicensedPerson' ? 'onlySeparatelyLicensedPerson' : 'onlyAuthor',
    allowExcessivelyViolentUsage: meta['violentUssageName'] === 'Allow',
    allowExcessivelySexualUsage: meta['sexualUssageName'] === 'Allow',
    commercialUsage: meta['commercialUssageName'] === 'Allow' ? 'personalProfit' : 'personalNonProfit',
    allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false,
    creditNotation: licence === 'CC0' ? 'unnecessary' : 'required',
    allowRedistribution: licence === 'CC0' || licence === 'CC_BY' || licence === 'CC_BY_SA',
    modification: cc && !licence.includes('ND') ? 'allowModificationRedistribution' : 'prohibited',
    otherLicenseUrl: ccUrl[licence] ?? String(meta['otherLicenseUrl'] ?? ''),
  };
  if (thumbnailImage !== undefined) v1meta['thumbnailImage'] = thumbnailImage;

  // ----------------------------------------------------------------- humanoid
  const humanBones: JsonObject = {};
  for (const b of arr(obj(ext['humanoid'])?.['humanBones'])) {
    const bone = obj(b);
    const name = bone?.['bone'];
    const node = bone?.['node'];
    if (typeof name !== 'string' || typeof node !== 'number' || node < 0 || !nodes[node]) continue;
    const v1 = THUMBS[name] ?? name;
    if (humanBones[v1] !== undefined) continue;
    humanBones[v1] = { node };
  }

  // ----------------------------------------------------------------- expressions
  const preset: JsonObject = {};
  const custom: JsonObject = {};
  const materialByName = (name: unknown): number | undefined => {
    const i = materials.findIndex((m) => m['name'] === name);
    return i >= 0 ? i : undefined;
  };
  for (const g of arr(obj(ext['blendShapeMaster'])?.['blendShapeGroups'])) {
    const group = obj(g);
    if (!group) continue;
    const presetName = typeof group['presetName'] === 'string' ? PRESETS[group['presetName']] : undefined;
    const name = presetName ?? (typeof group['name'] === 'string' && group['name'] ? group['name'] : undefined);
    if (!name || preset[name] !== undefined || custom[name] !== undefined) continue;
    const morphTargetBinds: Json[] = [];
    for (const b of arr(group['binds'])) {
      const bind = obj(b);
      if (typeof bind?.['index'] !== 'number') continue;
      const weight = Math.min(1, Math.max(0, 0.01 * num(bind['weight'], 100)));
      for (const node of nodesUsingMesh(bind['mesh'])) morphTargetBinds.push({ node, index: bind['index'], weight });
    }
    const materialColorBinds: Json[] = [];
    const textureTransformBinds: Json[] = [];
    for (const v of arr(group['materialValues'])) {
      const mv = obj(v);
      const material = materialByName(mv?.['materialName']);
      const target = arr(mv?.['targetValue']).map((x) => num(x, 0));
      if (material === undefined || typeof mv?.['propertyName'] !== 'string') continue;
      if (mv['propertyName'] === '_MainTex_ST' && target.length >= 4) {
        textureTransformBinds.push({ material, scale: [target[0]!, target[1]!], offset: [target[2]!, 1 - target[3]! - target[1]!] });
      } else if (COLOUR_BINDS[mv['propertyName']] && target.length >= 3) {
        materialColorBinds.push({ material, type: COLOUR_BINDS[mv['propertyName']]!, targetValue: [target[0]!, target[1]!, target[2]!, target[3] ?? 1] });
      } else {
        notes.push(`expression ${name}: the material value ${mv['propertyName']} has no VRM 1.0 equivalent and is dropped`);
      }
    }
    const e: JsonObject = { morphTargetBinds, materialColorBinds, textureTransformBinds, isBinary: group['isBinary'] === true, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' };
    (presetName ? preset : custom)[name] = e;
  }

  // ----------------------------------------------------------------- first person and look-at
  const fp = obj(ext['firstPerson']) ?? {};
  const meshAnnotations: Json[] = [];
  const typeOf = (flag: unknown): string => (flag === 'FirstPersonOnly' ? 'firstPersonOnly' : flag === 'ThirdPersonOnly' ? 'thirdPersonOnly' : flag === 'Both' ? 'both' : 'auto');
  for (const a of arr(fp['meshAnnotations'])) {
    const ann = obj(a);
    for (const node of nodesUsingMesh(ann?.['mesh'])) meshAnnotations.push({ node, type: typeOf(ann?.['firstPersonFlag']) });
  }
  const expression = fp['lookAtTypeName'] === 'BlendShape';
  const rangeMap = (m: unknown): JsonObject => {
    const r = obj(m);
    return { inputMaxValue: Math.max(0.0001, num(r?.['xRange'], 90)), outputScale: num(r?.['yRange'], expression ? 1 : 10) };
  };
  const off = obj(fp['firstPersonBoneOffset']);
  const lookAt: JsonObject = {
    type: expression ? 'expression' : 'bone',
    // VRM 0.x's z is flipped (three-vrm reads -z); the turn to +Z follows in axes.ts.
    offsetFromHeadBone: off ? [num(off['x'], 0), num(off['y'], 0.06), -num(off['z'], 0)] : [0, 0.06, 0],
    rangeMapHorizontalInner: rangeMap(fp['lookAtHorizontalInner']),
    rangeMapHorizontalOuter: rangeMap(fp['lookAtHorizontalOuter']),
    rangeMapVerticalDown: rangeMap(fp['lookAtVerticalDown']),
    rangeMapVerticalUp: rangeMap(fp['lookAtVerticalUp']),
  };

  // ----------------------------------------------------------------- spring bones
  const sec = obj(ext['secondaryAnimation']) ?? {};
  const colliders: Json[] = [];
  const colliderGroups: Json[] = [];
  // VRM 1.0 wants no empty group: a VRM 0.x group with no usable collider is left out, and the
  // springs' references are renumbered.
  const groupIndex = new Map<number, number>();
  arr(sec['colliderGroups']).forEach((g, gi) => {
    const group = obj(g);
    const node = group?.['node'];
    const members: Json[] = [];
    if (typeof node === 'number' && nodes[node]) {
      for (const c of arr(group?.['colliders'])) {
        const col = obj(c);
        const o = obj(col?.['offset']);
        members.push(colliders.length);
        colliders.push({ node, shape: { sphere: { offset: [num(o?.['x'], 0), num(o?.['y'], 0), -num(o?.['z'], 0)], radius: Math.max(0, num(col?.['radius'], 0)) } } });
      }
    }
    if (members.length === 0) return;
    groupIndex.set(gi, colliderGroups.length);
    colliderGroups.push({ name: `colliderGroup${gi}`, colliders: members });
  });
  const springs: Json[] = [];
  const children = (i: number): number[] => arr(nodes[i]?.['children']).filter((c): c is number => typeof c === 'number' && !!nodes[c]);
  const translationOf = (i: number): [number, number, number] => {
    const n = nodes[i]!;
    if (Array.isArray(n['matrix']) && n['matrix'].length === 16) return [num(n['matrix'][12], 0), num(n['matrix'][13], 0), num(n['matrix'][14], 0)];
    const t = arr(n['translation']);
    return [num(t[0], 0), num(t[1], 0), num(t[2], 0)];
  };
  let tails = 0;
  const tailOf = (leaf: number): number | undefined => {
    const [x, y, z] = translationOf(leaf);
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) return undefined;
    const tail = nodes.length;
    nodes.push({ name: `${String(nodes[leaf]!['name'] ?? `node${leaf}`)}_end`, translation: [(x / len) * 0.07, (y / len) * 0.07, (z / len) * 0.07] });
    nodes[leaf]!['children'] = [...children(leaf), tail];
    tails += 1;
    return tail;
  };
  arr(sec['boneGroups']).forEach((g, gi) => {
    const group = obj(g);
    if (!group) return;
    const gd = obj(group['gravityDir']);
    const joint = (node: number): JsonObject => ({
      node,
      hitRadius: Math.max(0, num(group['hitRadius'], 0)),
      stiffness: Math.max(0, num(group['stiffiness'], 1)),
      gravityPower: Math.max(0, num(group['gravityPower'], 0)),
      gravityDir: gd ? [num(gd['x'], 0), num(gd['y'], -1), num(gd['z'], 0)] : [0, -1, 0],
      dragForce: Math.min(1, Math.max(0, num(group['dragForce'], 0.4))),
    });
    const groups = arr(group['colliderGroups']).flatMap((c) => (typeof c === 'number' && groupIndex.has(c) ? [groupIndex.get(c)!] : []));
    const center = typeof group['center'] === 'number' && group['center'] >= 0 && nodes[group['center']] ? group['center'] : undefined;
    const seen = new Set<number>();
    const chainFrom = (start: number): void => {
      const chain: number[] = [];
      let at: number | undefined = start;
      while (at !== undefined && !seen.has(at)) {
        seen.add(at);
        chain.push(at);
        const kids = children(at);
        for (const other of kids.slice(1)) pending.push(other);
        at = kids[0];
      }
      // A leaf moves too in VRM 0.x, towards a tail 7 cm out: VRM 1.0 needs that tail as a joint.
      const last = chain.at(-1);
      if (last !== undefined && children(last).length === 0) {
        const tail = tailOf(last);
        if (tail !== undefined) {
          seen.add(tail);
          chain.push(tail);
        }
      }
      if (chain.length >= 2) {
        springs.push({ name: `${String(group['comment'] ?? `spring${gi}`)}`, joints: chain.map(joint), colliderGroups: groups, ...(center !== undefined ? { center } : {}) });
      }
    };
    const pending: number[] = arr(group['bones']).filter((b): b is number => typeof b === 'number' && !!nodes[b]);
    while (pending.length > 0) chainFrom(pending.shift()!);
  });
  if (tails > 0) notes.push(`${tails} spring chain end(s) got VRM 0.x's 7 cm tail as a node`);

  // ----------------------------------------------------------------- materials (MToon, unlit)
  const used = new Set(arr(json['extensionsUsed']).filter((e): e is string => typeof e === 'string'));
  used.delete('VRM');
  let mtoon = false;
  const props = arr(ext['materialProperties']).map((p) => obj(p) ?? {});
  const queues = renderQueueMaps(props);
  props.forEach((p, i) => {
    const def = materials[i];
    if (!def) return;
    const shader = String(p['shader'] ?? '');
    if (shader === 'VRM/MToon') {
      materials[i] = mtoonMaterial(p, def, queues);
      mtoon = true;
    } else if (shader.startsWith('VRM/Unlit')) {
      materials[i] = unlitMaterial(p, def, queues);
      mtoon = true;
    } else if (shader !== 'VRM_USE_GLTFSHADER' && shader !== '') {
      notes.push(`material ${i}: the shader ${shader} is unknown and kept as glTF`);
    }
  });
  json['materials'] = materials;
  if (mtoon) {
    used.add('VRMC_materials_mtoon');
    used.add('KHR_texture_transform');
  }

  const extensions = obj(json['extensions'])!;
  delete extensions['VRM'];
  extensions['VRMC_vrm'] = {
    specVersion: '1.0',
    meta: v1meta,
    humanoid: { humanBones },
    expressions: { preset, custom },
    firstPerson: { meshAnnotations },
    lookAt,
  };
  if (springs.length > 0 || colliders.length > 0) {
    extensions['VRMC_springBone'] = { specVersion: '1.0', colliders, colliderGroups, springs };
    used.add('VRMC_springBone');
  }
  used.add('VRMC_vrm');
  json['extensionsUsed'] = [...used];
  if (Array.isArray(json['extensionsRequired'])) json['extensionsRequired'] = (json['extensionsRequired'] as unknown[]).filter((e) => e !== 'VRM');
  return { sourceMeta, notes };
}

// ------------------------------------------------------------------ MToon (from three-vrm, MIT)

const gamma = (v: number): number => Math.pow(v, 2.2);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface QueueMaps {
  transparent: Map<number, number>;
  transparentZWrite: Map<number, number>;
}

const isUnlitZWrite = (p: Obj): boolean => p['shader'] === 'VRM/UnlitTransparentZWrite';
const isTransparent = (p: Obj): boolean => obj(p['keywordMap'])?.['_ALPHABLEND_ON'] != null || p['shader'] === 'VRM/UnlitTransparent' || isUnlitZWrite(p);
const zWrite = (p: Obj): boolean => obj(p['floatProperties'])?.['_ZWrite'] === 1 || isUnlitZWrite(p);

/** VRM 0.x's render queues, in their order, as VRM 1.0's offsets (at most ten each). */
function renderQueueMaps(list: Obj[]): QueueMaps {
  const t = new Set<number>();
  const tz = new Set<number>();
  for (const p of list) {
    if (!isTransparent(p) || typeof p['renderQueue'] !== 'number') continue;
    (zWrite(p) ? tz : t).add(p['renderQueue']);
  }
  const map = (set: Set<number>, zw: boolean): Map<number, number> => {
    const sorted = [...set].sort((a, b) => a - b);
    const m = new Map<number, number>();
    sorted.forEach((q, i) => m.set(q, zw ? Math.min(i, 9) : Math.min(Math.max(i - sorted.length + 1, -9), 0)));
    return m;
  };
  return { transparent: map(t, false), transparentZWrite: map(tz, true) };
}

function queueOffset(p: Obj, maps: QueueMaps): number {
  if (!isTransparent(p) || typeof p['renderQueue'] !== 'number') return 0;
  return (zWrite(p) ? maps.transparentZWrite : maps.transparent).get(p['renderQueue']) ?? 0;
}

function textureTransform(p: Obj): JsonObject {
  const st = arr(obj(p['vectorProperties'])?.['_MainTex']).map((x) => num(x, Number.NaN));
  if (st.length < 4) return {};
  const offset = [Number.isNaN(st[0]!) ? 0 : st[0]!, Number.isNaN(st[1]!) ? 0 : st[1]!];
  const scale = [Number.isNaN(st[2]!) ? 1 : st[2]!, Number.isNaN(st[3]!) ? 1 : st[3]!];
  offset[1] = 1 - scale[1]! - offset[1]!;
  return { KHR_texture_transform: { offset, scale } };
}

function mtoonMaterial(p: Obj, def: Obj, queues: QueueMaps): Obj {
  const floats = obj(p['floatProperties']) ?? {};
  const vectors = obj(p['vectorProperties']) ?? {};
  const texturesOf = obj(p['textureProperties']) ?? {};
  const keywords = obj(p['keywordMap']) ?? {};
  const f = (k: string, d: number): number => num(floats[k], d);
  const v = (k: string, d: number[]): number[] => {
    const a = arr(vectors[k]).map((x) => num(x, 0));
    return a.length >= d.length ? a.slice(0, Math.max(d.length, a.length)) : d;
  };
  const transparent = keywords['_ALPHABLEND_ON'] === true;
  const cutoff = keywords['_ALPHATEST_ON'] === true;
  const tt = textureTransform(p);
  const tex = (k: string, withTransform = true): JsonObject | undefined => (typeof texturesOf[k] === 'number' ? { index: texturesOf[k] as number, ...(withTransform && tt['KHR_texture_transform'] ? { extensions: { ...tt } } : {}) } : undefined);
  let shift = f('_ShadeShift', 0);
  let toony = f('_ShadeToony', 0.9);
  toony = lerp(toony, 1, 0.5 + 0.5 * shift);
  shift = -shift - (1 - toony);
  const gi = f('_IndirectLightIntensity', 0.1);
  const outlineMode = (['none', 'worldCoordinates', 'screenCoordinates'] as const)[f('_OutlineWidthMode', 0)] ?? 'none';
  const colourMode = f('_OutlineColorMode', 0);
  const scrollY = f('_UvAnimScrollY', 0);
  const mtoon: JsonObject = clean({
    specVersion: '1.0',
    transparentWithZWrite: floats['_ZWrite'] === 1 && transparent,
    renderQueueOffsetNumber: queueOffset(p, queues),
    shadeColorFactor: v('_ShadeColor', [0.97, 0.81, 0.86, 1]).slice(0, 3).map(gamma),
    shadeMultiplyTexture: tex('_ShadeTexture'),
    shadingShiftFactor: shift,
    shadingToonyFactor: toony,
    giEqualizationFactor: gi ? 1 - gi : undefined,
    matcapFactor: typeof texturesOf['_SphereAdd'] === 'number' ? [1, 1, 1] : undefined,
    matcapTexture: tex('_SphereAdd', false),
    rimLightingMixFactor: f('_RimLightingMix', 0),
    rimMultiplyTexture: tex('_RimTexture'),
    parametricRimColorFactor: v('_RimColor', [0, 0, 0, 1]).slice(0, 3).map(gamma),
    parametricRimFresnelPowerFactor: f('_RimFresnelPower', 1),
    parametricRimLiftFactor: f('_RimLift', 0),
    outlineWidthMode: outlineMode,
    outlineWidthFactor: 0.01 * f('_OutlineWidth', 0),
    outlineWidthMultiplyTexture: tex('_OutlineWidthTexture'),
    outlineColorFactor: v('_OutlineColor', [0, 0, 0]).slice(0, 3).map(gamma),
    outlineLightingMixFactor: colourMode === 1 ? f('_OutlineLightingMix', 1) : 0,
    uvAnimationMaskTexture: tex('_UvAnimMaskTexture'),
    uvAnimationScrollXSpeedFactor: f('_UvAnimScrollX', 0),
    uvAnimationScrollYSpeedFactor: -scrollY,
    uvAnimationRotationSpeedFactor: f('_UvAnimRotation', 0),
  });
  const color = v('_Color', [1, 1, 1, 1]);
  // As three-vrm does: the material's other extensions (KHR_materials_unlit, the usual fallback) go.
  const ext = { VRMC_materials_mtoon: mtoon };
  return clean({
    ...def,
    pbrMetallicRoughness: clean({ baseColorFactor: color.slice(0, 4).map((c, i) => (i === 3 ? c : gamma(c))), baseColorTexture: tex('_MainTex') }),
    normalTexture: typeof texturesOf['_BumpMap'] === 'number' ? { ...tex('_BumpMap')!, scale: f('_BumpScale', 1) } : undefined,
    emissiveTexture: tex('_EmissionMap'),
    emissiveFactor: v('_EmissionColor', [0, 0, 0, 1]).slice(0, 3).map(gamma),
    alphaMode: transparent ? 'BLEND' : cutoff ? 'MASK' : 'OPAQUE',
    alphaCutoff: cutoff ? f('_Cutoff', 0.5) : undefined,
    doubleSided: f('_CullMode', 2) === 0,
    extensions: ext,
  });
}

function unlitMaterial(p: Obj, def: Obj, queues: QueueMaps): Obj {
  const floats = obj(p['floatProperties']) ?? {};
  const texturesOf = obj(p['textureProperties']) ?? {};
  const zw = isUnlitZWrite(p);
  const transparent = p['shader'] === 'VRM/UnlitTransparent' || zw;
  const cutoff = p['shader'] === 'VRM/UnlitCutout';
  const tt = textureTransform(p);
  const colour = arr(obj(p['vectorProperties'])?.['_Color']).map((x) => num(x, 1));
  const baseColorFactor = (colour.length >= 4 ? colour.slice(0, 4) : [1, 1, 1, 1]).map(gamma);
  const baseColorTexture = typeof texturesOf['_MainTex'] === 'number' ? { index: texturesOf['_MainTex'] as number, ...(tt['KHR_texture_transform'] ? { extensions: { ...tt } } : {}) } : undefined;
  return clean({
    ...def,
    pbrMetallicRoughness: clean({ baseColorFactor, baseColorTexture }),
    alphaMode: transparent ? 'BLEND' : cutoff ? 'MASK' : 'OPAQUE',
    alphaCutoff: cutoff ? num(floats['_Cutoff'], 0.5) : undefined,
    extensions: {
      VRMC_materials_mtoon: clean({ specVersion: '1.0', transparentWithZWrite: zw, renderQueueOffsetNumber: queueOffset(p, queues), shadeColorFactor: baseColorFactor.slice(0, 3), shadeMultiplyTexture: baseColorTexture }),
    },
  });
}

/** Drops undefined values (JSON has none). */
function clean<T extends Obj>(o: T): T & JsonObject {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T & JsonObject;
}
