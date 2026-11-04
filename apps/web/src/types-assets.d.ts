// Vite's `?worker&url` import: a bundled ES module served as a URL (the crowd AudioWorklet).
declare module '*?worker&url' {
  const url: string
  export default url
}

// Vite's `?url` import of an asset (the manifold-3d wasm the MAMA worker loads): its served URL. vite/client declares it
// too (sdf/mama/worker.ts references it); this copy keeps it typed in a program that loads no vite/client.
declare module '*?url' {
  const url: string
  export default url
}
