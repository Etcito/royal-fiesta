# Brick gaps

## raa

`@etcito/raa` 0.1.1 (public API v0, release tarball, WASM included) is a dependency of apps/web. Its gaps for this game:

- One canvas, one camera, no scissor: the port draws a single full-canvas viewport, and refuses any other count. The client page therefore creates ONE canvas and ONE RAA engine per in-page client (`apps/web/src/client/canvases.ts`), laid out in a CSS grid under `main#views`: 1 client = one full view (the default), 2 = side by side, 3 or 4 = 2x2. Each canvas gets one full-canvas viewport. A multi-viewport RAA API would allow one shared canvas, but nothing needs it now.
  - Not yet on this path: `apps/web/src/play/main.ts` (play.html, `?mode=inpage&clients>1`) still draws all clients on one canvas and refuses, and the GPU ops round capture (`apps/web/src/nmc/ops.ts`, `roundCapture` with 4 clients) still asks one port for 4 viewports. Both need the same one-canvas-per-client change.
- Tints: RAA has no per-instance colour. A tinted instance draws every mesh with one cached material of that colour (sRGB, roughness 0.6), so the asset's own colours are not used for tinted beans.
- Node has no WebGPU, so the Node proofs (m7-web, m8-hub) record RAA as absent; captures and frame timing come only from a browser run on a GPU.

## raa.prims assets

The 15 files in `fixtures/assets` are raa.prims v0 as published (raa-assets-tools 0.1.0 schema). They were converted from the pre-v0 shape with the same geometry and colliders (collision mode `override`), so the sim is unchanged. `packages/game/test/shippedAssets.test.ts` checks each one with the published validator.

The 11 obstacle recipes published in raa-assets-tools `runs/obstacles-v0` (objects in the asset store, hashes checked) were not adopted: their sizes differ from the sim colliders the courses use (for example the bean body is a 1.4 m capsule, the sim collider is 0.9 m, and the bouncy pad footprint is 2.2 m against a 3 m collider). Adopting them changes gameplay and needs a sim decision first.

The RAA loader cannot run under node: `loadPrimsAsset` is an Engine method and `createEngine` needs WebGPU and a canvas. The browser is the only check of the loader.
