import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// The web build's rf-asset-data plugin keeps only ASSET_DATA_KEYS of an imported *.asset.json: a module reading any other
// key sees undefined in the bundle although Node (tests) reads the whole file.
test('every key a module reads from an imported asset file is kept by the build', () => {
  const root = new URL('../', import.meta.url).pathname
  const config = readFileSync(join(root, 'vite.config.ts'), 'utf8')
  const kept = [...(/ASSET_DATA_KEYS = \[([^\]]*)\]/.exec(config)![1].matchAll(/'(\w+)'/g))].map(m => m[1])
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) files.push(path)
    }
  }
  walk(join(root, 'src'))
  const missing: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [, id] of text.matchAll(/^import (\w+) from '[^']*\.asset\.json'/gm)) {
      const code = text.replace(/^import .*$/gm, '')
      for (const [, key] of code.matchAll(new RegExp(`\\b${id}\\.(\\w+)`, 'g'))) {
        if (!kept.includes(key)) missing.push(`${file.slice(root.length)}: ${id}.${key}`)
      }
    }
  }
  assert.deepEqual(missing, [], 'add these keys to ASSET_DATA_KEYS in apps/web/vite.config.ts')
})
