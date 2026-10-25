# Brick gaps

## raa

`@etcito/raa` 0.1.1 (public API v0, release tarball, WASM included) is a dependency of apps/web. Its gaps for this game:

- One canvas, one camera, no scissor: the port draws a single full-canvas viewport, and refuses any other count. The client page therefore creates ONE canvas and ONE RAA engine per in-page client (`apps/web/src/client/canvases.ts`), laid out in a CSS grid under `main#views`: 1 client = one full view (the default), 2 = side by side, 3 or 4 = 2x2. Each canvas gets one full-canvas viewport. A multi-viewport RAA API would allow one shared canvas, but nothing needs it now.
  - Not yet on this path: `apps/web/src/play/main.ts` (play.html, `?mode=inpage&clients>1`) still draws all clients on one canvas and refuses, and the GPU ops round capture (`apps/web/src/nmc/ops.ts`, `roundCapture` with 4 clients) still asks one port for 4 viewports. Both need the same one-canvas-per-client change.
- Tints: RAA has no per-instance colour. A tinted instance draws every mesh with one cached material of that colour (sRGB, roughness 0.6), so the asset's own colours are not used for tinted beans.
- Course environment (S13): the release's only environment API is `setLight` (one directional light) plus `setAmbient`. `sun {dir, color, intensity}` maps to `setLight`; null restores the port defaults. The rest refuses with `'<field>' not supported by @etcito/raa 0.1.1; brick gap`:
  - `sky`: no sky or background API in @etcito/raa 0.1.1.
  - `fog`: no fog API in @etcito/raa 0.1.1.
  - `post`: no post-processing API in @etcito/raa 0.1.1.
  - `sun` given by name, or any `sun` key other than dir/color/intensity: LightDesc has no named presets or other fields.
- Node has no WebGPU, so the Node proofs (m7-web, m8-hub) record RAA as absent; captures and frame timing come only from a browser run on a GPU.

## raa-sdfm: SDF tour prerequisites

At revision `97861ef`, `apps/web/package.json` has no `@etcito/raa-sdfm` release pin,
and neither `apps/web/src/sdf/sdfPort.ts` nor `apps/web/src/content/providers/sdf.ts`
exists. The GPU tour therefore refuses `content=sdf` with only `v1, v0` available.
The opaque-origin cache and inline-worker fixes are already present in that revision.

Decision Q5 requires the published raa-sdfm release, then cards 5122 (pin), 5129
(renderer adapter), and 5131 (provider), in that order. The follow-up GPU card also
depends on fix card 5212. These prerequisites cannot be replaced by a stub, a local
RAA build, changes to assets, or a mesher fallback.

`tools/m17SdfMatch.ts` checks the release pin and both module paths before invoking
the unchanged m17 GPU record writer. The programmatic command remains a single
argv command. Missing prerequisites fail locally with all missing items listed;
this is a blocked proof, not passing render evidence. Once the prerequisites land,
the same command builds, publishes, renders, and writes the original proof record.

Card 5226 rechecked revision `1183899`: all three prerequisites are still absent,
including from the available history for the two module paths. The authorized
opaque-origin fixes remain present. Card 5221's failure is therefore the expected
prerequisite refusal; changing the GPU command cannot supply the missing runtime.
Card 5227 retains that command, but must wait for the dependency sequence above
and fix card 5212 before it can produce render evidence. Decision Q5 does not
authorize this corrective card to implement or substitute those dependencies.

## raa.prims assets

The 15 files in `fixtures/assets` are raa.prims v0 as published (raa-assets-tools 0.1.0 schema). They were converted from the pre-v0 shape with the same geometry and colliders (collision mode `override`), so the sim is unchanged. `packages/game/test/shippedAssets.test.ts` checks each one with the published validator.

The 11 obstacle recipes published in raa-assets-tools `runs/obstacles-v0` (objects in the asset store, hashes checked) were not adopted: their sizes differ from the sim colliders the courses use (for example the bean body is a 1.4 m capsule, the sim collider is 0.9 m, and the bouncy pad footprint is 2.2 m against a 3 m collider). Adopting them changes gameplay and needs a sim decision first.

The RAA loader cannot run under node: `loadPrimsAsset` is an Engine method and `createEngine` needs WebGPU and a canvas. The browser is the only check of the loader.

## MAMA

