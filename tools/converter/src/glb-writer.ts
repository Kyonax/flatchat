// SPDX-License-Identifier: MPL-2.0
// A small GLB writer for worlds made in code (the plaza, test worlds, plans built from SVG): meshes
// of triangles with flat colours, or textured, with vertex colours (baked light) and an emissive
// glow; nodes with any extensions (glTF-Transform would drop the OMI and FlatChat ones), and
// document-level extensions. What a mesh leaves out is left out of the file, so the plain worlds'
// files stay as they were.

export interface MeshSpec {
  positions: number[];
  normals: number[];
  indices: number[];
  /** Linear RGBA. */
  colour: [number, number, number, number];
  name: string;
  /** Texture coordinates, two a vertex, for `texture`. */
  uvs?: number[];
  /** Vertex colours, linear RGB, three a vertex: they multiply the colour (light baked in). */
  colours?: number[];
  /** An image of `writeGlb`'s `images`, repeated. */
  texture?: number;
  /** Linear RGB light of its own, and the image that carries it. */
  emissive?: [number, number, number];
  emissiveTexture?: number;
}

/** An image the meshes use, inside the file. */
export interface ImageSpec {
  name: string;
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

export interface NodeSpec {
  name: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  mesh?: number;
  extensions?: Record<string, unknown>;
}

export function writeGlb(meshes: readonly MeshSpec[], nodes: readonly NodeSpec[], extensions: Record<string, unknown> = {}, extensionsUsed: string[] = [], images: readonly ImageSpec[] = []): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const view = (bytes: Uint8Array, target: number): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    chunks.push(bytes);
    // An image's view names no target.
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    offset += bytes.length;
    return bufferViews.length - 1;
  };
  const gltfMeshes = meshes.map((m) => {
    const pos = new Float32Array(m.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, pos[i + k]!);
      max[k] = Math.max(max[k]!, pos[i + k]!);
    }
    accessors.push({ bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const p = accessors.length - 1;
    accessors.push({ bufferView: view(new Uint8Array(new Float32Array(m.normals).buffer), 34962), componentType: 5126, count: m.normals.length / 3, type: 'VEC3' });
    const n = accessors.length - 1;
    const attributes: Record<string, number> = { POSITION: p, NORMAL: n };
    if (m.uvs) {
      accessors.push({ bufferView: view(new Uint8Array(new Float32Array(m.uvs).buffer), 34962), componentType: 5126, count: m.uvs.length / 2, type: 'VEC2' });
      attributes['TEXCOORD_0'] = accessors.length - 1;
    }
    if (m.colours) {
      accessors.push({ bufferView: view(new Uint8Array(new Float32Array(m.colours).buffer), 34962), componentType: 5126, count: m.colours.length / 3, type: 'VEC3' });
      attributes['COLOR_0'] = accessors.length - 1;
    }
    accessors.push({ bufferView: view(new Uint8Array(new Uint32Array(m.indices).buffer), 34963), componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    const i = accessors.length - 1;
    return { name: m.name, primitives: [{ attributes, indices: i, material: meshes.indexOf(m) }] };
  });
  const imageViews = images.map((img) => view(img.bytes, 0));
  const bin = new Uint8Array(Math.ceil(offset / 4) * 4);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length;
  }
  const json = {
    asset: { version: '2.0', generator: 'FlatChat glb-writer' },
    ...(extensionsUsed.length ? { extensionsUsed } : {}),
    scene: 0,
    scenes: [{ nodes: nodes.map((_, k) => k) }],
    nodes,
    // A scene of markers only (a world built from base parts) has no meshes and no buffer: glTF
    // allows neither an empty array nor an empty buffer.
    ...(meshes.length
      ? {
          meshes: gltfMeshes,
          materials: meshes.map((m) => ({
            name: m.name,
            pbrMetallicRoughness: { baseColorFactor: m.colour, metallicFactor: 0, roughnessFactor: 0.9, ...(m.texture !== undefined ? { baseColorTexture: { index: m.texture } } : {}) },
            ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
            ...(m.emissiveTexture !== undefined ? { emissiveTexture: { index: m.emissiveTexture } } : {}),
          })),
          ...(images.length
            ? {
                images: images.map((img, k) => ({ name: img.name, mimeType: img.mimeType, bufferView: imageViews[k] })),
                samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
                textures: images.map((_, k) => ({ sampler: 0, source: k })),
              }
            : {}),
          accessors,
          bufferViews,
          buffers: [{ byteLength: bin.length }],
        }
      : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(text.length / 4) * 4;
  const binChunk = bin.length > 0 ? 8 + bin.length : 0;
  const total = 12 + 8 + jsonLen + binChunk;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (binChunk) {
    v.setUint32(20 + jsonLen, bin.length, true);
    v.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
  }
  return out;
}

/** One box's 24 vertices and 36 indices, appended to a mesh. */
export function addBox(mesh: Pick<MeshSpec, 'positions' | 'normals' | 'indices'>, min: [number, number, number], max: [number, number, number]): void {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: Array<[[number, number, number], Array<[number, number, number]>]> = [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  for (const [n, vs] of faces) {
    const base = mesh.positions.length / 3;
    for (const p of vs) {
      mesh.positions.push(...p);
      mesh.normals.push(...n);
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
