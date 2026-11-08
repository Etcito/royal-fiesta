import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { checkWebBuild } from '../checkWebBuild.ts'
import { repoRoot } from '../bricks.ts'

test('static artifact check rejects dev imports, escaping URLs, and incomplete uploads', () => {
  const root = repoRoot()
  mkdirSync(join(root, 'out'), { recursive: true })
  const dir = mkdtempSync(join(root, 'out/web-build-check-'))
  try {
    for (const name of ['index.html', 'game.html']) writeFileSync(join(dir, name), '<script type="module" src="./app.js"></script>')
    for (const name of ['raa_js_bg', 'raa_anim_js_bg', 'manifold', 'highs']) writeFileSync(join(dir, name + '-hash.wasm'), 'wasm')
    const app = join(dir, 'app.js')
    writeFileSync(app, 'export const ok = true')
    assert.equal(checkWebBuild(dir).wasm.length, 4)
    assert.throws(() => checkWebBuild(dir, true), /rf-build.json/)
    writeFileSync(join(dir, 'rf-build.json'), JSON.stringify({ format: 'royal-fiesta.build', version: 1, entry: 'game.html', builtAt: '2026-01-01T00:00:00Z' }))
    assert.equal(checkWebBuild(dir, true).wasm.length, 4)
    for (const code of [
      'import "/@fs/sibling/raa/index.js"',
      'export { Engine } from "@etcito/raa"',
      'import("../../raa/index.js")',
      'new URL("../../raa/engine.wasm", import.meta.url)',
      'import("./missing.js")',
      'const wasm = "file:///sibling/raa/engine.wasm"',
    ]) {
      writeFileSync(app, code)
      assert.throws(() => checkWebBuild(dir), { name: 'AssertionError' }, code)
    }
    writeFileSync(app, 'export {}')
    rmSync(join(dir, 'raa_js_bg-hash.wasm'))
    assert.throws(() => checkWebBuild(dir), /missing raa_js_bg wasm/)
    rmSync(join(dir, 'index.html'))
    assert.throws(() => checkWebBuild(dir), /missing index.html/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real production dist and Wavedash upload are standalone', { skip: process.env.RF_VERIFY_BUILDS !== '1' }, () => {
  const root = repoRoot()
  checkWebBuild(join(root, 'apps/web/dist'))
  checkWebBuild(join(root, 'out/wavedash-build/upload'), true)
})
