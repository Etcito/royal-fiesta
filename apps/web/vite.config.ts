import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { mamaSource, raaLocal, raaSdfmVersion, repoRoot, type MamaSource } from '../../tools/bricks.ts'
import { fixUaaTextShader } from '../../tools/uaaText.ts'

const webDir = fileURLToPath(new URL('.', import.meta.url))
const input = Object.fromEntries(
  readdirSync(webDir)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [basename(file, '.html'), join(webDir, file)]),
)

const mama: MamaSource = mamaSource()
const MAMA_IMPL = join(webDir, 'src', 'sdf', 'mama', 'impl.ts')
const MAMA_ABSENT = join(webDir, 'src', 'mamaAbsent.ts')

// MAMA is private: the app reaches it only through this virtual module. A public clone gets the
// typed stub, so every other page still builds and runs.
function rfMama(): Plugin {
  const target = mama.kind !== 'absent' && existsSync(MAMA_IMPL) ? MAMA_IMPL : MAMA_ABSENT
  return {
    name: 'rf-mama',
    resolveId(id) {
      if (id === 'virtual:rf-mama') return target
      return null
    },
  }
}

type Alias = { find: string; replacement: string }

// The local RAA checkout carries its packages under packages/<name>; read the names from their
// manifests instead of hard-coding paths that a release may move.
function localRaaAliases(dir: string): Alias[] {
  const packagesDir = join(dir, 'packages')
  const found = new Map<string, string>()
  try {
    for (const entry of readdirSync(packagesDir)) {
      try {
        const manifest = JSON.parse(readFileSync(join(packagesDir, entry, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name === 'string') found.set(manifest.name, join(packagesDir, entry))
      } catch {}
    }
  } catch {}
  return ['@etcito/raa', '@etcito/raa-sdfm'].flatMap((name) => {
    const replacement = found.get(name)
    return replacement === undefined ? [] : [{ find: name, replacement }]
  })
}

const alias: Alias[] = []
if (mama.kind !== 'absent') {
  alias.push({ find: '@etcito/mama', replacement: join(mama.dir, 'src') })
  alias.push({ find: 'manifold-3d', replacement: join(mama.dir, 'node_modules', 'manifold-3d') })
}
const raa = raaLocal()
if (raa.active && raa.dir !== null) {
  console.warn(`[vite] RF_RAA_LOCAL=1: local RAA override active from ${raa.dir}`)
  alias.push(...localRaaAliases(raa.dir))
}

export default defineConfig({
  root: webDir,
  // The GPU client serves dist from a sub-path: absolute /assets URLs never load there.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input },
  },
  plugins: [rfMama(), {
    name: 'rf-uaa-text-edges',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').split('?')[0].endsWith('/uaa/dist/webgpu.js')) return null
      return { code: fixUaaTextShader(code), map: null }
    },
  }],
  optimizeDeps: { exclude: ['@etcito/uaa/webgpu'] },
  // S15: the resolved MAMA commit and the installed raa-sdfm version are part of the client mesh cache key.
  define: {
    __RF_MAMA__: JSON.stringify(
      mama.kind === 'absent' ? { kind: 'absent', commit: null } : { kind: mama.kind, commit: mama.commit },
    ),
    __RF_RAA_SDFM__: JSON.stringify(raaSdfmVersion()),
  },
  server: { fs: { allow: [repoRoot()] } },
  resolve: { preserveSymlinks: false, alias },
  // The crowd AudioWorklet is imported as ?worker&url (play/sound.ts): an ES module bundle, same in dev and build.
  worker: { format: 'es' },
})
