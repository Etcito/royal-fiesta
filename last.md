# Royal Fiesta field shading

Branch `g7-sol62-field-grad` starts at `0e61d08`.

| Commit | Subject |
| --- | --- |
| `1c3f027c4a503db18a9f48808a254801bcef23a2` | Evaluate field gradients in one raster-position traversal |
| `b633d6c625852d5705d9cc97c0d5656eec8c69d5` | Apply live shading and texture bakes to round ports |

## Traversals per shaded fragment

The forward and prepass counts are identical. Let `G` be the number of sampled grid leaves in the hit part's postfix field program. The saved penguin has `G = 15`.

| Material drawing the part | Field traversals in each lit pass | Grid atlas samples in each lit pass |
| --- | --- | --- |
| `mama.field-program`, default gradient | `1` at the rasterized rest position | `1 × G × 8`, or `120` for the penguin |
| `mama.field-program`, `?fieldnormals=taps` | `2 × (1 center + 6 taps) = 14` with one bounded Newton step between the two evaluations | `14 × G × 8`, or `1,680` for the penguin |
| Textured part | `0` | `0` field-grid samples. The worker-baked material reads base color, tangent-space normal and ORM. |
| Vertex part | `0` | `0` |

The gradient path differentiates the same eight decoded distances used for trilinear interpolation and propagates the derivatives through the operand transforms and CSG stack. The same traversal supplies the label weights. It uses the interpolated mesh normal within 1% of a voxel width on either side of a lattice plane in a contributing grid, for gradients of length at most `1e-6` or nonfinite length, and outside the part bounds. [Field evaluator and traversal counts](apps/web/src/sdf/fieldShading.ts#L379)

Earlier saved `shading` records still use RAA's shared evaluator. That path normally performs one `pmf_eval` per lit pass, with up to 31 additional module evaluations if the record's relief feature runs.

Rounds now use the shared SDF provider for live settings, cosmetic skins and worker bakes. Vertex remains the unsaved default for `?engine=1`. The perf overlay follows the last rendering port and shows visible instance-part counts for field, textured and vertex members, along with pending work and refusal reasons. Player-color graphs keep their field or vertex draw when the bake lacks a player-color mask. [Round provider](apps/web/src/zone/zoneContent.ts#L45) · [Perf overlay](apps/web/src/sdf/sdfPort.ts#L1297)

## Verification

| Test file | Result |
| --- | --- |
| [fieldShadingGradient.test.ts](apps/web/test/fieldShadingGradient.test.ts) | 4 passed. CPU execution of the generated WGSL checked against independent finite differences on quantized grids, rounded boxes and CSG. |
| [fieldShading.test.ts](apps/web/test/fieldShading.test.ts) | 25 passed. Covers saved programs, shader generation, the taps variant and fallbacks. |
| [sdfTint.test.ts](apps/web/test/sdfTint.test.ts) | 8 targeted tests passed. Covers round routing, live and URL settings, bake installation, pending/refusal overlay output and skinned/tinted texture behavior. |

```sh
node --experimental-strip-types --test apps/web/test/fieldShadingGradient.test.ts apps/web/test/fieldShading.test.ts
node --experimental-strip-types --test --test-name-pattern='baked texture:|round shading|game render options|\?normals=vertex' apps/web/test/sdfTint.test.ts
```

RAA `e8f8577` registered and validated both generated penguin shaders with Naga on the CPU for forward and prepass. The web typecheck reported the same four dependency errors on the baseline and the branch, involving the UAA overlay export, `EngineDomainOptions.inputPlayers` and `RollbackBinding.stepCodes`.

## Real GPU comparison

GPU timing, in-round worker bake completion, and the appearance of highlights and label boundaries remain unverified. On the same GPU, use the same round, camera, resolution, RAA WASM and settings. After shader preparation settles, read the **GPU ms per frame** entries for `raa.lit.forward` and `raa.lit.prepass` in `?perf=1`.

| Run | URL query |
| --- | --- |
| Baseline before implementation | `?engine=1&perf=1&normals=field`. On the baseline, also set `&shading=field` to override a saved Vertex choice. |
| Gradient on this branch | `?engine=1&perf=1&normals=field` |
| Taps on this branch | `?engine=1&perf=1&normals=field&fieldnormals=taps` |

Compare the field, textured and vertex counts alongside the timings. A baked-mode run can still draw field or vertex members while baking or when a bake is refused.
