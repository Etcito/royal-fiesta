# Brick gaps

## raa

`@etcito/raa` 0.1.0 (public API v0, release tarball, WASM included) is a dependency of apps/web. Its gaps for this game:

- One canvas, one camera, no scissor: the port draws a single full-canvas viewport. The in-page multi-client 2x2 grid (`viewportsOf` with count > 1) refuses; it needs one canvas per client or a multi-viewport RAA API.
- Tints: RAA has no per-instance colour. A tinted instance draws every mesh with one cached material of that colour (sRGB, roughness 0.6), so the asset's own colours are not used for tinted beans.
- Node has no WebGPU, so the Node proofs (m7-web, m8-hub) record RAA as absent; captures and frame timing come only from a browser run on a GPU.
