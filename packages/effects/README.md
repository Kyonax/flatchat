# Effects

FlatChat's effects (Stage 6's S6.01, DR-12): the one Effekseer runtime every client plays effects with, the guard layer that keeps strangers' effects within budget, and the dry run every uploaded effect gets before anyone sees it.

- Licence: Apache-2.0 ([LICENSE](LICENSE)); the runtime in `third_party/effekseer/` keeps its own (MIT, with the licences inside it in its `LICENSE.md`)
- Status: Stage 6. The runtime is pinned at Effekseer 1.80.7 (EffekseerForWeb, built from source: [third_party/effekseer/README.md](third_party/effekseer/README.md))
- The effect format itself (the files, the bundle, the limits) is `packages/content/src/effect.ts`; [docs/effects.md](../../docs/effects.md) is the whole picture

| File | What |
|---|---|
| `src/native.ts` | The runtime's C interface, bound by name; the WebGPU formats it draws into |
| `src/runtime.ts` | `EffectsRuntime`: one running copy of the runtime on WebGPU or WebGL, loading effects from their bundles, playing, placing and drawing them; `RuntimeSpent` once a broken file stops it |
| `src/guard.ts` | `EffectBudget` (admission by the dry run's peaks), `InstanceTrim` (spawning off while an owner is over), `TimeWatch` (GPU and CPU time per effect) |
| `src/stub-gl.ts` | A WebGL2 context that draws nothing and counts what it would have drawn |
| `src/measure.ts` | The dry run's measurement, with web APIs only |

Web APIs only, like every shared package: the client takes `index.ts`, and the dry run's Node side (reading the build from disk, a worker thread with a deadline) is the converter's, `tools/converter/src/effect/dry-run.ts`.
