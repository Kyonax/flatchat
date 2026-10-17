// SPDX-License-Identifier: MPL-2.0
// The proxy tier's skeleton (pure): the plan's impostor keeps about 20 bones (ASSETs AND
// CONVERSION), so every joint that is not a humanoid bone (hair, skirts, accessories) hands its
// skin weights to its nearest humanoid ancestor, and each vertex keeps its four largest weights.

/** For each joint, the index of its nearest kept ancestor in `kept` order (itself if kept); −1 if none. */
export function nearestKept(parents: ArrayLike<number>, kept: readonly number[]): Int32Array {
  const keptIndex = new Map(kept.map((j, i) => [j, i]));
  const out = new Int32Array(parents.length).fill(-1);
  for (let j = 0; j < parents.length; j++) {
    let at = j;
    for (let guard = 0; at >= 0 && guard <= parents.length; guard++) {
      const k = keptIndex.get(at);
      if (k !== undefined) {
        out[j] = k;
        break;
      }
      at = parents[at] ?? -1;
    }
  }
  return out;
}

/** Four joints and weights per vertex, mapped through `map`; merged, the largest four kept, normalized. */
export function remapSkin(index: ArrayLike<number>, weight: ArrayLike<number>, map: Int32Array): { index: Uint16Array; weight: Float32Array } {
  const vertices = Math.floor(index.length / 4);
  const outIndex = new Uint16Array(vertices * 4);
  const outWeight = new Float32Array(vertices * 4);
  const merged = new Map<number, number>();
  for (let v = 0; v < vertices; v++) {
    merged.clear();
    for (let k = 0; k < 4; k++) {
      const w = weight[v * 4 + k] ?? 0;
      if (w <= 0) continue;
      const to = map[index[v * 4 + k] ?? 0] ?? -1;
      if (to < 0) continue;
      merged.set(to, (merged.get(to) ?? 0) + w);
    }
    const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0);
    top.forEach(([j, w], k) => {
      outIndex[v * 4 + k] = j;
      outWeight[v * 4 + k] = total > 0 ? w / total : 0;
    });
    if (top.length === 0) outWeight[v * 4] = 1;
  }
  return { index: outIndex, weight: outWeight };
}
