import { defineConfig, mergeConfig } from 'vite'
import existing from '../apps/web/anim-brick.vite.config.ts'
import { resolve } from 'node:path'
export default defineConfig(mergeConfig(existing, {
  publicDir: false,
  build: { outDir: resolve('proof/skinacc/page'), rollupOptions: { input: {skinProof:resolve('apps/web/skinProof.html')} } },
}))
