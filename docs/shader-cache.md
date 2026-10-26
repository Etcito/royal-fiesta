Shader inventory: 24 Royal Fiesta assets

The main duplication was different text doing the same work, rather than repeated identical text. There are 102 material records, 48 content keys, and only two material graph structures. The old path registered 116 graph functions including 68 tint variants; 115 were referenced by submeshes. Three passes made those 115 functions into 345 different GPU modules.

| All-assets draw workload | Before modules / distinct WGSL | Before pipelines | After modules / distinct WGSL | After successful pipelines |
| --- | ---: | ---: | ---: | ---: |
| Base graph materials, constants baked in before | 141 | 141 | 6 | 6 |
| Tint-specific graph functions | 204 | 204 | 0 | 0 |
| Standard surface material passes | 3 | 3 | 3 | 3 |
| Fixed RAA passes and uaa | 27 | 44 | 27 | 44 |
| **Total** | **375** | **392** | **36** | **53** |

There were **zero repeated byte-identical modules** in that baseline launch. Of the 345 asset-material texts, **339 were unnecessary data variants**: two graph structures need only six texts across Shadow, Prepass and Forward. CSG trees, operand order/count and field dimensions create **zero asset-specific GPU programs in this game**: MAMA meshes geometry on the CPU, and positions/normals/indices are uploaded as data. Modeler GPU field generation is a separate renderer.

The previous 333-module/350-pipeline normal-game measurement loaded only 20 assets. The table above deliberately loads all 24 cached meshes through the real release renderer and UI, rather than extrapolating from material registrations.

What changed

`materialProgram.ts` replaces graph constant reads with per-material `SurfaceMaterialGpu.p` buffer reads, using RAA 0.3.0's existing positional p0..p7 parameters. Each u32 travels as two exactly representable 16-bit halves, preserving integer, NaN and subnormal bit patterns without float transport loss. Unused words, material names, node-ID comments and tint values do not select code. All 102 current records fit; the largest graph reads 15 words. Graphs requiring over 16 words or constant-reading helpers retain the validated adapter fallback until RAA exposes larger material storage.

Two graph functions are registered once and shared across assets. Colours/constants select material records; tint uses `setInstanceTint`. Material-less parts share a white fallback surface/mesh. The device cache shares exact source, layouts and complete pipeline descriptors, checks full equality, and evicts rejected async requests. The release composer's registration IDs/names are removed from GPU-source diagnostic comments without changing line counts. This game path works with the existing release; it does not require the pending RAA source release from the earlier work.

`prepare()` now uploads data without creating hidden instances or rendering every asset. Before any asset draw, boot creates **26 modules / 42 fixed pipelines**, rather than 375 / 392. Lit pipelines are requested only when the renderer encounters their draws. The async bridge starts explicit-layout lit pipelines in parallel and omits their draws until they resolve, while preserving native behaviour for unrelated and one-shot passes.

Per-launch evidence

`proofs/shader-cache/gpu-launches.json` contains every module's SHA-256 and API-call time, pipeline/module associations, pipeline times and failed async attempts. Baseline used the 22a8e0e SDF port/UI and the same freshly baked 24 meshes. The probe activates all assets at the warmup camera and renders 90 frames. Eight penguin and three podium colours are included. Software WebGPU is Chrome 154 / SwiftShader at 800x600; these are API creation counts and CPU call times, **not hardware GPU completion timings**.

| Launch | Modules / distinct WGSL | Successful pipelines | Total pipeline attempts |
| --- | ---: | ---: | ---: |
| Before, fresh browser profile | 375 | 392 | 392 |
| Before, second page launch | 375 | 392 | 392 |
| After, changed shader source | 36 | 53 | 62 |
| After, browser restarted with the same profile | 36 | 53 | 62 |

All 36 after hashes match across a complete browser restart. Chrome can therefore reuse its persistent cache; direct cache-hit counters are not exposed. Module-call totals were 107.3/115.2 ms before and 7.3/9.4 ms after. Synchronous pipeline-call totals were 22.0/23.6 ms before and 0.9/1.3 ms after. These exclude RAA's CPU composition/validation and cannot establish hardware compilation speed. Independent Node processes also produce the same two material-program hashes; their per-program construction records are in `node-launches.json`.

Remaining backend work

On this RAA device, even a trivial async pipeline rejects with `internal: A valid external Instance reference no longer exists`; a directly created WebGPU device accepts it. Nine lit async requests start in parallel, fail internally, then retry synchronously: **53 created pipelines, 9 failed attempts, 62 calls**. Validation failures remain errors, never silent fallbacks. The all-assets after probe reports no uncaptured GPU validation errors. Browser tests cannot establish hardware behaviour here.

The fixed 44 RAA/UI pipelines still use synchronous creation, including engine features not currently visible. Making every remaining pipeline asynchronous/lazy requires changes to that release's device/backend and feature initialization. Those sources and the SDF Modeler checkout are now outside the writable workspace; they were not changed in this continuation. This work does not claim the entire renderer startup is asynchronous.

Checks: typecheck, the five touched web test files, and guard (including new untracked files). No commit, release or push; no service uses the owner's port 5173.
