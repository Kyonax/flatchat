// SPDX-License-Identifier: MPL-2.0
// Creator shaders in glTF-Transform (S6.03): FLATCHAT_shader on a material, its graph (packages/
// content's shader-graph.ts) and the textures the graph reads, which glTF-Transform would prune and
// renumber without it. Each texture is a real graph edge here, so deduplicating, pruning and
// re-encoding to KTX2 keep the graph reading the right one, and the writer puts back the indices the
// written file has. In a file: material.extensions.FLATCHAT_shader = { graph, textures: [textureInfo] },
// the graph's `texture: k` reading textures[k].
import { Extension, ExtensionProperty, type IProperty, type Material, type Nullable, PropertyType, type ReaderContext, RefMap, type Texture, TextureInfo, type WriterContext } from '@gltf-transform/core';
import { SHADER_EXTENSION, SHADER_LIMITS } from '@flatchat/content';

interface IShaderData extends IProperty {
  /** The graph's JSON, as the file had it (checked by the converter, never run). */
  graph: string;
  textures: RefMap<Texture>;
  infos: RefMap<TextureInfo>;
  count: number;
}

export class ShaderData extends ExtensionProperty<IShaderData> {
  static override EXTENSION_NAME = SHADER_EXTENSION;
  declare extensionName: typeof SHADER_EXTENSION;
  declare propertyType: 'ShaderData';
  declare parentTypes: [PropertyType.MATERIAL];

  protected init(): void {
    this.extensionName = SHADER_EXTENSION;
    this.propertyType = 'ShaderData';
    this.parentTypes = [PropertyType.MATERIAL];
  }

  protected override getDefaults(): Nullable<IShaderData> {
    return Object.assign(super.getDefaults(), { graph: '{}', textures: new RefMap<Texture>(), infos: new RefMap<TextureInfo>(), count: 0 });
  }

  getShader(): unknown {
    return JSON.parse(this.get('graph')) as unknown;
  }
  setShader(graph: unknown): this {
    return this.set('graph', JSON.stringify(graph));
  }
  /** The graph's textures, in order; a slot whose texture is gone is undefined. */
  listTextures(): Array<{ texture: Texture; info: TextureInfo } | undefined> {
    return Array.from({ length: this.get('count') }, (_, k) => {
      const texture = this.getRefMap('textures', String(k));
      const info = this.getRefMap('infos', String(k));
      return texture && info ? { texture, info } : undefined;
    });
  }
  addTexture(texture: Texture | undefined, info: TextureInfo): number {
    const k = this.get('count');
    if (texture) this.setRefMap('textures', String(k), texture);
    this.setRefMap('infos', String(k), info);
    this.set('count', k + 1);
    return k;
  }
}

export class ShaderExtension extends Extension {
  static override readonly EXTENSION_NAME = SHADER_EXTENSION;
  public override readonly extensionName = SHADER_EXTENSION;

  createData(): ShaderData {
    return new ShaderData(this.document.getGraph());
  }

  static of(material: Material): ShaderData | null {
    return material.getExtension<ShaderData>(SHADER_EXTENSION);
  }

  read(context: ReaderContext): this {
    const json = context.jsonDoc.json as unknown as { materials?: Array<{ extensions?: Record<string, unknown> }>; textures?: Array<{ source?: number }> };
    (json.materials ?? []).forEach((m, i) => {
      const def = m.extensions?.[SHADER_EXTENSION] as { graph?: unknown; textures?: unknown } | undefined;
      if (!def || typeof def !== 'object') return;
      const data = this.createData().setShader(def.graph ?? null);
      const list = Array.isArray(def.textures) ? def.textures.slice(0, SHADER_LIMITS.textures) : [];
      for (const t of list) {
        const index = typeof t === 'object' && t !== null ? (t as { index?: unknown }).index : undefined;
        const source = typeof index === 'number' ? json.textures?.[index]?.source : undefined;
        const info = new TextureInfo(this.document.getGraph());
        if (typeof t === 'object' && t !== null) context.setTextureInfo(info, t as never);
        data.addTexture(source === undefined ? undefined : context.textures[source], info);
      }
      context.materials[i]!.setExtension(SHADER_EXTENSION, data);
    });
    return this;
  }

  write(context: WriterContext): this {
    const json = context.jsonDoc.json as unknown as { materials?: Array<{ extensions?: Record<string, unknown> }> };
    for (const material of this.document.getRoot().listMaterials()) {
      const data = ShaderExtension.of(material);
      const index = context.materialIndexMap.get(material);
      if (!data || index === undefined) continue;
      const def = json.materials![index]!;
      def.extensions = def.extensions ?? {};
      def.extensions[SHADER_EXTENSION] = {
        graph: data.getShader(),
        textures: data.listTextures().map((t) => (t && context.imageIndexMap.get(t.texture) !== undefined ? context.createTextureInfoDef(t.texture, t.info) : null)),
      };
    }
    return this;
  }
}
