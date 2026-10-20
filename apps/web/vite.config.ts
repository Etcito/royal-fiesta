import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { brickDir, repoRoot } from '../../tools/bricks.ts'

type AliasEntry = { find: string; brick: 'gamesaloon-public' | 'raa' | 'raa-assets-tools'; subpath: string; fallback: string }

const webDir = fileURLToPath(new URL('.', import.meta.url))
const input = Object.fromEntries(
  readdirSync(webDir)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [basename(file, '.html'), join(webDir, file)]),
)
const aliasesPath = join(webDir, 'aliases.json')
const aliasEntries: AliasEntry[] = existsSync(aliasesPath)
  ? JSON.parse(readFileSync(aliasesPath, 'utf8')) as AliasEntry[]
  : []
const alias = aliasEntries.map(({ find, brick, subpath, fallback }) => {
  let brickRoot: string | null = null
  try {
    brickRoot = brickDir(brick)
  } catch {}
  const brickTarget = brickRoot === null ? null : join(brickRoot, subpath)
  const useBrick = brickTarget !== null && existsSync(brickTarget)
  const target = useBrick ? brickTarget : join(webDir, fallback)
  console.log(`[vite] alias ${find} -> ${target} (${useBrick ? 'brick' : 'fallback'})`)
  return { find, replacement: target }
})

export default defineConfig({
  root: webDir,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input },
  },
  server: { fs: { allow: [repoRoot()] } },
  resolve: { preserveSymlinks: false, alias },
  worker: { format: 'es' },
})
