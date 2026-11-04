// Vite's `?worker&url` import: a bundled ES module served as a URL (the crowd AudioWorklet).
declare module '*?worker&url' {
  const url: string
  export default url
}

// Vite's `?url` import of an asset (the manifold-3d wasm the MAMA worker loads): its served URL. tsconfig.mama.json
// type-checks apps/web/src/sdf/mama with this file only (no vite/client types), so the declaration lives here.
declare module '*?url' {
  const url: string
  export default url
}
