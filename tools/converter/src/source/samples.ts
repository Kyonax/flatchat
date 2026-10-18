// SPDX-License-Identifier: MPL-2.0
// Samples of the formats a model may be uploaded in (S5.08), for tests and the format fixtures. A
// Collada file written here from the converter's own sample humanoid or cube, the way Second Life's
// tools write one: meshes; a skin with its joints, inverse bind matrices and up to four weights a
// vertex; a material's colour; no images, which a DAE names by path. And the road the other formats
// take: the samples written by Blender as FBX, OBJ and .blend (tools/blender/convert/make-samples.py),
// then read back by to-glb.py, as the core does on an upload.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelFrom } from '@flatchat/content';
import type { Material, Node } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { avatarIO } from '../avatar/convert.ts';
import { sampleAvatar } from '../avatar/samples.ts';
import { sampleProp } from '../item/samples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The sample cube's declaration, which a DAE, an OBJ or an FBX cannot keep and its upload gives. */
export const SAMPLE_PROP_DECLARATION = { name: 'Sample cube', slot: 'attachment', attach: 'head_top', hides: [], authors: ['the FlatChat contributors'] };
/** The test tee's, given at upload with its FBX. */
export const SAMPLE_TEE_DECLARATION = { name: 'Test tee', slot: 'top', hides: ['belly', 'chest', 'upper_arm_l', 'upper_arm_r'], authors: ['the FlatChat contributors'] };

const num = (x: number): string => String(Math.round(x * 1e6) / 1e6);
const list = (a: ArrayLike<number>): string => Array.from(a, num).join(' ');
/** A glTF matrix (column by column) as Collada writes one (row by row). */
const rows = (m: ArrayLike<number>): string => list([0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]!)));
const sid = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_');

/** A Collada 1.4.1 file of a GLB's meshes: each mesh a geometry (positions, normals and texture
 *  coordinates by vertex, a triangle list for each of its materials), a skinned one's skin a
 *  controller over JOINT nodes, a material's base colour a Lambert effect. Shape keys and images
 *  stay behind. */
