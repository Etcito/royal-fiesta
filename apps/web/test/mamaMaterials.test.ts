import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { mapMaterial } from '@etcito/raa-sdfm'
import type { SdfmCompiledMaterial } from '@etcito/raa-sdfm'
import { RefusalError, isRefusal } from '@royal-fiesta/sim/refusal'

interface Built {
  id: string
  graph: { wgslBody: string; helpers: string[]; constants: Uint32Array } | null
  error: { code: string; message: string } | null
}
interface Helpers { BASE_WGSL: string; HELPERS: Record<string, { code: string; deps?: string[] }> }

// Run only the worker's material conversion: no geometry, browser, GPU or private dependency needed.
function converter(helpers: Helpers, common: string): (built: Built) => Promise<SdfmCompiledMaterial> {
  const source = readFileSync(new URL('../src/sdf/mama/worker.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source + '\nexports.convert = toPayloadMaterial\n', {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText
  const exports = {} as { convert: (built: Built) => Promise<SdfmCompiledMaterial> }
  runInNewContext(compiled, {
    exports, TextEncoder,
    require(id: string): unknown {
      if (id === '@royal-fiesta/sim/refusal') return { RefusalError, isRefusal }
      if (id === '@etcito/mama/core/material-graph/helpers.ts') return helpers
      if (id === '@etcito/mama/gpu/wgsl/common.ts') return { COMMON_NO_PROGRAM_WGSL: common }
      if (id === '@etcito/mama/core/image/sha256.ts') {
        return { sha256Hex: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') }
      }
      if (['@etcito/mama/sdfm.ts', '@etcito/mama/core/game/mesh-assets.ts',
        '@etcito/mama/core/paramesh/runtime.ts', '@etcito/mama/core/compute/pool.ts'].includes(id)) return {}
      throw new Error(`unexpected worker import: ${id}`)
    },
  })
  return exports.convert
}

const body = 'return MaterialFull(vec3f(1.0), 0.0, 0.5, vec3f(0.0), 0.0);'

test('worker includes MAMA shared WGSL and hashes it in the material identity', async () => {
  const helpers = { BASE_WGSL: '// base', HELPERS: {} }
  const built = { id: 'plain', graph: { wgslBody: body, helpers: [], constants: new Uint32Array() }, error: null }
  const first = await converter(helpers, '// common A')(built)
  const second = await converter(helpers, '// common B')(built)
  assert.ok(first.helpers.some(h => h.wgsl === '// common A'))
  assert.notEqual(first.key, second.key)
  assert.match(mapMaterial(first).wgsl, /common A/)
})

const mama = new URL('../../../.bricks/MAMA/dist/', import.meta.url)
const present = existsSync(new URL('sdfm.js', mama))
if (!present) console.info('INFO material coverage skipped: built .bricks/MAMA is absent')

test('every content material and MAMA pattern carries its shared shader dependencies', { skip: !present }, async () => {
  const helpers: Helpers = await import(new URL('core/material-graph/helpers.js', mama).href)
  const { COMMON_NO_PROGRAM_WGSL: common } = await import(new URL('gpu/wgsl/common.js', mama).href)
  const { readSdfm, buildMaterial } = await import(new URL('sdfm.js', mama).href)
  const convert = converter(helpers, common)
  const check = (material: SdfmCompiledMaterial): void => {
    const mapped = mapMaterial(material).wgsl
    for (const name of ['pcg_hash', 'noise_lattice', 'value_noise3', 'fbm3']) {
      assert.equal([...mapped.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g'))].length, 1, `${material.name}: ${name}`)
    }
    assert.doesNotMatch(mapped, /\bprog_data\b|@binding|@group/)
  }
  // Include patterns unused by today's assets too: they share the same external dependencies.
  for (const id of Object.keys(helpers.HELPERS).filter(id => id.startsWith('pat_'))) {
    check(await convert({ id, graph: { wgslBody: body, helpers: [id], constants: new Uint32Array() }, error: null }))
  }
  const assets = new URL('../../../assets/', import.meta.url)
  let count = 0
  for (const world of readdirSync(assets, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const dir = new URL(`${world.name}/`, assets)
    for (const file of readdirSync(dir).filter(file => file.endsWith('.asset.json'))) {
      const asset = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
      const doc = readSdfm(asset.document)
      for (const id of Object.keys(doc.materials)) {
        const built: Built = buildMaterial(doc, id)
        assert.ok(built.graph, `${asset.id}#${id}: ${JSON.stringify(built.error)}`)
        check(await convert(built))
        count++
      }
    }
  }
  assert.ok(count > 0)
  console.info(`INFO compiled and mapped ${count} content materials without meshing`)
})
