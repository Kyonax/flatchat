// SPDX-License-Identifier: MPL-2.0
// VRM 1.0 inside glTF-Transform (DR-15). glTF-Transform drops extensions it does not know, so the
// avatar converter registers this one: it reads VRMC_vrm (meta, humanoid, expressions, first
// person, look-at), VRMC_springBone, and each material's VRMC_materials_mtoon and each node's
// VRMC_node_constraint, and keeps them as one property whose every reference to a node, a
// material or a texture is a real graph edge. The converter's work (deduplicating, welding,
// simplifying, flipping axes) therefore keeps the VRM data pointing at the right things, and the
// writer puts back the indices the written file has. A VRM 0.x file is migrated to this shape
// before it is read (vrm0.ts).
import { Extension, ExtensionProperty, type IProperty, type Material, type Node, type Nullable, PropertyType, type ReaderContext, RefMap, type Texture, TextureInfo, type WriterContext } from '@gltf-transform/core';

export const VRMC_VRM = 'VRMC_vrm';
export const VRMC_SPRING_BONE = 'VRMC_springBone';
export const VRMC_MTOON = 'VRMC_materials_mtoon';
export const VRMC_NODE_CONSTRAINT = 'VRMC_node_constraint';
export const VRMC_HDR_EMISSIVE = 'VRMC_materials_hdr_emissiveMultiplier';
/** The VRM extensions this converter reads and writes; any other VRM extension is dropped. */
export const VRM_EXTENSIONS = [VRMC_VRM, VRMC_SPRING_BONE, VRMC_MTOON, VRMC_NODE_CONSTRAINT, VRMC_HDR_EMISSIVE] as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A slot in the property's lists, standing in the JSON for a glTF index. */
type Slot = { $node: number } | { $material: number } | { $image: number } | { $texture: number; texCoord?: number; extensions?: JsonObject };

interface IVRMData extends IProperty {
  /** The VRM JSON with every glTF index replaced by a slot (see Slot). */
  json: string;
  /** Slot number to property: maps, so a property removed (a node disposed) leaves the other
   *  slots where they were. */
  nodes: RefMap<Node>;
  materials: RefMap<Material>;
  /** Images (glTF-Transform's Texture) referenced as images (meta.thumbnailImage). */
  images: RefMap<Texture>;
  /** Textures referenced through texture infos (MToon's), with their sampler and coordinates. */
  textures: RefMap<Texture>;
  textureInfos: RefMap<TextureInfo>;
  /** The next free slot number (slots are never reused). */
  next: number;
}

/** The shape kept in IVRMData.json. */
export interface VRMDocument {
  vrm: JsonObject;
  springBone?: JsonObject;
  /** Per material slot: its VRMC_materials_mtoon and VRMC_materials_hdr_emissiveMultiplier. */
  materials: Record<string, JsonObject>;
  /** Per node slot: its VRMC_node_constraint. */
  constraints: Record<string, JsonObject>;
}

export class VRMData extends ExtensionProperty<IVRMData> {
  static override EXTENSION_NAME = VRMC_VRM;
  declare extensionName: typeof VRMC_VRM;
  declare propertyType: 'VRMData';
  declare parentTypes: [PropertyType.ROOT];

  protected init(): void {
    this.extensionName = VRMC_VRM;
    this.propertyType = 'VRMData';
    this.parentTypes = [PropertyType.ROOT];
  }

  protected override getDefaults(): Nullable<IVRMData> {
    return Object.assign(super.getDefaults(), {
      json: '{"vrm":{},"materials":{},"constraints":{}}',
      nodes: new RefMap<Node>(),
      materials: new RefMap<Material>(),
      images: new RefMap<Texture>(),
      textures: new RefMap<Texture>(),
      textureInfos: new RefMap<TextureInfo>(),
      next: 0,
    });
  }

  getDocument(): VRMDocument {
    return JSON.parse(this.get('json')) as VRMDocument;
  }
  setDocument(doc: VRMDocument): this {
    return this.set('json', JSON.stringify(doc));
  }
  /** The property in a slot (undefined once it was removed). */
  node(slot: number): Node | undefined {
    return this.getRefMap('nodes', String(slot)) ?? undefined;
  }
  material(slot: number): Material | undefined {
    return this.getRefMap('materials', String(slot)) ?? undefined;
  }
  image(slot: number): Texture | undefined {
    return this.getRefMap('images', String(slot)) ?? undefined;
  }
  texture(slot: number): { texture: Texture; info: TextureInfo } | undefined {
    const texture = this.getRefMap('textures', String(slot));
    const info = this.getRefMap('textureInfos', String(slot));
    return texture && info ? { texture, info } : undefined;
  }
  listNodes(): Node[] {
    return this.listRefMapValues('nodes');
  }
  private slotOf<K extends 'nodes' | 'materials' | 'images'>(map: K, value: Node | Material | Texture): number {
    for (const key of this.listRefMapKeys(map)) if (this.getRefMap(map, key) === value) return Number(key);
    const slot = this.get('next');
    this.set('next', slot + 1);
    this.setRefMap(map, String(slot), value as never);
    return slot;
  }
  addNode(node: Node): number {
    return this.slotOf('nodes', node);
  }
  addMaterial(material: Material): number {
    return this.slotOf('materials', material);
  }
  addImage(texture: Texture): number {
    return this.slotOf('images', texture);
  }
  addTexture(texture: Texture, info: TextureInfo): number {
    const slot = this.get('next');
    this.set('next', slot + 1);
    this.setRefMap('textures', String(slot), texture);
    this.setRefMap('textureInfos', String(slot), info);
    return slot;
  }

