import { contentDir } from '../../../tools/content.ts'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import { PODIUM_TINTS } from '@royal-fiesta/game/render/podiumStage'
import { materialProgram } from '../src/sdf/materialProgram.ts'
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
function converter(helpers: Helpers, common: string, baseline?: string): (built: Built) => Promise<SdfmCompiledMaterial> {
  const source = baseline ?? readFileSync(new URL('../src/sdf/mama/worker.ts', import.meta.url), 'utf8')
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
        '@etcito/mama/core/paramesh/runtime.ts', '@etcito/mama/core/compute/pool.ts', '../meshValidity.ts'].includes(id)) return {}
      throw new Error(`unexpected worker import: ${id}`)
    },
  })
  return exports.convert
}

const body = 'return MaterialFull(vec3f(1.0), 0.0, 0.5, vec3f(0.0), 0.0);'

test('shared hash and noise helpers are emitted once even when graph dependencies request them', async () => {
  const hash = 'fn pcg_hash(x: u32) -> u32 { return x; }'
  const noise = [
    'fn noise_lattice() -> u32 { return pcg_hash(1u); }',
    'fn value_noise3() -> u32 { return noise_lattice(); }',
    'fn fbm3() -> u32 { return value_noise3(); }',
  ].join('\n')
  const helpers = {
    BASE_WGSL: '// base',
    HELPERS: {
      hash: { code: `\n${hash}\n` },
      noise: { code: `\n${noise}\n`, deps: ['hash'] },
      pattern: { code: 'fn pattern() -> u32 { return fbm3(); }', deps: ['noise'] },
    },
  }
  const convert = converter(helpers, `${hash}\n${noise}`)
  for (const ids of [['pattern'], ['hash', 'noise', 'pattern', 'noise']]) {
    const material = await convert({ id: 'noise', graph: { wgslBody: body, helpers: ids, constants: new Uint32Array() }, error: null })
    const mapped = mapMaterial(material).wgsl
    for (const name of ['pcg_hash', 'noise_lattice', 'value_noise3', 'fbm3', 'pattern']) {
      assert.equal([...mapped.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g'))].length, 1, name)
    }
  }
  // Same name alone is not proof that two implementations are interchangeable.
  helpers.HELPERS.hash.code = hash.replace('return x;', 'return x + 1u;')
  const changed = await convert({ id: 'changed', graph: { wgslBody: body, helpers: ['hash'], constants: new Uint32Array() }, error: null })
  assert.ok(changed.helpers.some(helper => helper.wgsl.includes('return x + 1u;')))
})

test('worker includes MAMA shared WGSL and hashes it in the material identity', async () => {
  const helpers = { BASE_WGSL: '// base', HELPERS: {} }
  const built = { id: 'plain', graph: { wgslBody: body, helpers: [], constants: new Uint32Array() }, error: null }
  const first = await converter(helpers, '// common A')(built)
  const second = await converter(helpers, '// common B')(built)
  assert.ok(first.helpers.some(h => h.wgsl === '// common A'))
  assert.notEqual(first.key, second.key)
  assert.match(mapMaterial(first).wgsl, /common A/)
})

test('helper discovery order does not change the material key or WGSL', async () => {
  const convert = converter({ BASE_WGSL: '', HELPERS: {
    a: { code: 'fn a() {}' }, b: { code: 'fn b() {}', deps: ['a'] }, c: { code: 'fn c() {}' },
  } }, '')
  const build = (ids: string[]): Built => ({ id: 'plain', graph: { wgslBody: body, helpers: ids, constants: new Uint32Array() }, error: null })
  const a = await convert(build(['c', 'b', 'a']))
  const b = await convert(build(['a', 'b', 'c']))
  assert.equal(a.key, b.key)
  assert.equal(mapMaterial(a).wgsl, mapMaterial(b).wgsl)
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
  const assets = pathToFileURL(join(contentDir(), 'assets') + '/')
  const baseline = process.env.RF_SHADER_BASELINE_WORKER
  const convertBefore = baseline ? converter(helpers, common, readFileSync(baseline, 'utf8')) : convert
  const materials: { asset: string; material: SdfmCompiledMaterial; beforeMaterial: SdfmCompiledMaterial }[] = []
  let count = 0
  for (const world of readdirSync(assets, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const dir = new URL(`${world.name}/`, assets)
    for (const file of readdirSync(dir).filter(file => file.endsWith('.asset.json'))) {
      const asset = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
      const doc = readSdfm(asset.document)
      for (const id of Object.keys(doc.materials)) {
        const built: Built = buildMaterial(doc, id)
        assert.ok(built.graph, `${asset.id}#${id}: ${JSON.stringify(built.error)}`)
        const material = await convert(built)
        check(material)
        materials.push({ asset: asset.id, material, beforeMaterial: await convertBefore(built) })
        count++
      }
    }
  }
  assert.ok(count > 0)
  const programs = materials.map(({ material }) => materialProgram(material))
  assert.equal(new Set(programs.map(program => program.wgsl)).size, 2, '24 assets share two material graph structures')
  for (const { material } of materials) {
    const mapped = materialProgram(material)
    const indices = [...new Set([...material.body.matchAll(/extra_words\s*\[\s*b\s*\+\s*(\d+)u?\s*\]/g)].map(read => Number(read[1])))].sort((a, b) => a - b)
    const values = Object.values(mapped.desc.params ?? {}).flat()
    assert.equal(values.length, indices.length * 2)
    for (const [slot, index] of indices.entries()) {
      assert.equal((values[slot * 2] | (values[slot * 2 + 1] << 16)) >>> 0, material.constants[index], `${material.name} word ${index}`)
    }
    assert.equal(mapped.wgsl, materialProgram({ ...material, name: 'another asset', constants: material.constants.map(word => word ^ 1) }).wgsl)
  }
  console.info(`INFO compiled and mapped ${count} content materials without meshing`)
  // Model the registration performed by prepare(), without geometry or a GPU. Baseline tint
  // wrappers match the old game path; the new path needs only the original graph function.
  const launches = [0, 1].map(() => {
    const before: { asset: string; hash: string; ms: number }[] = []
    const after: typeof before = []
    const oldFunctions = new Set<string>()
    const newFunctions = new Set<string>()
    let sequence = 0
    const hash = (wgsl: string): string => createHash('sha256').update(wgsl).digest('hex')
    for (const { asset, material, beforeMaterial } of [...materials].sort((a, b) => a.asset.localeCompare(b.asset))) {
      const start = performance.now()
      const mapped = mapMaterial(beforeMaterial)
      const ms = performance.now() - start
      if (!oldFunctions.has(mapped.functionName)) {
        before.push({ asset, hash: hash(mapped.wgsl), ms })
        oldFunctions.add(mapped.functionName)
      }
      const next = performance.now()
      const stable = materialProgram(material)
      const stableMs = performance.now() - next
      if (!newFunctions.has(stable.functionName)) {
        after.push({ asset, hash: hash(stable.wgsl), ms: stableMs })
        newFunctions.add(stable.functionName)
      }
      const tints = asset === 'penguin.body' ? PALETTE : asset === 'candy.wall-block' ? PODIUM_TINTS : []
      for (const tint of tints) {
        const next = performance.now()
        const id = `sdfm_tint_${sequence++}`
        const renamed = mapped.wgsl.replace(/\bfn\s+material_main\s*\(/, `fn ${id}_graph(`)
        const rgb = tint.map(c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)).map(c => c.toFixed(6))
        const wgsl = `${renamed}\nfn material_main(in: MaterialInput) -> MaterialOutput {\n  var out = ${id}_graph(in);\n  out.base_color = out.base_color * vec3<f32>(${rgb.join(', ')});\n  return out;\n}\n`
        const tintMs = performance.now() - next
        before.push({ asset, hash: hash(wgsl), ms: tintMs })
      }
    }
    return { before, after }
  })
  assert.deepEqual(launches[0].after.map(m => m.hash).sort(), launches[1].after.map(m => m.hash).sort())
  for (const [i, launch] of launches.entries()) {
    for (const [kind, modules] of Object.entries(launch)) {
      console.info(`INFO shader generation launch=${i + 1} ${kind}: ${modules.length} registrations, ${new Set(modules.map(m => m.hash)).size} unique WGSL, ${modules.reduce((sum, m) => sum + m.ms, 0).toFixed(2)} ms`)
    }
  }
  if (process.env.RF_SHADER_REPORT) writeFileSync(process.env.RF_SHADER_REPORT, JSON.stringify(launches, null, 2) + '\n')
})
