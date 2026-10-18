// SPDX-License-Identifier: MPL-2.0
// A sample attachment for tests (S5.04, S5.05): a 20 cm cube with the declaration a creator's file
// would carry, rigid (an attachment) or, to be refused, skinned to one bone.
import { Document, NodeIO } from '@gltf-transform/core';

export async function sampleProp(declare: Record<string, unknown>, skinned = false): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const s = 0.1;
  const positions = new Float32Array([-s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s, -s, -s, s, s, -s, s, s, s, s, -s, s, s]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  const prim = doc.createPrimitive().setMaterial(doc.createMaterial('cap').setBaseColorFactor([0.8, 0.2, 0.2, 1])).setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer)).setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  const node = doc.createNode('cap').setMesh(doc.createMesh('cap').addPrimitive(prim));
  if (skinned) {
    const joint = doc.createNode('head');
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(32)).setBuffer(buffer)).setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(32).map((_, i) => (i % 4 === 0 ? 1 : 0))).setBuffer(buffer));
    node.setSkin(doc.createSkin('cap').addJoint(joint));
    doc.createScene('scene').addChild(node).addChild(joint).setExtras({ flatchat_item: declare });
  } else doc.createScene('scene').addChild(node).setExtras({ flatchat_item: declare });
  return new NodeIO().writeBinary(doc);
}
