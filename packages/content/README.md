# Content

FlatChat's content formats, shared by every program: the world format's manifest (`world.toml`) and the markers its glTF scenes carry, and the validator that checks a world folder before anyone hosts or downloads it. Avatar manifests, the rank and budget tables come with Stage 4.

- Licence: Apache-2.0 ([LICENSE](LICENSE))
- Status: Stage 2. The world format, version 1 ([docs/world-format.md](../../docs/world-format.md)), and its validator.
- Web APIs only (like `packages/protocol`): the same code runs in the world server, the client, the host tool and the core.

| File | What |
|---|---|
| `src/manifest.ts` | `parseManifest`: `world.toml` field by field, unknown keys as warnings; `safePath`, `plainText` |
| `src/scene.ts` | `readGltf` (GLB or JSON), world transforms, `inspectScene`: spawn points, seats, solids, sounds, portals, zones, triangles, limits |
| `src/validate.ts` | `validateWorld(files)`: a folder's files in, the manifest, the scenes and every problem out; `imageSize` from PNG, JPEG and WebP headers |

Every problem has a code, a severity (`error` refuses the world), a file, a place in it and a sentence.
