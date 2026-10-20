// Vite's `?worker&url` import: a bundled ES module served as a URL (the crowd AudioWorklet).
declare module '*?worker&url' {
  const url: string
  export default url
}