MAMA meshes the SDF Modeler documents on the player's client. It is a private repository with no
release tarball, so it is pinned by commit in `bricks.pins.json` and resolved at `.bricks/MAMA` (a
sibling link or a clone made with a build-machine token; docs/bricks.md).

- A public clone has no MAMA: `npm run bricks -- check` prints an INFO line, and typecheck, test,
  build and smoke still pass, because MAMA is reached only through `virtual:rf-mama`, whose public
  target is the typed stub `apps/web/src/mamaAbsent.ts`.
- Without MAMA, only the SDF loading path refuses, at run time, with `MAMA not available: <reason>`.
  Nothing falls back to another mesher or content source.
- MAMA publishes no version: the resolved commit is the version (`__RF_MAMA__`, part of the client
  mesh cache key). A sibling whose HEAD differs from the pin gives a WARN, never a failure.
- A published MAMA release (a tarball like the other bricks) would remove the token, the clone and
  the stub from the public build path.

### quad mesher on the content assets

The committed MAMA pin is `7f198428fdb55e05824d949fa6835cf3695f77ea`
(`bricks.pins.json`). The content survey used the resolved sibling
`864ebc3e0780feb4261f3fa00a5029356045b89e`, which differs from that pin; these
results are not a claim that the pinned checkout was tested. Of the 24 committed
assets, eight mesh: candy.podium-block, candy.seesaw-plank, penguin.body and the
five lowpoly scenery assets (candy.slime-pool, candy.banner, candy.hot-air-balloon,
candy.tower and candy.cloud). The other 16 quad assets are listed below with
MAMA's refusal message or the per-group 300 s timeout.

| Asset | MAMA message / timeout |
| --- | --- |
| `candy.bounce-pad` | group 'candy-bounce-pad' cannot be meshed with Quad mesh (clean) (quad): extract: vertex 33864 at (1.503386, 0.137733, 0.001665) does not project onto the surface (\|F\| = 4.081e-5 > 6.940e-7); extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.checkpoint-gate` | group 'candy-checkpoint-gate' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (19354, 19355) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.conveyor-belt` | timed out after 300 s |
| `candy.finish-arch` | group 'candy-finish-arch' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (11565, 26709) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.floor-disc` | group 'Floor Disc' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (46018, 46025) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.floor-tile` | timed out after 300 s |
| `candy.moving-platform` | group 'Moving Platform' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (33939, 33940) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.pendulum-hammer` | group 'Pendulum Hammer' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (598, 599) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.plaza-fountain` | timed out after 300 s |
| `candy.queue-pad` | group 'candy-queue-pad' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (22890, 22891) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.rotating-door` | timed out after 300 s |
| `candy.spinner-bar` | group 'Spinner Bar' cannot be meshed with Quad mesh (clean) (quad): extract: vertex 77122 at (-0.473927, 0.341803, -0.288762) does not project onto the surface (\|F\| = 7.881e-5 > 1.253e-6); extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `candy.wall-block` | timed out after 300 s |
| `costume.fish-scarf` | group 'fish_scarf' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (30227, 30237) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `costume.pineapple-suit` | group 'pineapple_suit' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (18823, 18946) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |
| `costume.propeller-hat` | group 'propeller_hat' cannot be meshed with Quad mesh (clean) (quad): extract: the mesh is not 2-manifold: Edge (6615, 6637) is used by 4 triangles; extract again with a smaller cellSize (e.g. half the current one, or baseCellSize with a shorter edgeLength) |

The fix comes from an upstream MAMA update followed by a pin bump in
`bricks.pins.json`, or the content project re-saving the assets and regenerating
its views records in SDF Modeler. This repository does not patch MAMA, change
asset meshers or params, retry, or fall back. The m17 mesh-node check keeps its
full 24/24 threshold and fails until those assets mesh.

## ui font upload

`@etcito/raa-assets-tools` 0.1.0 has no remote put: `raa-assets put` only writes a local store
(`--store <dir>`). `tools/uiFont.ts upload` therefore stages the WOFF2 with
`raa-assets put --store out/font-store`, then publishes the staged object to
https://assets.etcito.com over SSH (scp-form `ASSET_STORE_SSH`, private key path in
`ASSET_STORE_KEY`), and verifies the object URL. A remote put in the CLI would remove the SSH step.
