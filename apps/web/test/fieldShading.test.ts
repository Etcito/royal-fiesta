import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
// Field shading: structural check, generated material text, program data words, grid texture and instance params.
// No GPU and no MAMA: the program fixture is the structural contract 'mama.field-program'.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MATERIAL_FUNCTION_MAX_BYTES, PMF_GRID_HOST_WGSL, PMF_INTERPRETER_WGSL, PMF_STACK, checkFieldPart, fieldGridTexture,
  fieldInstanceParams, fieldMaterialWgsl, fieldProgramWords, type FieldLabelGraphLike, type FieldProgramLike,
} from '../src/sdf/fieldShading.ts'
import { decodeMesh } from '../src/sdf/meshWire.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const FUNCTION = 'pmf_eval_0123456789abcdef'

function program(): FieldProgramLike {
  return {
    format: 'mama.field-program',
    version: 1,
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    labels: [
      { material: null, color: [1, 0, 0], roughness: 0.5, metallic: 0.1 },
      { material: null, color: [0, 1, 0], roughness: 0.7, metallic: 0.2 },
    ],
    operands: [
      { kind: 'box', label: 0, inv: IDENTITY, scale: 1, half: [0.5, 0.5, 0.5], radius: 0.1 },
      { kind: 'grid', label: 1, inv: IDENTITY, scale: 1, origin: [-0.6, -0.6, -0.6], voxel: 0.3, size: [4, 4, 4], at: [0, 0], range: 1.5 },
    ],
    tree: [
      { op: 'leaf', operand: 0 },
      { op: 'leaf', operand: 1 },
      { op: 'union', mode: 'smooth', radius: 0.1 },
    ],
    grid: { width: 16, height: 16, texels: new Uint8Array(16 * 16 * 4) },
    stats: { operands: 2, analytic: 1, sampled: 1 },
    functionName: FUNCTION,
    wgsl: `fn ${FUNCTION}(p: vec3f, w: ptr<function, array<f32, 8>>) -> f32 {
  (*w)[0] = 0.5; (*w)[1] = 0.5; (*w)[2] = 0.0; (*w)[3] = 0.0;
  (*w)[4] = 0.0; (*w)[5] = 0.0; (*w)[6] = 0.0; (*w)[7] = 0.0;
  return length(p) - 0.5;
}`,
  }
}

function part(over: Partial<FieldProgramLike> = {}): { fieldProgram: FieldProgramLike } {
  return { fieldProgram: { ...program(), ...over } }
}

test('checkFieldPart returns a structurally valid program', () => {
  const checked = checkFieldPart(part())
  assert.equal(checked.ok, true)
  if (checked.ok) assert.equal(checked.program.functionName, FUNCTION)
})

test('checkFieldPart reports every refusal reason', () => {
  const noField = checkFieldPart({})
  assert.equal(noField.ok, false)
  if (!noField.ok) assert.match(noField.reason, /no field program/)

  const refused = checkFieldPart({ fieldRefusal: 'not a Paramesh part' })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.reason, 'not a Paramesh part')

  const format = checkFieldPart(part({ format: 'other' }))
  assert.equal(format.ok, false)
  if (!format.ok) assert.match(format.reason, /format/)

  const version = checkFieldPart(part({ version: 2 }))
  assert.equal(version.ok, false)
  if (!version.ok) assert.match(version.reason, /version 2/)

  const labels = checkFieldPart(part({
    labels: [
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
      { material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 },
    ],
  }))
  assert.equal(labels.ok, false)
  if (!labels.ok) assert.match(labels.reason, /more than 8 labels/)

  const texels = checkFieldPart(part({ grid: { width: 16, height: 16, texels: new Uint8Array(4) } }))
  assert.equal(texels.ok, false)
  if (!texels.ok) assert.match(texels.reason, /texels length 4 is not 1024/)

  const name = checkFieldPart(part({ functionName: 'pmf_eval_nope' }))
  assert.equal(name.ok, false)
  if (!name.ok) assert.match(name.reason, /bad functionName/)
})

