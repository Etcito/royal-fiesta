import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Diagnostic } from '@etcito/game-engine-compile'
import { loadEngine } from '@etcito/game-engine'
import { loadScript } from '@etcito/game-engine/script'
import { collectRfScripts, compileRfScripts, formatRfDiagnostic } from '../egeScripts.ts'

test('collects AssemblyScript files in byte order', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-scripts-'))
  try {
    for (const name of ['b/x.as.ts', 'a_b/q.as.ts', 'a/y.as.ts', 'a/z.ts']) {
      const file = join(root, 'scripts/ege', name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, name)
    }
    assert.deepEqual(collectRfScripts(root).map(file => file.name), ['a/y.as.ts', 'a_b/q.as.ts', 'b/x.as.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formats user, generated and SDK diagnostic paths', () => {
  const diagnostic: Diagnostic = { file: 'lib/vec.as.ts', line: 3, column: 5, endLine: 3, endColumn: 6, severity: 'error', code: 'EGE1001', message: 'm' }
  assert.equal(formatRfDiagnostic(diagnostic), 'scripts/ege/lib/vec.as.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'components.gen.ts' }), 'generated/components.gen.ts:3:5 EGE1001 m')
  assert.equal(formatRfDiagnostic({ ...diagnostic, file: 'ege/query.ts' }), 'sdk/query.ts:3:5 EGE1001 m')
})

test('compiles an added override and retains its diagnostics', async () => {
  const result = await compileRfScripts({ overrides: [{ name: 'probe/bad.as.ts', text: 'let x: f32 = 0;' }] })
  assert.ok(result.files.includes('probe/bad.as.ts'))
  assert.ok(result.diagnostics.some(d => d.code === 'EGE1001' && d.file === 'probe/bad.as.ts' && d.line === 1))
})

test('compiles and loads the real round scripts and checks exported numeric helpers', async () => {
  const schemaText = readFileSync(new URL('../../ege.schema.json', import.meta.url), 'utf8')
  const result = await compileRfScripts()
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
  assert.ok(result.wasm)

  const engine = await loadEngine()
  engine.setSchema(schemaText)
  await loadScript(engine, result.wasm, { name: 'rf-scripts' })

  const module = await WebAssembly.compile(result.wasm as Uint8Array<ArrayBuffer>)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const exported = new Set(WebAssembly.Module.exports(module).map(item => item.name))
  for (const name of ['degToRad', 'ticksOf', 'inBox']) assert.ok(exported.has(name), `${name} export`)
  const degToRad = instance.exports.degToRad as (value: number) => number
  const ticksOf = instance.exports.ticksOf as (value: number) => number
  const inBox = instance.exports.inBox as (...values: number[]) => number
  assert.equal(degToRad(180), Math.PI)
  assert.equal(degToRad(90), Math.PI / 2)
  assert.equal(ticksOf(0.5), 30)
  assert.equal(ticksOf(1.0), 60)
  assert.equal(inBox(0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5), 1)
  assert.equal(inBox(0, 0, 0, 1, 1, 1, 1.5, 0, 0), 0)
})