  /** The humanoid bone a node stands for, if any. */
  humanBones(): Map<string, Node> {
    const bones = ((this.getDocument().vrm['humanoid'] as JsonObject | undefined)?.['humanBones'] ?? {}) as Record<string, { node: Slot }>;
    const out = new Map<string, Node>();
    for (const [name, b] of Object.entries(bones)) {
      const slot = b?.node as { $node?: number } | undefined;
      const node = slot?.$node === undefined ? undefined : this.node(slot.$node);
      if (node) out.set(name, node);
    }
    return out;
  }
}

/** Walks JSON, replacing every value `replace` answers for. */
function mapJson(value: Json | undefined, replace: (v: Json, key: string, parent: JsonObject | Json[]) => Json | undefined): Json | undefined {
  if (value === undefined) return undefined;
  const walk = (v: Json, key: string, parent: JsonObject | Json[]): Json => {
    const r = replace(v, key, parent);
    if (r !== undefined) return r;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, String(i), v));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, v)]));
    return v;
  };
  return walk(value, '', []);
}

/** VRM 1.0's schema forbids empty arrays where a list is optional: such keys are left out. */
function dropEmpty(value: Json | undefined): Json | undefined {
  if (Array.isArray(value)) return value.map((v) => dropEmpty(v)!).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const d = dropEmpty(v);
      if (d === undefined || d === null) continue;
      if (Array.isArray(d) && d.length === 0) continue;
      if (typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 0) continue;
      out[k] = d;
    }
    return out;
  }
  return value;
}

const TEXTURE_KEYS = new Set([
  'shadeMultiplyTexture',
  'shadingShiftTexture',
  'matcapTexture',
  'rimMultiplyTexture',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
]);

export class VRMExtension extends Extension {
  static override readonly EXTENSION_NAME = VRMC_VRM;
  public override readonly extensionName = VRMC_VRM;

  createData(): VRMData {
    return new VRMData(this.document.getGraph());
  }

  /** The document's VRM data, if it has any. */
  static of(root: { getExtension<T>(name: string): T | null }): VRMData | null {
    return root.getExtension<VRMData>(VRMC_VRM);
  }