test('fieldMaterialWgsl runs the one fixed evaluator over material data, never the program text', () => {
  const p = program()
  const out = fieldMaterialWgsl({ program: p, labelGraphs: [null, null], debug: false })
  assert.ok(!out.wgsl.includes(FUNCTION), 'the per-part program text is not embedded')
  assert.ok(out.wgsl.includes(PMF_INTERPRETER_WGSL))
  assert.match(out.wgsl, /let db = raa_material_data_base\(in\.record\);/)
  // The shader compiler inlines every call: the centre run and the six normal taps share ONE pmf_run call site and an
  // operand ONE pmf_texel site, or a level's field pipelines stay compiling past the capture wait (run 12096).
  assert.match(out.wgsl, /pmf_field\(db, p, pmf_f\(db \+ 7u\), &w\)/)
  assert.equal(out.wgsl.match(/= pmf_run\(/g)?.length, 1)
  assert.equal(out.wgsl.match(/pmf_texel\(/g)?.length, 2, 'one definition, one call')
  assert.equal(out.wgsl.match(/raa_texture\(/g)?.length, 1)
  assert.match(out.wgsl, /for \(var t = 0u; t < 7u; t = t \+ 1u\)/)
  assert.match(out.wgsl, /inside && glen > 1e-6/)
  assert.ok(out.wgsl.includes(PMF_GRID_HOST_WGSL))
  assert.match(out.wgsl, /sdfm_posed_normal/)
  assert.match(out.wgsl, /base \+= w\[i\] \* pmf_v3\(l\)/)
  const words = fieldProgramWords(p)
  assert.ok(words.ok)
  if (!words.ok) return
  const f = new Float32Array(words.words.buffer)
  assert.deepEqual([f[0], f[1]], [1, p.tree.length])
  assert.deepEqual([...f.slice(4, 7)], [...p.bounds.min])
  assert.deepEqual([...f.slice(12, 15)], [1, 0, 0])
  assert.equal(f[8 + 12 + 3], Math.fround(0.7))
})

test('fieldProgramWords names a blend mode without a port and a tree deeper than the stack', () => {
  const mode = program()
  mode.tree = [{ op: 'leaf', operand: 0 }, { op: 'leaf', operand: 0 }, { op: 'union', mode: 'groove', radius: 0.1 }]
  const m = fieldProgramWords(mode)
  assert.equal(m.ok, false)
  if (!m.ok) assert.match(m.reason, /blend mode 'groove'/)
  const deep = program()
  deep.tree = [...Array.from({ length: PMF_STACK + 1 }, () => ({ op: 'leaf' as const, operand: 0 })),
    ...Array.from({ length: PMF_STACK }, () => ({ op: 'union' as const, mode: 'hard', radius: 0 }))]
  const d = fieldProgramWords(deep)
  assert.equal(d.ok, false)
  if (!d.ok) assert.match(d.reason, /stack of 17/)
})

// Every saved field part of the shipped worlds draws through a field material RAA accepts (its 64 KB cap).
test('every saved field part gets a field material under the RAA size limit and fits the evaluator', () => {
  let parts = 0
  for (const world of readdirSync('assets')) {
    if (!statSync(join('assets', world)).isDirectory()) continue
    for (const file of readdirSync(join('assets', world)).filter(name => name.endsWith('.mesh'))) {
      const meshed = decodeMesh(new Uint8Array(readFileSync(join('assets', world, file)))) as unknown as { data: { groups: { parts: unknown[] }[]; materials: FieldLabelGraphLike[] } }
      const byName = new Map(meshed.data.materials.map(m => [m.name, m]))
      for (const group of meshed.data.groups) for (const part of group.parts) {
        const check = checkFieldPart(part)
        if (!check.ok) continue
        parts++
        const words = fieldProgramWords(check.program)
        assert.ok(words.ok, `${file}: ${words.ok ? '' : words.reason}`)
        const graphs = check.program.labels.map(l => (l.material === null ? null : byName.get(l.material) ?? null))
        const out = fieldMaterialWgsl({ program: check.program, labelGraphs: graphs, debug: true })
        assert.ok(new TextEncoder().encode(out.wgsl).length <= MATERIAL_FUNCTION_MAX_BYTES, file)
      }
    }
  }
  assert.ok(parts > 100, `${parts} saved field parts`)
})

// A label graph as the saved mesh carries it (SdfmCompiledMaterial): its RAA function is registered under a dotted
// registry name ('sdfm.buffer_<hash>'), so the field material embeds the graph text, never a call by that name.
const STRIPES = {
  name: 'candy_stripes',
  body: 'let t = bitcast<f32>(extra_words[b + 1u]); return MaterialFull(stripe(p.x, t), bitcast<f32>(extra_words[b + 0u]), 0.4, vec3f(0.0), 0.0);',
  helpers: [{ id: 'stripe', wgsl: 'fn stripe(x: f32, t: f32) -> vec3f { return vec3f(fract(x * t)); }' }],
  constants: [0, 1065353216],
  fields: ['base_color', 'metallic', 'roughness', 'emissive', 'height'],
}

test('fieldMaterialWgsl embeds the label graphs at module scope and blends the heaviest labels', () => {
  const out = fieldMaterialWgsl({ program: program(), labelGraphs: [STRIPES, null], debug: false })
  const main = out.wgsl.indexOf('fn material_main(')
  const before = out.wgsl.slice(0, main)
  const inside = out.wgsl.slice(main)
  for (const decl of ['struct SdfmMaterialFull', 'struct SdfmMatMasks', 'fn stripe(', 'fn pmf_graph_0(', 'fn pmf_label(', 'const PMF_K = array<u32, 2>(0u, 1065353216u);']) {
    assert.ok(before.includes(decl), `${decl} is declared before material_main`)
    assert.ok(!inside.includes(decl), `${decl} is not declared inside material_main`)
  }
  assert.ok(!out.wgsl.includes('extra_words'), 'constant reads go to PMF_K')
  assert.ok(!/MaterialFull\(/.test(out.wgsl.replace(/SdfmMaterialFull\(/g, '')), 'MAMA struct names are renamed')
  assert.match(out.wgsl, /PMF_K\[b \+ 1u\]/)
  assert.match(out.wgsl, /case 0u: \{ return pmf_graph_0\(0u, p, p, n, SdfmMatMasks\(0\.5, 1\.0, 1\.0, 0\.0, 1\.0\)\); \}/)
  assert.ok(!/case 1u:/.test(out.wgsl), 'a label without a graph reads its look from the data block')
  assert.ok(!out.wgsl.includes('sdfm.'), 'no RAA registry name appears in the WGSL')
  assert.equal(inside.match(/pmf_label\(/g)?.length, 1, 'the four heaviest labels share one pmf_label call site')
  assert.match(inside, /pmf_label\(db, p, n, u32\(picks\[k\]\)\)/)
})

test('fieldMaterialWgsl shares one body for the same graph and offsets each label constants', () => {
  const p = program()
  p.labels = [
    { material: 'candy_stripes', color: [1, 0, 0], roughness: 0.5, metallic: 0.1 },
    { material: 'candy_stripes_b', color: [0, 1, 0], roughness: 0.7, metallic: 0.2 },
  ]
  const other = { ...STRIPES, name: 'candy_stripes_b', constants: [7, 8] }
  const out = fieldMaterialWgsl({ program: p, labelGraphs: [STRIPES, other], debug: false })
  assert.equal(out.wgsl.match(/fn pmf_graph_\d+\(/g)?.length, 1)
  assert.equal(out.wgsl.match(/fn stripe\(/g)?.length, 1)
  assert.match(out.wgsl, /const PMF_K = array<u32, 4>\(0u, 1065353216u, 7u, 8u\);/)
  assert.match(out.wgsl, /case 1u: \{ return pmf_graph_0\(2u,/)
  const wrong = { ...STRIPES, fields: ['base_color'] }
  assert.throws(() => fieldMaterialWgsl({ program: p, labelGraphs: [wrong, null], debug: false }), /MaterialFull fields/)
})

test('fieldMaterialWgsl is deterministic and names depend on label graphs and debug', () => {
  const a = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: false })
  const b = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: false })
  assert.equal(a.functionName, b.functionName)
  assert.equal(a.wgsl, b.wgsl)

  // Label looks live in the data block: parts with other colours share the same function.
  const otherLabels = program()
  otherLabels.labels = [
    { material: null, color: [0, 0, 1], roughness: 0.5, metallic: 0.1 },
    { material: null, color: [0, 1, 0], roughness: 0.7, metallic: 0.2 },
  ]
  const labels = fieldMaterialWgsl({ program: otherLabels, labelGraphs: [null, null], debug: false })
  assert.equal(a.functionName, labels.functionName)
  assert.notEqual(a.functionName, fieldMaterialWgsl({ program: program(), labelGraphs: [STRIPES, null], debug: false }).functionName)

  const debug = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: true })
  assert.notEqual(a.functionName, debug.functionName)
  assert.match(debug.wgsl, /o\.base_color = n \* 0\.5 \+ vec3f\(0\.5\)/)
})

test('fieldGridTexture describes the rgba8 grid, or null without a grid', () => {
  const p = program()
  const texture = fieldGridTexture(p)
  assert.notEqual(texture, null)
  assert.equal(texture?.width, 16)
  assert.equal(texture?.height, 16)
  assert.equal(texture?.data.length, 16 * 16 * 4)
  assert.equal(texture?.data, p.grid?.texels)
  assert.equal(fieldGridTexture({ ...p, grid: null }), null)
})

test('fieldInstanceParams keeps the volume layout with the grid handle', () => {
  const p = program()
  const params = fieldInstanceParams(7, p)
  assert.equal(params.length, 16)
  assert.deepEqual(params.slice(0, 3), [-1, -1, -1])
  assert.equal(params[7], 7)
  assert.equal(params[8], 16)
  assert.equal(params[9], 16)
  assert.equal(params[12], 1)

  const none = fieldInstanceParams(null, { ...p, grid: null })
  assert.equal(none.length, 16)
  assert.equal(none[7], 0)
  assert.equal(none[8], 0)
  assert.equal(none[12], 0)
})


test('capture bounds guard rejects clipped, empty and distant poses and fits both hammer poses', () => {
  const source = readFileSync(new URL('../src/game/checks/fieldShading.ts', import.meta.url), 'utf8')
  const functions = source.slice(source.indexOf('function boundCorners('), source.indexOf('function pageErrors()'))
  const compiled = transpileModule('const WIDTH = 1920, HEIGHT = 1080\n' + functions, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText
  const exports: any = {}
  runInNewContext(compiled, { exports })
  const camera = { eye: [4, 3, 4], target: [0, 1, 0], fovYDeg: 60, near: 0.1, far: 500 }
  const bounds = [{ key: 'arm', min: [-0.3, 0, -0.3], max: [0.3, 7, 0.3] },
    { key: 'head', min: [-2, -1, -1], max: [2, 1, 1] }]
  assert.throws(() => exports.guardFraming('empty', camera, []), /bounds.empty/)
  assert.throws(() => exports.guardFraming('clipped', camera, bounds), /bounds.outside/)
  assert.throws(() => exports.guardFraming('small', { ...camera, eye: [100, 100, 100] }, bounds), /bounds.small/)
  for (const pose of [bounds, bounds.map(b => ({ ...b, min: b.min.map(v => v + 5), max: b.max.map(v => v + 5) }))]) {
    const fitted = exports.fitBounds(camera, pose)
    assert.ok(exports.guardFraming('posed', fitted, pose) >= 0.15)
  }
})


test('world capture guard refuses missing repeated draws, unnamed fallbacks and unfinished swaps', async () => {
  const { assertCompleteFieldCapture: guard } = await import('../src/content/shadingStatus.ts')
  const expected = ['candy.tower#g/body', 'candy.tower#g/body', 'candy.floor#g/base']
  const draws = expected.map(key => ({ key, mode: 'field', reason: undefined as string | undefined }))
  assert.doesNotThrow(() => guard(expected, draws))
  assert.throws(() => guard(expected, draws.slice(1)), /missing candy.tower/)
  assert.throws(() => guard(expected, [...draws, draws[0]]), /unexpected candy.tower/)
  draws[0].mode = 'vertex'
  assert.throws(() => guard(expected, draws), /unnamed vertex fallback/)
  draws[0].reason = 'field pipeline pending'
  assert.throws(() => guard(expected, draws), /field pipeline pending/)
  draws[0].reason = 'atlas budget: smaller parts first'
  assert.doesNotThrow(() => guard(expected, draws), 'runtime fallback must retain and name the geometry')
  draws[0].reason = 'operand with a lattice, deformer or non-uniform scale'
  assert.doesNotThrow(() => guard(expected, draws))
})
