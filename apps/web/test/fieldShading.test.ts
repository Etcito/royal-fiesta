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
  const out = fieldMaterialWgsl({ program: program(), labelFunctions: [null, null], debug: false })
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

test('fieldMaterialWgsl blends graph materials with a switch of the heaviest labels', () => {
  const out = fieldMaterialWgsl({ program: program(), labelFunctions: ['mat_candy', null], debug: false })
  assert.match(out.wgsl, /struct SdfmMaterialFull/)
  assert.match(out.wgsl, /switch i \{/)
  assert.match(out.wgsl, /case 0u: \{ return mat_candy\(p, n\); \}/)
  assert.match(out.wgsl, /case 1u: \{ return SdfmMaterialFull/)
})

test('fieldMaterialWgsl is deterministic and names depend on labels and debug', () => {
  const a = fieldMaterialWgsl({ program: program(), labelFunctions: [null, null], debug: false })
  const b = fieldMaterialWgsl({ program: program(), labelFunctions: [null, null], debug: false })
  assert.equal(a.functionName, b.functionName)
  assert.equal(a.wgsl, b.wgsl)

  const otherLabels = program()
  otherLabels.labels = [
    { material: null, color: [0, 0, 1], roughness: 0.5, metallic: 0.1 },
    { material: null, color: [0, 1, 0], roughness: 0.7, metallic: 0.2 },
  ]
  const labels = fieldMaterialWgsl({ program: otherLabels, labelFunctions: [null, null], debug: false })
  assert.notEqual(a.functionName, labels.functionName)

  const debug = fieldMaterialWgsl({ program: program(), labelFunctions: [null, null], debug: true })
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
