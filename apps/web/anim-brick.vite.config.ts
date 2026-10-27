import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import existing from './vite.config.ts'

const webDir = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const names = ['@etcito/raa', '@etcito/raa-sdfm', '@etcito/raa-anim']
// Resolve the installed file: dependencies, never the legacy source-checkout channel.
const localAliases = names.map(find => ({ find, replacement: dirname(require.resolve(find)) }))
const sdfm = localAliases.find(a => a.find === '@etcito/raa-sdfm')!
const { version } = JSON.parse(readFileSync(join(sdfm.replacement, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(webDir, 'public/nmc.gpu.json'), 'utf8')) as {
  page: string; ops: string[]
}

function animBrick(): Plugin {
  return {
    name: 'rf-anim-brick',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        if (basename(context.filename) !== manifest.page) return
        return [{ tag: 'script', attrs: { type: 'module', src: '/src/anim/brickBoot.ts' }, injectTo: 'body' }]
      },
    },
    generateBundle() {
      this.emitFile({
        type: 'asset', fileName: 'nmc.gpu.json',
        source: JSON.stringify({ ...manifest, ops: [...new Set([...manifest.ops, 'animBrick'])] }, null, 2) + '\n',
      })
    },
  }
}

// Preserve HTML inputs, MAMA, workers, public assets and all other existing build features.
// Replace only legacy RAA aliases/cache metadata so RF_RAA_LOCAL cannot select the channel.
const config = mergeConfig(existing, { plugins: [animBrick()] })
config.resolve = {
  ...config.resolve,
  alias: [...localAliases, ...(existing.resolve?.alias as { find: string; replacement: string }[])
    .filter(a => !names.includes(a.find))],
}
config.define = { ...config.define, __RF_RAA_SDFM__: JSON.stringify(version) }
export default defineConfig(config)
