import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { repoRoot } from '../../tools/bricks.ts'

const webDir = fileURLToPath(new URL('.', import.meta.url))
const input = Object.fromEntries(
  readdirSync(webDir)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [basename(file, '.html'), join(webDir, file)]),
)

export default defineConfig({
  root: webDir,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input },
  },
  server: { fs: { allow: [repoRoot()] } },
  resolve: { preserveSymlinks: false },
  worker: { format: 'es' },
})
