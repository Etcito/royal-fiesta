import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MamaFacade } from '../src/sdf/mamaApi.ts'
import { MeshPool } from '../src/sdf/meshPool.ts'
import config from '../vite.config.ts'

// Exercise the real facade without loading private MAMA code or starting a browser worker.
const source = readFileSync(new URL('../src/sdf/mama/impl.ts', import.meta.url), 'utf8')
const compiled = transpileModule(source.replaceAll('import.meta.url', JSON.stringify(import.meta.url)), {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText

function loadFacade(info: unknown): Promise<MamaFacade> {
  const exports = {} as { loadMama(): Promise<MamaFacade> }
  runInNewContext(compiled, {
    exports,
    URL,
    __RF_MAMA__: info,
    __RF_RAA_SDFM__: runInNewContext(`(${config.define!.__RF_RAA_SDFM__})`),
    require(id: string): unknown {
      if (id === '@royal-fiesta/sim/refusal') return { RefusalError }
      if (id === '../meshPool.ts') return { MeshPool }
      if (id === './worker.ts?worker&url') return { default: './worker.js' }
      if (id === '../classicWorker.ts') return { classicWorker() { throw new Error('test must not spawn a worker') } }
      throw new Error(`unexpected facade import: ${id}`)
    },
  })
  return exports.loadMama()
}

test('facade consumes the object expression injected by the Vite config', async () => {
  const info = runInNewContext(`(${config.define!.__RF_MAMA__})`) as { kind: string; commit: string | null }
  assert.equal(typeof info, 'object')
  if (info.commit) {
    assert.equal((await loadFacade(info)).mamaVersion, info.commit)
  } else {
    await assert.rejects(loadFacade(info), /no resolved commit/)
  }
})

test('facade cache version is the installed raa-sdfm, the pinned release', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const facade = await loadFacade({ kind: 'sibling', commit: 'test-commit' })
  assert.ok(manifest.dependencies['@etcito/raa-sdfm'].endsWith(`/etcito-raa-sdfm-${facade.raaSdfmVersion}.tgz`))
})

for (const kind of ['sibling', 'cloned']) {
  test(`facade uses the ${kind} commit as its mesh cache version`, async () => {
    const commit = '1234567890abcdef1234567890abcdef12345678'
    assert.equal((await loadFacade({ kind, commit })).mamaVersion, commit)
  })
}

test('facade refuses malformed metadata with the named SDF refusal', async () => {
  for (const info of [undefined, null, 'not JSON', {}, { kind: 'absent', commit: null }, { commit: '' }]) {
    await assert.rejects(loadFacade(info), (error: unknown) => {
      assert.ok(error instanceof RefusalError)
      assert.equal(error.area, 'sdf')
      assert.equal(error.path, 'MAMA')
      assert.match(error.message, /MAMA not available:/)
      return true
    })
  }
})
