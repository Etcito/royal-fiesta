# Brick gaps

## raa

`@etcito/raa` 0.1.1 (public API v0, release tarball, WASM included) is a dependency of apps/web. Its gaps for this game:

- One canvas, one camera, no scissor: the port draws a single full-canvas viewport, and refuses any other count. The client page therefore creates ONE canvas and ONE RAA engine per in-page client (`apps/web/src/client/canvases.ts`), laid out in a CSS grid under `main#views`: 1 client = one full view (the default), 2 = side by side, 3 or 4 = 2x2. Each canvas gets one full-canvas viewport. A multi-viewport RAA API would allow one shared canvas, but nothing needs it now.
  - Not yet on this path: `apps/web/src/play/main.ts` (play.html, `?mode=inpage&clients>1`) still draws all clients on one canvas and refuses, and the GPU ops round capture (`apps/web/src/nmc/ops.ts`, `roundCapture` with 4 clients) still asks one port for 4 viewports. Both need the same one-canvas-per-client change.
- Tints: RAA has no per-instance colour. A tinted instance draws every mesh with one cached material of that colour (sRGB, roughness 0.6), so the asset's own colours are not used for tinted beans.
- Node has no WebGPU, so the Node proofs (m7-web, m8-hub) record RAA as absent; captures and frame timing come only from a browser run on a GPU.
