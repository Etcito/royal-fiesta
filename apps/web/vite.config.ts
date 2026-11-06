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
    resolveId(id: string) {
      if (id === 'virtual:rf-mama') return target
      return null
    },
  }
}

// A module that imports an SDF Modeler asset file (packages/sim/src/character/capsule.ts reads penguin.body's saved
// capsule) gets only the asset's game data: the document (most of the file, ~1 MB for the penguin) stays in the content
// pack the page fetches. The sim reads `category` and `collision`, the settings scene `bounds`; tests and Node read the
// whole file. A key a module reads must be listed (assetDataKeys.test.ts): `bounds` was missing and the settings
// GPU render died on `penguin.bounds.min` (run 12382) while every Node test read the whole file and passed.
const ASSET_DATA_KEYS = ['format', 'version', 'game', 'id', 'category', 'collision', 'bounds'] as const
function rfAssetData(): Plugin {
  return {
    name: 'rf-asset-data',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]
      if (!file.endsWith('.asset.json')) return null
      const asset = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      return JSON.stringify(Object.fromEntries(ASSET_DATA_KEYS.filter((k) => k in asset).map((k) => [k, asset[k]])))
    },
  }
}

type Alias = { find: string | RegExp; replacement: string }

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

const alias: Alias[] = ['game', 'sim'].map(name => ({ find: `@royal-fiesta/${name}`, replacement: join(webDir, '../../packages', name, 'src') }))
if (mama.kind !== 'absent') {
  alias.push({ find: '@etcito/mama', replacement: join(mama.dir, 'src') })
  alias.push({ find: 'manifold-3d', replacement: join(mama.dir, 'node_modules', 'manifold-3d') })
  // MAMA's Paramesh field imports its generated base64 module as ./field-wasm-bytes.js; build-procgen writes it into
  // dist/core/paramesh next to the compiled file, so point that import at dist (the app reads MAMA's sources).
  alias.push({ find: /^\.\/field-wasm-bytes\.js$/, replacement: join(mama.dir, 'dist', 'core', 'paramesh', 'field-wasm-bytes.js') })
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
    assetsInlineLimit: 0,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input },
  },
  plugins: [rfMama(), rfAssetData(), {
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
