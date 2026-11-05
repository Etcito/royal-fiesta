// Field shading: structural check, generated material text, grid texture and instance params.
// No GPU and no MAMA: the program fixture is the structural contract 'mama.field-program'.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PMF_GRID_HOST_WGSL, checkFieldPart, fieldGridTexture, fieldInstanceParams, fieldMaterialWgsl,
  type FieldProgramLike,
} from '../src/sdf/fieldShading.ts'

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

test('fieldMaterialWgsl embeds the evaluator, six taps, the fallback and pmf_grid', () => {
  const out = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: false })
  assert.match(out.wgsl, new RegExp(`${FUNCTION}\\(p, &w\\)`))
  const taps = out.wgsl.match(/pmf_tap\(p [-+] [xyz]\)/g) ?? []
  assert.equal(taps.length, 6)
  assert.match(out.wgsl, /inside && glen > 1e-6/)
  assert.match(out.wgsl, /fn pmf_grid\(x: i32, y: i32\) -> vec4f/)
  assert.ok(out.wgsl.includes(PMF_GRID_HOST_WGSL))
  assert.match(out.wgsl, /sdfm_posed_normal/)
  assert.match(out.wgsl, /base \+= w\[0\] \* vec3f\(1\.0, 0\.0, 0\.0\)/)
  assert.match(out.wgsl, /roughness \+= w\[1\] \* 0\.7/)
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
  assert.match(out.wgsl, /case 1u: \{ return SdfmMaterialFull/)
  assert.ok(!out.wgsl.includes('sdfm.'), 'no RAA registry name appears in the WGSL')
  assert.match(inside, /pmf_label\(p, n, u32\(i0\)\)/)
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

test('fieldMaterialWgsl is deterministic and names depend on labels and debug', () => {
  const a = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: false })
  const b = fieldMaterialWgsl({ program: program(), labelGraphs: [null, null], debug: false })
  assert.equal(a.functionName, b.functionName)
  assert.equal(a.wgsl, b.wgsl)

  const otherLabels = program()
  otherLabels.labels = [
    { material: null, color: [0, 0, 1], roughness: 0.5, metallic: 0.1 },
    { material: null, color: [0, 1, 0], roughness: 0.7, metallic: 0.2 },
  ]
  const labels = fieldMaterialWgsl({ program: otherLabels, labelGraphs: [null, null], debug: false })
  assert.notEqual(a.functionName, labels.functionName)

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
