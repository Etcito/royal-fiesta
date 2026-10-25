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
- `@etcito/raa-sdfm` cannot upload MAMA meshes on the published `@etcito/raa`. Both published raa-sdfm tarballs (`raa-sdfm-v0.1.0`, pinned in apps/web; and `raa-sdfm-v0.1.1`, whose `index.d.ts` and `index.js` are identical and which only drops the manifest's peer dependencies) are built against RAA's m07/m10 mesh and material API: `Engine.addMesh`, `addMeshInstance`, `addSurfaceMaterial`, `addMaterialFunction` and the per-instance `SurfaceMaterialDesc.params`. Upstream main declares that API in `packages/raa/types/m07-meshes-hdr.d.ts` and `types/m10-materials.d.ts`, but the published `@etcito/raa` v0.1.1 tarball (tag `v0.1.1`) is the older v0 API: its `index.d.ts` and `pkg/raa_js_bg.wasm` stop at `engine_addInstance`, `engine_addMaterial`, `engine_addNode` and `engine_setMaterial`, with no mesh upload and no per-instance material parameter. Upstream main `3bbd94b` (2026-10-25) bumps `@etcito/raa` and `@etcito/raa-sdfm` to 0.2.0 with that API, but no `v0.2.0` tag or release is published, so no newer release can be pinned yet; raa-sdfm 0.2.0 on main also declares registry peers `@etcito/raa@^0.2.0` and `mama@^0.1.0`, which kong cannot resolve, and the release workflow packs only `@etcito/raa`. raa-sdfm's public types also expose no upload of pre-meshed data: `createSdfmLoader` meshes the asset document through MAMA itself, and `mapMaterial` returns a description with no params. `apps/web/src/sdf/sdfPort.ts` therefore cannot upload the MeshPool payload or tint through a graph-material parameter, and is not written: card 5129 stays blocked until an `@etcito/raa` release (a version bump, so the tarball carries m07/m10) is published and pinned with a matching raa-sdfm. The 2026-10-25 recheck found four releases (`v0.1.0`, `v0.1.1`, `raa-sdfm-v0.1.0`, `raa-sdfm-v0.1.1`); none ships both tarballs. `RF_RAA_LOCAL` and an unreleased `../raa` build stay forbidden (1.2).

The 0.2.0 releases published later on 2026-10-25 close the upload gap: `v0.2.0` ships
`etcito-raa-0.2.0.tgz` with `addMesh`, `addMeshInstance`, `addSurfaceMaterial` and
`addMaterialFunction`, and `raa-sdfm-v0.2.0` ships the matching release with
`mapMaterial`. Both are pinned in `apps/web/package.json`, `apps/web/src/sdf/sdfPort.ts`
uploads the MeshPool payload through them, and the notes above describe the earlier
attempts. Two limits remain:

- raa-sdfm 0.2.0 declares peers `@etcito/raa@^0.2.0` and `mama@^0.1.0`. `mama` is not on
  the npm registry: `npm ci` from the committed lock installs both 0.2.0 packages without
  it, while a lock-only `npm install` tries to auto-install `mama` and fails. MAMA stays
  resolved through `.bricks/MAMA`, never as an npm dependency.
- The engine has a per-instance tint (`InstanceExtra.tint`, applied by `raa_apply_tint`),
  but 0.2.0 has no JS setter for it: `setLiquidImpacts` writes only instance params. The
  SDF port therefore applies a character tint as a per-tint variant of the graph material
  (the MAMA graph stays, its linear base colour is multiplied) and gives the instance the
  variant meshes. A `setInstanceTint(instance, [r, g, b])` binding would remove those
  per-tint material and mesh variants.

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

Card 5232 checked the upstream release prerequisite on 2026-10-25:

- The [published releases](https://github.com/Etcito/raa/releases) are v0.1.0
  and v0.1.1. Each contains only `etcito-raa-<version>.tgz` and `SHA256SUMS`;
  neither contains a raa-sdfm tarball.
- At upstream main commit `8aa0afbac4f1239c700c32435150618bcd6ce765`,
  [packages/raa-sdfm/package.json](https://github.com/Etcito/raa/blob/8aa0afbac4f1239c700c32435150618bcd6ce765/packages/raa-sdfm/package.json)
  defines `@etcito/raa-sdfm` version 0.1.0. The package exists, so decision
  #987's alternative of replanning M3 for an absent package does not apply.
- The [release workflow](https://github.com/Etcito/raa/blob/8aa0afbac4f1239c700c32435150618bcd6ce765/.github/workflows/release.yml)
  uploads only `release/etcito-raa-*.tgz` and `release/SHA256SUMS`.
  The upstream release task must package raa-sdfm, include its checksum and
  upload its tarball before the pin card can use a published URL.

The local baseline `d621e21` still lacks the release pin and both modules.
Card 5233's command is retained with its prerequisite refusal intact. It cannot
pass until decision #987's release and dependency sequence is integrated;
another GPU retry on this baseline cannot fix the missing runtime. Publishing
or patching the upstream repository is outside this repository worktree task.

Card 5242 verified baseline `fbadb74`: the release pin and both modules are
still absent, and neither module appears in the available git history. The
cache and inline-worker fixes remain present in commit `97861ef`. Card 5241's reported refusal
therefore still matches this checkout. Card 5243 retains the guarded command;
it remains blocked until the release, cards 5122, 5129, 5131 and 5132, and fix
card 5212 are integrated in decision #987's order. Repeating the GPU attempt
before that integration cannot produce a passing proof. No runtime substitute
or proof-threshold change is authorized by decision Q5.

Card 5129 rechecked the chain on 2026-10-25 after card 5122 landed: the
`@etcito/raa-sdfm` pin is now in `apps/web/package.json` (release
`raa-sdfm-v0.1.1`), and the cache and inline-worker fixes are present. The SDF
renderer and provider are still absent because the published `@etcito/raa`
release does not carry the m07/m10 upload API that raa-sdfm is built against
(the `## raa` entry above has the details). A later 2026-10-25 recheck of the
installed 0.1.1 pins confirms it at runtime: `@etcito/raa`'s wasm exports
`engine_addInstance`, `engine_addMaterial`, `engine_primitiveMesh`,
`engine_removeInstance`, `engine_removeMesh` and `engine_setMaterial` only,
while `@etcito/raa-sdfm`'s `src/loader.js` calls `engine.addSurfaceMaterial`,
`engine.addMesh`, `engine.addMaterialFunction` and `engine.addMeshInstance`,
and its `mapMaterial` description is `{function, blend}` with no `params`. The
releases API still lists only `v0.1.0`, `v0.1.1`, `raa-sdfm-v0.1.0` and
`raa-sdfm-v0.1.1`, and the `v0.2.0` / `raa-sdfm-v0.2.0` tarball URLs answer 404.
The guarded m17 command therefore still refuses at its prerequisite check;
nothing is substituted.

Card 5131 rechecked the same baseline on 2026-10-25: the pin is present, but
`apps/web/src/sdf/sdfPort.ts` is still absent because card 5129 remains blocked
on the `## raa` API gap, so `apps/web/src/content/providers/sdf.ts` is not
written. The 'sdf' provider stays unavailable rather than falling back to v1 or
shipping a stub; typecheck, test and build stay green with MAMA absent.

Card 5129 then pinned the published `v0.2.0` and `raa-sdfm-v0.2.0` releases and wrote
`apps/web/src/sdf/sdfPort.ts` against their m07/m10 API (see the `## raa` entry). The
earlier absent-release and 404 notes above describe the earlier attempts only. The tour
still needs `apps/web/src/content/providers/sdf.ts` (card 5131) and fix card 5212.

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

The GPU tour on card 5294 (attempt 17) reached the mesh worker and reported the
same `candy.checkpoint-gate` refusal above, including edge `(19354, 19355)`.
Card 5295's local `bricks check` still resolves MAMA to
`864ebc3e0780feb4261f3fa00a5029356045b89e`, with a pin-mismatch warning.
The published RAA 0.2.0 pins, SDF provider and render port are now present;
worker bootstrap passed on card 5294. Those prerequisites do not resolve this
separate mesher gap. The GPU tour remains blocked by decision Q2 until an
upstream MAMA fix or content re-save covers all 16 assets listed above. A pin
bump alone does not replace a resolved sibling: verify the resolved commit
with `bricks check`, then run the unchanged m17 `mesh-node` acceptance and GPU
tour. No successful GPU record has been produced by this corrective card.

### cause of the extract refusals (operator fix 1057)

The `cellSize` named by the refusal is not reachable from this repository. MAMA's
quad stage (`packages/quadmesh/src/stages/extract-dc.ts`) first extracts at a fixed
`diag / 192`, then at `baseCellSize(edgeLength)`. On `candy.checkpoint-gate` the
fixed coarse pass is the one that fails. No worker retry, group mesher param or
asset setting changes that cell, so a worker-side halving or an asset edit cannot
fix it. Halving the coarse cell globally (`diag / 384`) passes the 300 s group
timeout on that asset.

The cause is in MAMA's manifold dual contouring
(`packages/quadmesh/src/extract/dual-contour.ts`). Take a leaf face crossed by two
surface arcs, where each leaf merges both arcs into one vertex. Then the dual edge
between those two vertices is in all 4 polygons around the face's crossings. On
`candy.checkpoint-gate`, leaves (level 2) 512,223,38 and 513,223,38 share such a
face, and that gives edge (19354, 19355) right after contouring, before any cleanup.

A MAMA fix is committed on the local branch `op-1057-dc-manifold-refine` (commit
`c6f364b`, on top of `864ebc3`). The clone is the
operator scratch copy `op-1057-bricks/MAMA` next to the worktrees; the branch is not pushed. The fix
splits only the leaves that own the bad vertices and redoes the extract, at most 3
rounds. Its scope is the 9 'not 2-manifold' refusals and the 2 'does not
project' refusals. MAMA's own `extract.test` passes on it. Node results with that
build (`RF_BRICKS_DIR`):

| Asset | Extract with the fix | Then |
| --- | --- | --- |
| `candy.checkpoint-gate`, `candy.finish-arch`, `candy.floor-disc`, `candy.moving-platform`, `candy.pendulum-hammer`, `candy.queue-pad`, `candy.bounce-pad` | passes (1-2 repair rounds) | the group times out in the later quad stages (checkpoint-gate: over 300 s; the others over 120 s in a parallel run) |
| `costume.fish-scarf`, `costume.pineapple-suit`, `costume.propeller-hat` | still 'not 2-manifold' | the bad vertices are in finest-level leaves (`MAX_REFINE_LEVEL` 3), so no split is left |
| `candy.spinner-bar` | still 'does not project' | the same, after 1 round |

So the fix alone does not get the GPU tour through meshing. The 5 assets that
already timed out, plus the 7 that now pass extract, need a faster MAMA quad
pipeline: the extract runs more than once per group, and features, sizing and
remesh each take tens of seconds. The 4 finest-level cases need a dual-contouring
change in MAMA, for example splitting a vertex across an ambiguous face. The
quad mesher stays the mesher, and the m17 thresholds and the 300 s group timeout
are unchanged.

## ui font upload

`@etcito/raa-assets-tools` 0.1.0 has no remote put: `raa-assets put` only writes a local store
(`--store <dir>`). `tools/uiFont.ts upload` therefore stages the WOFF2 with
`raa-assets put --store out/font-store`, then publishes the staged object to
https://assets.etcito.com over SSH (scp-form `ASSET_STORE_SSH`, private key path in
`ASSET_STORE_KEY`), and verifies the object URL. A remote put in the CLI would remove the SSH step.
