import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { buildContentIndex } from '../../../tools/content.ts'

const root = new URL('../../../', import.meta.url)
const sidecars = Object.fromEntries(readdirSync(new URL('courses/', root))
  .filter(file => file.endsWith('.zones.json'))
  .map(file => [`../../../../courses/${file}`, readFileSync(new URL(`courses/${file}`, root), 'utf8')]))
// Replace Vite's raw imports and glob expansion only; use the real authored content loaders.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/season.json?raw')) return {
      url: `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(readFileSync(new URL('courses/season.json', root), 'utf8'))}`)}`,
      shortCircuit: true,
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('/game/showContent.ts')) {
      const source = readFileSync(new URL(url), 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\}\)/, JSON.stringify(sidecars))
      return { format: 'module-typescript', source, shortCircuit: true }
    }
    return next(url, context)
  },
})
const { loadShowContent } = await import('../src/game/showContent.ts')
hooks.deregister()

test('offline show uses authored season ids and sidecars, including the final', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    const path = String(input).replace(/^(?:\.\/)?content\//, '')
    return new Response(path === 'index.json' ? JSON.stringify(buildContentIndex(root.pathname)) : readFileSync(new URL(path, root)))
  }
  try {
    const content = await loadShowContent('sprint')
    assert.deepEqual(content.season.map(map => map.id), ['B', 'C1', 'C2', 'D', 'E', 'F', 'G', 'I', 'Q'])
    assert.equal(content.info('B').name, 'Butterfly Freeway')
    for (const map of content.season) {
      assert.ok(content.courses[map.course].id.startsWith('s1-'))
      assert.ok(content.zones.has(content.courses[map.course].id))
    }
  } finally { globalThis.fetch = original }
})