export async function daeOf(glb: Uint8Array): Promise<string> {
  const doc = await avatarIO().readBinary(glb);
  const geometries: string[] = [];
  const controllers: string[] = [];
  const effects: string[] = [];
  const materials: string[] = [];
  const instances: string[] = [];
  const materialIds = new Map<Material, string>();
  const joints = new Set<Node>();
  const symbolOf = (mat: Material | null): string => {
    if (!mat) return '';
    let symbol = materialIds.get(mat);
    if (symbol === undefined) {
      symbol = `m${materialIds.size}`;
      materialIds.set(mat, symbol);
      effects.push(`<effect id="${symbol}-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${list(mat.getBaseColorFactor())}</color></diffuse></lambert></technique></profile_COMMON></effect>`);
      materials.push(`<material id="${symbol}" name="${sid(mat.getName() || symbol)}"><instance_effect url="#${symbol}-fx"/></material>`);
    }
    return symbol;
  };
  let n = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const g = `g${n++}`;
    const name = sid(node.getName() || g);
    const prims = mesh.listPrimitives();
    // One vertex list for the mesh: each primitive's after the one before.
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const lists: string[] = [];
    const symbols = new Set<string>();
    const skin = node.getSkin();
    const weights: number[] = [];
    const vcount: number[] = [];
    const v: number[] = [];
    for (const prim of prims) {
      const base = pos.length / 3;
      const p = prim.getAttribute('POSITION')!;
      const nn = prim.getAttribute('NORMAL');
      const t = prim.getAttribute('TEXCOORD_0');
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      const e: number[] = [];
      const jv: number[] = [];
      const wv: number[] = [];
      for (let i = 0; i < p.getCount(); i++) {
        pos.push(...p.getElement(i, e));
        nor.push(...(nn ? nn.getElement(i, e) : [0, 0, 0]));
        // Collada's texture coordinates start at the bottom, glTF's at the top.
        const [s0, t0] = t ? t.getElement(i, e) : [0, 0];
        uv.push(s0!, 1 - t0!);
        if (!skin || !J || !W) continue;
        J.getElement(i, jv);
        W.getElement(i, wv);
        let c = 0;
        for (let k = 0; k < 4; k++) {
          if (wv[k]! <= 0) continue;
          v.push(jv[k]!, weights.length);
          weights.push(wv[k]!);
          c += 1;
        }
        vcount.push(c);
      }
      const idx = prim.getIndices()?.getArray() ?? Array.from({ length: p.getCount() }, (_, i) => i);
      const symbol = symbolOf(prim.getMaterial());
      if (symbol) symbols.add(symbol);
      lists.push(`<triangles count="${idx.length / 3}"${symbol ? ` material="${symbol}"` : ''}><input semantic="VERTEX" source="#${g}-vertices" offset="0"/><p>${Array.from(idx, (x) => x + base).join(' ')}</p></triangles>`);
    }
    const source = (id: string, values: ArrayLike<number>, params: string[]): string =>
      `<source id="${g}-${id}"><float_array id="${g}-${id}-array" count="${values.length}">${list(values)}</float_array><technique_common><accessor source="#${g}-${id}-array" count="${values.length / params.length}" stride="${params.length}">${params.map((x) => `<param name="${x}" type="float"/>`).join('')}</accessor></technique_common></source>`;
    geometries.push(
      `<geometry id="${g}" name="${name}"><mesh>${source('positions', pos, ['X', 'Y', 'Z'])}${source('normals', nor, ['X', 'Y', 'Z'])}${source('uvs', uv, ['S', 'T'])}` +
        `<vertices id="${g}-vertices"><input semantic="POSITION" source="#${g}-positions"/><input semantic="NORMAL" source="#${g}-normals"/><input semantic="TEXCOORD" source="#${g}-uvs"/></vertices>${lists.join('')}</mesh></geometry>`,
    );
    const bind = symbols.size ? `<bind_material><technique_common>${[...symbols].map((x) => `<instance_material symbol="${x}" target="#${x}"/>`).join('')}</technique_common></bind_material>` : '';
    if (!skin) {
      instances.push(`<node id="${g}-node" name="${name}" type="NODE"><matrix sid="transform">${rows(node.getWorldMatrix())}</matrix><instance_geometry url="#${g}">${bind}</instance_geometry></node>`);
      continue;
    }
    const js = skin.listJoints();
    for (const j of js) joints.add(j);
    const ibm = skin.getInverseBindMatrices()!.getArray()!;
    const roots = js.filter((j) => !js.includes(j.getParentNode()!));
    controllers.push(
      `<controller id="${g}-skin"><skin source="#${g}"><bind_shape_matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</bind_shape_matrix>` +
        `<source id="${g}-joints"><Name_array id="${g}-joints-array" count="${js.length}">${js.map((j) => sid(j.getName())).join(' ')}</Name_array><technique_common><accessor source="#${g}-joints-array" count="${js.length}" stride="1"><param name="JOINT" type="name"/></accessor></technique_common></source>` +
        `<source id="${g}-binds"><float_array id="${g}-binds-array" count="${js.length * 16}">${js.map((_, j) => rows(ibm.subarray(j * 16, j * 16 + 16))).join(' ')}</float_array><technique_common><accessor source="#${g}-binds-array" count="${js.length}" stride="16"><param name="TRANSFORM" type="float4x4"/></accessor></technique_common></source>` +
        `<source id="${g}-weights"><float_array id="${g}-weights-array" count="${weights.length}">${list(weights)}</float_array><technique_common><accessor source="#${g}-weights-array" count="${weights.length}" stride="1"><param name="WEIGHT" type="float"/></accessor></technique_common></source>` +
        `<joints><input semantic="JOINT" source="#${g}-joints"/><input semantic="INV_BIND_MATRIX" source="#${g}-binds"/></joints>` +
        `<vertex_weights count="${vcount.length}"><input semantic="JOINT" source="#${g}-joints" offset="0"/><input semantic="WEIGHT" source="#${g}-weights" offset="1"/><vcount>${vcount.join(' ')}</vcount><v>${v.join(' ')}</v></vertex_weights></skin></controller>`,
    );
    instances.push(`<node id="${g}-node" name="${name}" type="NODE"><instance_controller url="#${g}-skin">${roots.map((r) => `<skeleton>#${sid(r.getName())}</skeleton>`).join('')}${bind}</instance_controller></node>`);
  }
  // The skeletons: each root where the scene puts it, each other joint under its parent.
  const joint = (j: Node, top: boolean): string =>
    `<node id="${sid(j.getName())}" sid="${sid(j.getName())}" name="${sid(j.getName())}" type="JOINT"><matrix sid="transform">${rows(top ? j.getWorldMatrix() : j.getMatrix())}</matrix>${j
      .listChildren()
      .filter((c) => joints.has(c))
      .map((c) => joint(c, false))
      .join('')}</node>`;
  const skeletons = [...joints].filter((j) => !joints.has(j.getParentNode()!)).map((j) => joint(j, true));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    '<asset><contributor><authoring_tool>FlatChat format sample (tools/converter/src/source/samples.ts)</authoring_tool></contributor><created>2026-10-18T00:00:00Z</created><modified>2026-10-18T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>',
    effects.length ? `<library_effects>${effects.join('')}</library_effects><library_materials>${materials.join('')}</library_materials>` : '',
    `<library_geometries>${geometries.join('')}</library_geometries>`,
    controllers.length ? `<library_controllers>${controllers.join('')}</library_controllers>` : '',
    `<library_visual_scenes><visual_scene id="Scene" name="Scene">${skeletons.join('')}${instances.join('')}</visual_scene></library_visual_scenes>`,
    '<scene><instance_visual_scene url="#Scene"/></scene>',
    '</COLLADA>\n',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The sample humanoid or the sample cube as a DAE upload. */
export async function sampleDae(kind: 'avatar' | 'prop'): Promise<Uint8Array> {
  return new TextEncoder().encode(await daeOf(kind === 'avatar' ? await sampleAvatar('glb') : await sampleProp(SAMPLE_PROP_DECLARATION)));
}

/** The test tee as a garment made on one body, as another program exports one: its feminine fit
 *  and that body's skeleton alone. */
export async function oneFitTee(): Promise<Uint8Array> {
  const io = avatarIO();
  const doc = await io.readBinary(new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb'))));
  const drop = doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh() && n.getExtras()['flatchat_fit'] !== 'feminine');
  const bones = new Set(drop.flatMap((n) => n.getSkin()?.listJoints() ?? []));
  for (const n of [...drop, ...bones]) n.dispose();
  await doc.transform(prune());
  return io.writeBinary(doc);
}

/** The samples Blender writes, and the format each is in. */
export const BLENDER_SAMPLES = { 'avatar.fbx': 'fbx', 'tee.fbx': 'fbx', 'prop.obj': 'obj', 'prop.blend': 'blend' } as const satisfies Record<string, ModelFrom>;
export type BlenderSample = keyof typeof BLENDER_SAMPLES;

/** The road through Blender: the samples written as FBX, OBJ and .blend into `dir`, then each read
 *  back into a GLB by to-glb.py (the script and flags the core runs). Each sample's file and GLB. */
export async function blenderSamples(blender: string, dir: string): Promise<Record<BlenderSample, { file: string; glb: string }>> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'in-avatar.glb'), await sampleAvatar('glb'));
  writeFileSync(join(dir, 'in-tee.glb'), await oneFitTee());
  writeFileSync(join(dir, 'in-prop.glb'), await sampleProp(SAMPLE_PROP_DECLARATION));
  const scripts = join(ROOT, 'tools', 'blender', 'convert');
  const run = (script: string, args: string[]): void => {
    execFileSync(blender, ['-b', '--factory-startup', '-noaudio', '-Y', '--offline-mode', '--python', join(scripts, script), '--', ...args], { stdio: 'ignore', timeout: 300_000 });
  };
  run('make-samples.py', [join(dir, 'in-avatar.glb'), join(dir, 'in-tee.glb'), join(dir, 'in-prop.glb'), dir, JSON.stringify(SAMPLE_PROP_DECLARATION)]);
  const out: Partial<Record<BlenderSample, { file: string; glb: string }>> = {};
  for (const [name, from] of Object.entries(BLENDER_SAMPLES) as Array<[BlenderSample, ModelFrom]>) {
    const glb = join(dir, `${name.replace('.', '-')}.glb`);
    run('to-glb.py', [join(dir, name), glb, from]);
    out[name] = { file: join(dir, name), glb };
  }
  return out as Record<BlenderSample, { file: string; glb: string }>;
}