  read(context: ReaderContext): this {
    const json = context.jsonDoc.json as unknown as {
      extensions?: Record<string, Json>;
      materials?: Array<{ extensions?: Record<string, Json> }>;
      nodes?: Array<{ extensions?: Record<string, Json> }>;
      textures?: Array<{ source?: number }>;
    };
    const vrm = json.extensions?.[VRMC_VRM];
    if (!vrm || typeof vrm !== 'object' || Array.isArray(vrm)) return this;
    const data = this.createData();
    const node = (i: Json): Slot | undefined => (typeof i === 'number' && context.nodes[i] ? { $node: data.addNode(context.nodes[i]!) } : undefined);
    const material = (i: Json): Slot | undefined => (typeof i === 'number' && context.materials[i] ? { $material: data.addMaterial(context.materials[i]!) } : undefined);
    const image = (i: Json): Slot | undefined => (typeof i === 'number' && context.textures[i] ? { $image: data.addImage(context.textures[i]!) } : undefined);
    const texture = (def: Json): Slot | undefined => {
      if (!def || typeof def !== 'object' || Array.isArray(def) || typeof def['index'] !== 'number') return undefined;
      const source = json.textures?.[def['index']]?.source;
      const tex = source === undefined ? undefined : context.textures[source];
      if (!tex) return undefined;
      const info = new TextureInfo(this.document.getGraph());
      context.setTextureInfo(info, def as never);
      const slot: Slot = { $texture: data.addTexture(tex, info) };
      if (typeof def['texCoord'] === 'number') slot.texCoord = def['texCoord'];
      if (def['extensions'] && typeof def['extensions'] === 'object' && !Array.isArray(def['extensions'])) slot.extensions = def['extensions'];
      return slot;
    };
    // Every reference in VRMC_vrm and VRMC_springBone is a node, a material or an image.
    const refs = (v: Json, key: string): Json | undefined => {
      if (key === 'node' || key === 'center') return (node(v) as Json | undefined) ?? null;
      if (key === 'material') return (material(v) as Json | undefined) ?? null;
      if (key === 'thumbnailImage') return (image(v) as Json | undefined) ?? null;
      return undefined;
    };
    const doc: VRMDocument = { vrm: mapJson(vrm, refs) as JsonObject, materials: {}, constraints: {} };
    const spring = json.extensions?.[VRMC_SPRING_BONE];
    if (spring && typeof spring === 'object' && !Array.isArray(spring)) doc.springBone = mapJson(spring, refs) as JsonObject;
    (json.materials ?? []).forEach((m, i) => {
      const mtoon = m.extensions?.[VRMC_MTOON];
      const hdr = m.extensions?.[VRMC_HDR_EMISSIVE];
      if (!mtoon && !hdr) return;
      const kept: JsonObject = {};
      if (mtoon) kept[VRMC_MTOON] = mapJson(mtoon, (v, key) => (TEXTURE_KEYS.has(key) ? ((texture(v) as Json | undefined) ?? null) : undefined)) as Json;
      if (hdr) kept[VRMC_HDR_EMISSIVE] = hdr;
      doc.materials[String(data.addMaterial(context.materials[i]!))] = kept;
    });
    (json.nodes ?? []).forEach((n, i) => {
      const c = n.extensions?.[VRMC_NODE_CONSTRAINT];
      if (c) doc.constraints[String(data.addNode(context.nodes[i]!))] = mapJson(c, (v, key) => (key === 'source' ? ((node(v) as Json | undefined) ?? null) : undefined)) as JsonObject;
    });
    data.setDocument(doc);
    this.document.getRoot().setExtension(VRMC_VRM, data);
    return this;
  }

  write(context: WriterContext): this {
    const data = this.document.getRoot().getExtension<VRMData>(VRMC_VRM);
    if (!data) return this;
    const json = context.jsonDoc.json as unknown as {
      extensions?: Record<string, Json>;
      extensionsUsed?: string[];
      materials?: Array<{ extensions?: Record<string, Json> }>;
      nodes?: Array<{ extensions?: Record<string, Json> }>;
    };
    const at = <T>(m: Map<T, number>, v: T | undefined): number | null => (v === undefined ? null : (m.get(v) ?? null));
    // A reference to something no longer written becomes null, and dropEmpty leaves it out.
    const back = (v: Json): Json | undefined => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
      if (typeof v['$node'] === 'number') return at(context.nodeIndexMap, data.node(v['$node']));
      if (typeof v['$material'] === 'number') return at(context.materialIndexMap, data.material(v['$material']));
      if (typeof v['$image'] === 'number') return at(context.imageIndexMap, data.image(v['$image']));
      if (typeof v['$texture'] === 'number') {
        const t = data.texture(v['$texture']);
        if (!t || context.imageIndexMap.get(t.texture) === undefined) return null;
        const def = context.createTextureInfoDef(t.texture, t.info) as unknown as JsonObject;
        if (typeof v['texCoord'] === 'number' && v['texCoord'] !== 0) def['texCoord'] = v['texCoord'];
        if (v['extensions'] && typeof v['extensions'] === 'object') def['extensions'] = v['extensions'];
        return def;
      }
      return undefined;
    };
    const doc = data.getDocument();
    json.extensions = json.extensions ?? {};
    json.extensions[VRMC_VRM] = dropEmpty(mapJson(doc.vrm, back)) as Json;
    const used = new Set(json.extensionsUsed ?? []);
    used.add(VRMC_VRM);
    if (doc.springBone) {
      json.extensions[VRMC_SPRING_BONE] = dropEmpty(mapJson(doc.springBone, back)) as Json;
      used.add(VRMC_SPRING_BONE);
    }
    for (const [slot, ext] of Object.entries(doc.materials)) {
      const index = at(context.materialIndexMap, data.material(Number(slot)));
      if (index === null) continue;
      const def = json.materials![index]!;
      def.extensions = def.extensions ?? {};
      for (const [name, value] of Object.entries(ext)) {
        def.extensions[name] = dropEmpty(mapJson(value, back)) as Json;
        used.add(name);
      }
    }
    for (const [slot, c] of Object.entries(doc.constraints)) {
      const index = at(context.nodeIndexMap, data.node(Number(slot)));
      if (index === null) continue;
      const def = json.nodes![index]!;
      def.extensions = def.extensions ?? {};
      def.extensions[VRMC_NODE_CONSTRAINT] = mapJson(c, back) as Json;
      used.add(VRMC_NODE_CONSTRAINT);
    }
    json.extensionsUsed = [...used];
    return this;
  }
}
