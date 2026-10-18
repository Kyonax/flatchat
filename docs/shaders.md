# Creator shaders

Creators can give an avatar's material a look of their own (Stage 6's S6.03, Q-M12), as VRChat allows, with the risks that brings (T-01, cl-007): one shader can stall a weak GPU or flash a room full of people. FlatChat takes them as **data, never code**, and keeps the risks small:

- A shader is a node graph in a fixed language that has no loops and no way to run anything, checked at upload and checked again by every client.
- Every material with a shader keeps its own look as the **fallback**, and most viewers see that.
- Its cost is counted at upload and lowers the avatar's rank.
- After one GPU reset, every creator shader stays off until the client restarts.

Creator shaders are for avatars' materials. Effekseer's own material files (`.efkmat`, its node-graph shaders) stay refused in effects: the effects runtime compiles them itself, outside these checks ([effects](effects.md)).

## The graph

A material carries its graph in the glTF extension `FLATCHAT_shader`:

```json
"extensions": {
  "FLATCHAT_shader": {
    "graph": {
      "format": 1,
      "nodes": [
        { "id": "rim", "op": "fresnel", "in": { "power": 2.5 } },
        { "id": "pulse", "op": "oscillate", "in": {}, "with": { "hz": 0.5 } },
        { "id": "amount", "op": "mul", "in": { "a": "rim", "b": "pulse" } },
        { "id": "glow", "op": "mul", "in": { "a": [0.1, 0.9, 1], "b": "amount" } }
      ],
      "out": { "emissive": "glow" }
    },
    "textures": [{ "index": 0 }]
  }
}
```

Each node has an `id`, an operation (`op`), its inputs (`in`: another node's id, a number, or a vector of 2 to 4 numbers) and the operation's fixed settings (`with`). The graph sets a surface's `color` (vec3 or vec4), its glow (`emissive`, vec3) and its `opacity` (float); `textures[k]` is what a `texture` node with `texture: k` reads.

| Kind | Operations |
|---|---|
| The surface | `uv`, `normal`, `position`, `viewDir`, `fresnel` (with an optional `power`) |
| Time | `oscillate` (`hz` 0 to 2; `shape` sine, triangle, saw or square): a value between 0 and 1, never the raw clock |
| Textures | `texture` (one of the material's own, at a uv), `noise` (at a vec2 or vec3) |
| Arithmetic | `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `step`, `sin`, `cos`, `abs`, `fract`, `floor`, `sqrt`, `saturate`, `oneMinus`, `negate`, `mix`, `clamp`, `smoothstep`, `dot`, `length`, `normalize` |
| Vectors | `split` (`c` one of x, y, z, w), `combine` (2 to 4 floats) |

The rules are `packages/content/src/shader-graph.ts` (`checkShaderGraph`, `SHADER_OPS`, `SHADER_LIMITS`), with a reference evaluator (`evaluateShaderGraph`) that computes what the client's shader computes.

## Why a graph cannot hurt

| A hostile shader tries | What stops it |
|---|---|
| An endless loop | There is no loop: the nodes may not form a cycle |
| A compile bomb | 128 nodes at most, 48 deep, 64 KB of JSON; the client holds each node in a variable, so the code three.js writes grows with the graph, never faster |
| A flood of texture reads | 8 at most |
| A NaN or an infinity | Every operation is safe over its whole domain (a division by nearly zero, a root or a power of a negative number, normalising nothing, a smoothstep with equal edges), every node's value is kept within ±1,000,000 so float32 cannot overflow, and every output is clamped (colour and opacity to 0..1, glow to 0..2) |
| A strobe | Time comes only through two oscillators of at most 2 Hz each. A graph can still pulse; strangers do not see it unless the viewer allows them, and the safe-mode key clears it |
| Anything outside its own mesh | A graph sets only its surface's colour, glow and opacity: no vertex positions, no screen-space effects |
| A heavy shader | Its cost is counted (a texture read 4, noise 10, most arithmetic 1): 400 at most for one graph and 800 for an avatar's, and the cost lowers the rank (50 for excellent, 150 good, 300 medium, 600 poor) |

`packages/content/test/shader-graph.test.ts` runs 20 hostile graphs: the ones that loop, explode, flood or strobe are refused, and those that try NaN storms give only finite values in range.

## At upload

The avatar converter (`tools/converter/src/avatar/shader.ts`, `convert.ts`, converter 1.4.0) reads `FLATCHAT_shader` as a glTF-Transform extension, so the textures a graph reads survive deduplication, pruning and KTX2 the same as any other. Then it:

1. checks each graph, refusing the avatar with every reason;
2. checks the textures a graph reads are in its list;
3. requires the material's own look as a fallback: MToon, a base colour, or a base colour texture;
4. counts the cost into the rank (`stats.shaderCost`), and the manifest says how many materials have one (`shaders`);
5. keeps the graphs on the full avatar (LOD0) only: LOD1, LOD2 and the impostor are drawn with the fallback.

## In the client

The loader checks each graph again (the client trusts no file) and leaves it on its material (`world/avatar-loader.ts`). The avatar layer turns a graph into a three.js node material only when it is first wanted (`world/creator-shader.ts`), and swaps between it and the fallback as the viewer's policy says:

| Whose | Shows the creator shader |
|---|---|
| The viewer's own | always |
| A friend's | yes |
| A stranger's | only when the viewer allows it in the settings ("Show strangers' creator shaders"), never on the low tier, never when the trust shield covers them |
| Anyone's | never in safe mode (Shift+Esc), and never after a GPU reset |

**A GPU reset.** When the driver loses the device (`world/gpu-reset.ts`: WebGPU's `device.lost`, WebGL's `webglcontextlost`), the client counts it, joins the same world again at once with a fresh renderer, and keeps every creator shader off until it restarts (Windows bug-checks a machine after five GPU hangs within a minute, rr-008).

## Tests

- `packages/content/test/shader-graph.test.ts`: a graph's order, types, cost and textures; the 20 hostile graphs.
- `tools/converter/test/shader.test.ts`: a graph kept on the full avatar with its texture, left off the lower levels, counted into the rank; a graph that loops, one reading a texture it does not list, and a material with no fallback refused.
- `apps/client/test/creator-shader.test.ts`: every operation builds a node material; the outputs land in its slots.
- The look check (`tools/bots/src/look-check.ts`, the client's `--crowd-look=1`, in CI): an avatar with a rim glow drawn with its fallback, then with its shader made for this GPU (WebGPU here, WebGL2 in CI's software renderer), a few moments apart: it builds, it draws, it changes the picture.
- End to end: at the end the test loses the GPU device as a driver reset would; the client joins the world again with a fresh renderer and counts the reset, so creator shaders stay off.
