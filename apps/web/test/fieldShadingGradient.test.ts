import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import test from 'node:test'
import {
  PMF_INTERPRETER_WGSL, fieldInterpreterWgsl, fieldMaterialWgsl, fieldVectorWeightsEnabled,
  fieldPruningEnabled, fieldGridPairsEnabled, fieldGridTexture, fieldProgramWords, fieldStep, smoothFieldGridTexture,
  type FieldGridOperandLike, type FieldOperandLike, type FieldProgramLike, type FieldTreeNodeLike,
} from '../src/sdf/fieldShading.ts'
import { repackFieldProgram, sampleFieldGrid } from '../src/sdf/fieldAtlas.ts'
import { fieldUnionGuards } from '../src/sdf/fieldBounds.ts'

// Use the package's ESM build for CPU execution of the generated WGSL.
const modulePath = 'wgsl_reflect/wgsl_reflect.module.js'
const { WgslExec, WgslParser } = await import(modulePath) as typeof import('wgsl_reflect')

type Point = [number, number, number]
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const inv = [0, 0.8, 0.1, 0, -1.1, 0, 0, 0, 0, 0.2, 1.2, 0, 0.04, -0.02, 0.03, 1]
const leaf = (operand: number): FieldTreeNodeLike => ({ op: 'leaf', operand })

function fixture(): FieldProgramLike {
  const width = 22, height = 5
  const texels = new Uint8Array(width * height * 4)
  const distances = [
    (x: number, y: number, z: number) => 0.55*x + 0.3*y - 0.15*z + 0.25*x*y - 0.1*y*z + 0.05*x*z + 0.035,
    (x: number, y: number, z: number) => -0.45*x + 0.5*y + 0.4*z + 0.18*x*z - 0.24*x*y + 0.12*y*z - 0.02,
  ]
  const operands = distances.map((distance, label): FieldGridOperandLike => {
    const at: [number, number] = [1 + 11 * label, 1]
    const range = 2
    for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const d = distance(0.5 * (x - 1), 0.5 * (y - 1), 0.5 * (z - 1))
      const encoded = Math.round((0.5 + 0.5 * d / range) * 65535)
      const offset = 4 * ((at[1] + y) * width + at[0] + 3 * z + x)
      texels[offset] = encoded >> 8
      texels[offset + 1] = encoded & 255
    }
    return { kind: 'grid', label, at, range, inv: label === 0 ? identity : inv, scale: label === 0 ? 1 : 1.4,
      origin: [-0.75, -0.75, -0.75], voxel: 0.5, size: [3, 3, 3] }
  })
  return {
    format: 'mama.field-program', version: 1,
    bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    labels: [{ material: null, color: [1, 0, 0], metallic: 0, roughness: 0.5 },
      { material: null, color: [0, 1, 0], metallic: 0, roughness: 0.5 }],
    grid: { width, height, texels }, operands, tree: [leaf(0)],
    functionName: 'pmf_eval_0123456789abcdef', wgsl: '',
  }
}

const kernel = `
@group(0) @binding(0) var<storage, read> words: array<f32>;
@group(0) @binding(1) var<storage, read> atlas: array<u32>;
@group(0) @binding(2) var<storage, read> points: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;

var<private> grid_reads: u32;
var<private> operand_visits: u32;
fn raa_material_f32(i: u32) -> f32 { return words[i]; }
fn pmf_load(x: i32, y: i32) -> vec4f {
  let texel = atlas[min(arrayLength(&atlas) - 1u, 1u + u32(y) * atlas[0] + u32(x))];
  return vec4f(f32((texel >> 24u) & 255u), f32((texel >> 16u) & 255u), f32((texel >> 8u) & 255u), f32(texel & 255u)) / 255.0;
}
fn pmf_grid(x: i32, y: i32) -> vec4f {
  grid_reads += 1u;
  return pmf_load(x, y);
}
fn pmf_grid_uv(p: vec2f) -> vec4f {
  grid_reads += 1u;
  let i = vec2i(floor(p));
  let t = fract(p);
  if (t.x == 0.0 && t.y == 0.0) { return pmf_load(i.x, i.y); }
  return mix(mix(pmf_load(i.x, i.y), pmf_load(i.x + 1, i.y), t.x),
    mix(pmf_load(i.x, i.y + 1), pmf_load(i.x + 1, i.y + 1), t.x), t.y);
}
${PMF_INTERPRETER_WGSL}

@compute @workgroup_size(1) fn sample_field(@builtin(global_invocation_id) id: vec3u) {
  let i = 3u * id.x;
  let j = 14u * id.x;
  let p = vec3f(points[i], points[i + 1u], points[i + 2u]);
  var weights: array<f32, 8>;
  grid_reads = 0u;
  operand_visits = 0u;
  let s = pmf_run(0u, p, &weights);
  output[j] = s.d;
  output[j + 1u] = s.g.x;
  output[j + 2u] = s.g.y;
  output[j + 3u] = s.g.z;
  output[j + 4u] = f32(s.seam);
  for (var i = 0u; i < 8u; i++) { output[j + 5u + i] = weights[i]; }
  output[j + 13u] = f32(grid_reads * 1024u + operand_visits);
}
`
function instrument(source: string) {
  return WgslParser.Parse(source.replace('sd[top] = pmf_operand', 'operand_visits += 1u; sd[top] = pmf_operand'))
}
const shaders = new Map<string, ReturnType<typeof instrument>>()
function interpreter(prune: boolean, pairGrid: boolean, vectorWeights: boolean, smoothGrid: boolean) {
  const key = `${prune}/${pairGrid}/${vectorWeights}/${smoothGrid}`
  let ast = shaders.get(key)
  if (!ast) {
    ast = instrument(kernel.replace(PMF_INTERPRETER_WGSL, fieldInterpreterWgsl({ prune, pairGrid, vectorWeights, smoothGrid })))
    shaders.set(key, ast)
  }
  return ast
}

function sample(program: FieldProgramLike, points: Point[], prune = false, pairGrid = false, vectorWeights = false, smoothGrid = false) {
  if (smoothGrid) program = repackFieldProgram(program, 0, 1, true)
  const smooth = smoothGrid ? smoothFieldGridTexture(program, pairGrid) : null
  const data = fieldProgramWords(program, prune, smooth?.gradientRanges)
  assert.ok(data.ok)
  const { width, height, data: texels } = (smooth === null ? fieldGridTexture(program, pairGrid) : smooth.grid) ??
    { width: 0, height: 0, data: new Uint8Array(0) }
  const atlas = new Uint32Array(1 + width * height)
  atlas[0] = width
  for (let i = 0; i < width * height; i++) {
    const at = 4 * i
    atlas[i + 1] = texels[at] * 2 ** 24 + texels[at + 1] * 2 ** 16 + texels[at + 2] * 256 + texels[at + 3]
  }
  const output = new Float32Array(14 * points.length).fill(NaN)
  new WgslExec(interpreter(prune, pairGrid, vectorWeights, smoothGrid)).dispatchWorkgroups('sample_field', points.length, {
    0: { 0: new Float32Array(data.words.buffer), 1: atlas, 2: Float32Array.from(points.flat()), 3: output },
  })
  return points.map((_, i) => {
    const [d, x, y, z, seam, ...tail] = output.subarray(14 * i, 14 * i + 14)
    const counts = tail[8]
    return { d, gradient: [x, y, z], seam: seam === 1, weights: tail.slice(0, program.labels.length),
      reads: Math.floor(counts / 1024), visits: counts % 1024 }
  })
}

function close(actual: number, expected: number, context: string, tolerance = 2e-4) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${context}: got ${actual}, expected ${expected}`)
}

// Estimate the gradient from distance alone by perturbing each part-space coordinate.
function checkGradient(program: FieldProgramLike, point: Point, name: string) {
  const h = 0.001
  const neighbors = [0, 1, 2].flatMap(axis => [-h, h].map(delta => {
    const p: Point = [...point]
    p[axis] += delta
    return p
  }))
  const [center, ...taps] = sample(program, [point, ...neighbors])
  for (let axis = 0; axis < 3; axis++) {
    const estimated = (taps[2 * axis + 1].d - taps[2 * axis].d) / (2 * h)
    close(center.gradient[axis], estimated, `${name} axis ${axis}`)
  }
  return center
}

test('the eight quantized grid corners also give the gradient through interpolation, clamping and the operand transform', () => {
  const program = fixture()
  for (const p of [[0.12, -0.15, 0.22], [-0.21, 0.33, -0.18], [0.68, -0.15, 0.22], [-0.68, 0.9, -0.73]] as Point[]) {
    for (let i = 0; i < 2; i++) {
      const result = checkGradient({ ...program, tree: [leaf(i)] }, p, `grid ${i} at ${p}`)
      assert.equal(result.seam, false)
      assert.deepEqual(result.weights, i === 0 ? [1, 0] : [0, 1])
    }
  }
})

test('rounded box gradients are correct both outside and at each dominant interior face', () => {
  const program = fixture()
  program.operands = [{ kind: 'box', label: 0, half: [0.7, 0.8, 1], radius: 0.12, inv, scale: 1.4 }]
  for (const p of [[0.1, 1.2, -1.1], [0.1, 0.25, 0.1], [-0.7, 0.1, 0.1], [0.1, -0.1, 0.6]] as Point[]) {
    checkGradient(program, p, `box at ${p}`)
  }
})

test('all CSG sign flips and blend slopes agree with finite differences on a tree of sampled operands', () => {
  const program = fixture()
  const near: Point = [0.12, -0.15, 0.22]
  const far: Point = [-0.24, 0.23, -0.17]
  for (const op of ['union', 'intersect', 'subtract'] as const) {
    for (const mode of ['hard', 'smooth', 'round', 'chamfer']) {
      for (const p of [near, far]) {
        const result = checkGradient({ ...program, tree: [leaf(0), leaf(1), { op, mode, radius: 0.4 }] }, p, `${op} ${mode} at ${p}`)
        close(result.weights[0] + result.weights[1], 1, 'normalized labels')
        if (op === 'subtract') assert.deepEqual(result.weights, [1, 0])
        else if (mode !== 'hard') assert.ok(result.weights.every(w => w > 0 && w < 1))
      }
    }
  }
  for (const [mode, radius, p] of [
    ['smooth', 0.005, near], ['round', 0.005, near], ['round', 0.07, near], ['chamfer', 0.005, far],
  ] as const) {
    checkGradient({ ...program, tree: [leaf(0), leaf(1), { op: 'union', mode, radius }] }, p, `${mode} outside blend core`)
  }
  const blend = { op: 'union', mode: 'smooth', radius: 0.4 } as const
  const soft = checkGradient({ ...program, tree: [leaf(0), leaf(1), blend, leaf(1),
    { op: 'subtract', mode: 'round', radius: 0.2 }] }, near, 'nested CSG')
  const stepped = checkGradient({ ...program, tree: [leaf(0), leaf(1), { ...blend, colour: 'hard' }, leaf(1),
    { op: 'subtract', mode: 'round', radius: 0.2 }] }, near, 'nested CSG with hard color')
  assert.deepEqual(soft.gradient, stepped.gradient)
  assert.deepEqual(stepped.weights, [1, 0])
  assert.ok(soft.weights[1] > 0)
})

test('only contributing grid seams propagate through the tree', () => {
  const program = fixture()
  const p: Point = [0, -0.15, 0.22]
  const [atSeam, nearSeam, offSeam, atEdge] = sample(program, [p, [0.004, -0.15, 0.22],
    [0.006, -0.15, 0.22], [0.5, -0.15, 0.22]])
  assert.deepEqual([atSeam.seam, nearSeam.seam, offSeam.seam, atEdge.seam], [true, true, false, true])
  for (const [op, mode, expected] of [['union', 'hard', true], ['intersect', 'hard', false],
    ['intersect', 'smooth', true]] as const) {
    const [result] = sample({ ...program, tree: [leaf(0), leaf(1), { op, mode, radius: 0.4 }] }, [p])
    assert.equal(result.seam, expected, `${op} ${mode}`)
  }
})


function compareSamples(actual: ReturnType<typeof sample>[number], old: ReturnType<typeof sample>[number], message: string) {
  close(actual.d, old.d, message, 1e-5)
  actual.gradient.forEach((value, i) => close(value, old.gradient[i], message, 1e-5))
  assert.equal(actual.seam, old.seam, message)
  actual.weights.forEach((value, i) => close(value, old.weights[i], message, 1e-5))
}

function savedSurface(path: string) {
  const mesh = decodeMesh(new Uint8Array(readFileSync(path))) as unknown as {
    data: { groups: { parts: { fieldProgram: FieldProgramLike; meshes: { positions: Float32Array; indices: Uint32Array }[] }[] }[] }
  }
  const part = mesh.data.groups[0].parts.find(p => p.fieldProgram)!
  const points = part.meshes.flatMap(mesh => {
    const points: Point[] = []
    const step = Math.ceil(mesh.indices.length / 3 / 12)
    for (let t = 0; 3 * t < mesh.indices.length; t += step) {
      const offset = [...mesh.indices.subarray(3 * t, 3 * t + 3)].map(i => 3 * i)
      points.push([0, 1, 2].map(k => offset.reduce((sum, i) => sum + mesh.positions[i + k], 0) / 3) as Point)
    }
    return points
  })
  return { program: part.fieldProgram, points }
}

test('bounded field traversal matches the full distance, gradient, seams and labels on saved surfaces and near CSG ties', t => {
  assert.equal(fieldPruningEnabled('?normals=field'), true)
  assert.equal(fieldPruningEnabled('?normals=field&fieldPrune=0'), false)
  for (const path of ['assets/common/penguin.body.mesh', 'assets/candy/candy.floor-tile.mesh', 'assets/candy/candy.floor-disc.mesh']) {
    const { program, points } = savedSurface(path)
    const full = sample(program, points)
    const pruned = sample(program, points, true)
    pruned.forEach((value, i) => compareSamples(value, full[i], `${path} sample ${i}`))
    const mean = (all: typeof full, key: 'reads' | 'visits') => (all.reduce((sum, s) => sum + s[key], 0) / all.length).toFixed(2)
    t.diagnostic(`${path} (${points.length} centroids), grid reads ${mean(full, 'reads')} → ${mean(pruned, 'reads')}; operands ${mean(full, 'visits')} → ${mean(pruned, 'visits')}`)
    assert.ok(pruned.some((value, i) => value.reads < full[i].reads))
  }

  const program = fixture()
  const first = program.operands[0] as FieldGridOperandLike
  program.operands = [first, { ...first, label: 1 }, {
    ...first, label: 1, inv: [...identity.slice(0, 12), -10, 0, 0, 1],
  }]
  const points: Point[] = [[0, 0, 0], [0.12, -0.15, 0.22], [-0.4, 0.1, -0.38], [5, 0, 0], [10, 0, 0]]
  for (const mode of ['hard', 'smooth', 'round', 'chamfer']) {
    const union = { op: 'union', mode, radius: 0.5 } as const
    const p = { ...program, tree: [leaf(0), leaf(1), leaf(2), union, union] }
    const full = sample(p, points)
    sample(p, points, true).forEach((value, i) => compareSamples(value, full[i], `${mode} sample ${i}`))
  }
})


test('paired grids and vector weights retain live field outputs and halve atlas reads', t => {
  assert.equal(fieldGridPairsEnabled('?normals=field'), true)
  assert.equal(fieldGridPairsEnabled('?normals=field&fieldGridPairs=0'), false)
  assert.equal(fieldVectorWeightsEnabled('?normals=field'), true)
  assert.equal(fieldVectorWeightsEnabled('?normals=field&fieldVectorWeights=0'), false)
  const mixed = fixture()
  const [a, b] = mixed.operands
  mixed.labels = [...mixed.labels, ...Array.from({ length: 6 }, () => mixed.labels[0])]
  mixed.operands = [a, { ...b, label: 7 }]
  mixed.tree = [leaf(0), leaf(1), { op: 'union', mode: 'smooth', radius: 0.4 }]
  const assets = [
    savedSurface('assets/common/penguin.body.mesh'),
    savedSurface('assets/candy/candy.floor-tile.mesh'),
    { program: mixed, points: [[0, 0, 0], [-0.68, 0.9, -0.73], [0.68, -0.15, 0.22], [0, -0.15, 0.22]] as Point[] },
  ]
  for (const [index, { program, points }] of assets.entries()) {
    const original = program.grid!.texels.slice()
    const material = fieldMaterialWgsl({ program, debug: false, labelGraphs: [], normals: 'gradient', prune: true, pairGrid: true, vectorWeights: true })
    assert.match(material.wgsl, /var sw_low: array<vec4f/)
    assert.match(material.wgsl, /upper_z\[k\] = pair.y/)
    for (const prune of [false, true]) {
      const full = sample(program, points, prune)
      const paired = sample(program, points, prune, true)
      const optimized = sample(program, points, prune, true, true)
      optimized.forEach((value, i) => {
        compareSamples(value, paired[i], `vector fixture ${index} sample ${i}`)
        assert.equal(value.reads, paired[i].reads)
        assert.equal(value.visits, paired[i].visits)
      })
      paired.forEach((value, i) => {
        compareSamples(value, full[i], `fixture ${index} sample ${i}`)
        assert.equal(value.visits, full[i].visits)
        assert.equal(value.reads * 2, full[i].reads)
      })
      if (prune) {
        const avg = paired.reduce((sum, value) => sum + value.reads, 0) / points.length
        t.diagnostic(`fixture ${index} with pruning and packing: ${avg.toFixed(2)} atlas samples per traversal`)
      }
    }
    assert.deepEqual(program.grid!.texels, original)
  }
})

const axes = [0, 1, 2] as const
const xyz = (fn: (axis: 0 | 1 | 2) => number): Point => [fn(0), fn(1), fn(2)]
const dot = (a: readonly number[], b: readonly number[]) => axes.reduce<number>((s, axis) => s + a[axis] * b[axis], 0)
const mag = (v: readonly number[]) => Math.hypot(...v)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const unit = (v: readonly number[]): Point => { const length = mag(v) || 1; return xyz(a => v[a] / length) }
const angle = (a: readonly number[], b: readonly number[]) => 180 / Math.PI * Math.acos(clamp(dot(unit(a), unit(b)), -1, 1))

test('confidence rotates a weak field normal gradually and never normalizes a zero vector', () => {
  const material = fieldMaterialWgsl({ program: fixture(), labelGraphs: [], debug: false }).wgsl
  const blend = material.match(/fn pmf_normal_blend\([\s\S]*?\n\}/)?.[0]
  assert.ok(blend)
  const source = `${blend}
    @group(0) @binding(0) var<storage, read_write> angles: array<f32>;
    @compute @workgroup_size(1) fn check() {
      let n = vec3f(0.0, 1.0, 0.0);
      let field = vec3f(1.0, 0.0, 0.0);
      angles[0] = dot(n, pmf_normal_blend(n, field, 0.04));
      angles[1] = dot(n, pmf_normal_blend(n, field, 0.15));
      angles[2] = dot(n, pmf_normal_blend(n, field, 0.25));
      angles[3] = dot(n, pmf_normal_blend(n, -n, 0.15));
      angles[4] = dot(n, pmf_normal_blend(n, field, 0.0501));
    }`
  const output = new Float32Array(5)
  new WgslExec(WgslParser.Parse(source)).dispatchWorkgroups('check', 1, { 0: { 0: output } })
  const expected = [1, Math.SQRT1_2, 0, 1, 1]
  expected.forEach((v, i) => close(output[i], v, `confidence result ${i}`))
})

test('the smooth shader blends central-difference corner gradients continuously and keeps the distance and weights', () => {
  // An exact sphere sampled on a coarse lattice; choose points across an interior face and an exterior face.
  const p = fixture()
  const size = 9, voxel = 0.25, range = 2
  const op: FieldGridOperandLike = { kind: 'grid', label: 0, at: [0, 0], range, inv: identity, scale: 1,
    origin: xyz(() => -size * voxel / 2), voxel, size: xyz(() => size) }
  p.operands = [op]
  const texels = new Uint8Array(size ** 3 * 4)
  for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 4, y - 4, z - 4) * voxel - 0.73
    const q = Math.round((d / range + 1) * 65535 / 2)
    const i = 4 * (y * size ** 2 + z * size + x)
    texels[i] = q >> 8
    texels[i + 1] = q & 255
  }
  p.grid = { width: size ** 2, height: size, texels }
  const points: Point[] = [
    [0.5 - 1e-5, 0.32, 0.41], [0.5 + 1e-5, 0.32, 0.41], [0.02, 0.71, 0.1],
    [1 - 1e-5, 0.32, 0.41], [1 + 1e-5, 0.32, 0.41], [1.25, 0.32, 0.41],
  ]
  const legacy = sample(p, points)
  for (const paired of [false, true]) {
    const filtered = sample(p, points, false, paired, true, true)
    filtered.forEach((at, i) => {
      close(at.d, legacy[i].d, 'linear filtering of the 16-bit distance')
      assert.deepEqual(at.weights, legacy[i].weights)
      assert.equal(at.seam, false)
      assert.equal(at.reads, paired ? 3 : 4)
    })
    for (let i = 0; i < 3; i++) assert.ok(angle(filtered[i].gradient, points[i]) < 1.5)
    assert.ok(angle(legacy[0].gradient, legacy[1].gradient) > 5)
    assert.ok(angle(filtered[0].gradient, filtered[1].gradient) < 0.02)
    assert.ok(angle(filtered[3].gradient, filtered[4].gradient) < 0.02)
    assert.ok(angle(filtered[5].gradient, [1, 0, 0]) < 0.001)
    const corner: Point = [0.5, 0.25, 0.5]
    const [g] = sample(p, [corner], false, paired, true, true)
    for (const axis of axes) {
      const lo = xyz(i => corner[i] - (i === axis ? voxel : 0))
      const hi = xyz(i => corner[i] + (i === axis ? voxel : 0))
      const central = (sampleFieldGrid(p.grid, op, hi) - sampleFieldGrid(p.grid, op, lo)) / (2 * voxel)
      close(g.gradient[axis], central, 'corner central difference including its 8-bit quantization', 0.005)
    }
  }
})

type GridGeometry = { g: Point; c: Point; i: Point; t: Point }
type AuditSample = { d: number; gradient: Point; seam: boolean; leaves: [number, number][] }
const moved = (m: readonly number[], p: Point) => xyz(a => m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a])
const intoPart = (op: FieldOperandLike, g: Point) => xyz(a => op.scale * dot(op.inv.slice(4 * a, 4 * a + 3), g))
function gridGeometry(op: FieldGridOperandLike, p: Point): GridGeometry {
  const local = moved(op.inv, p)
  const g = xyz(a => (local[a] - op.origin[a]) / op.voxel - 0.5)
  const c = xyz(a => clamp(g[a], 0, op.size[a] - 1))
  const i = xyz(a => Math.min(Math.floor(c[a]), op.size[a] - 2))
  return { g, c, i, t: xyz(a => c[a] - i[a]) }
}

function penguinEvaluator(program: FieldProgramLike) {
  const packed = repackFieldProgram(program, 0, 1, true)
  const { grid, gradientRanges } = smoothFieldGridTexture(packed, true)
  const guards = fieldUnionGuards(packed)

  function gridSample(op: FieldGridOperandLike, index: number, p: Point, smooth: boolean): AuditSample {
    const { g, c, i, t } = gridGeometry(op, p)
    const delta = xyz(a => (g[a] - c[a]) * op.voxel)
    const outside = mag(delta)
    const meshGrid = grid!
    let d = 0
    const gradient: Point = [0, 0, 0]
    for (let k = 0; k < 8; k++) {
      const bits = xyz(a => (k >> a) & 1)
      const w = xyz(a => bits[a] ? t[a] : 1 - t[a])
      const at = 4 * ((op.at[1] + i[1] + bits[1]) * meshGrid.width + op.at[0] + (i[2] + bits[2]) * op.size[0] + i[0] + bits[0])
      const value = ((256 * meshGrid.data[at] + meshGrid.data[at + 1]) / 65535 * 2 - 1) * op.range
      const weight = w[0] * w[1] * w[2]
      d += value * weight
      for (const axis of axes) {
        gradient[axis] += smooth
          ? weight * (meshGrid.data[at + 4 * meshGrid.width * op.size[1] + axis] - 128) * gradientRanges[index] / 127
          : value * (2 * bits[axis] - 1) * w[(axis + 1) % 3] * w[(axis + 2) % 3] / op.voxel
      }
    }
    const reach = Math.max(op.voxel, outside)
    return { d: (d + outside) * op.scale, seam: !smooth && g.some((v, a) => Math.abs(v - Math.round(c[a])) <= 0.01),
      gradient: intoPart(op, xyz(a => smooth ? gradient[a] * (1 - outside / reach) + delta[a] / reach
        : (g[a] === c[a] ? gradient[a] : 0) + (outside > 0 ? delta[a] / outside : 0))), leaves: [[index, 1]] }
  }

  function boxSample(op: Extract<FieldOperandLike, { kind: 'box' }>, index: number, p: Point): AuditSample {
    const local = moved(op.inv, p)
    const q = xyz(a => Math.abs(local[a]) - op.half[a] + op.radius)
    const positive = xyz(a => Math.max(q[a], 0))
    const outside = mag(positive), top = Math.max(...q), face = q.indexOf(top)
    const vector = xyz(a => (local[a] < 0 ? -1 : 1) * (outside > 0 ? positive[a] / outside : Number(a === face)))
    return { d: (outside + Math.min(top, 0) - op.radius) * op.scale, gradient: intoPart(op, vector), seam: false, leaves: [[index, 1]] }
  }

  // The saved penguin has exactly hard/smooth unions. The other interpreter operations have tests above.
  function run(point: Point, smooth: boolean, prune = true, source?: (index: number, p: Point) => AuditSample | undefined) {
    let grids = 0
    const stack: AuditSample[] = []
    for (let k = 0; k < packed.tree.length; k++) {
      const guard = prune ? guards.get(k) : undefined
      if (guard !== undefined) {
        const { min, max, gain, offset, outsideOffset } = guard.bound
        const excess = Math.max(0, ...xyz(a => Math.max(min[a] - point[a], point[a] - max[a])))
        const band = 1e-5 * (1 + Math.max(...xyz(a => Math.max(Math.abs(point[a]), Math.abs(min[a]), Math.abs(max[a])))))
        const base = excess > band ? outsideOffset : offset
        const cut = stack.at(-1)!.d + guard.radius
        if (gain * excess + base > cut + 1e-5 * (1 + Math.abs(cut) + Math.abs(base)) + gain * band) {
          k = guard.target - 1
          continue
        }
      }
      const node = packed.tree[k]
      if (node.op === 'leaf') {
        const op = packed.operands[node.operand]
        if (op.kind === 'grid') grids++
        const value = source === undefined
          ? op.kind === 'grid' ? gridSample(op, node.operand, point, smooth) : boxSample(op, node.operand, point)
          : source(node.operand, point)
        if (value === undefined) return undefined
        stack.push(value)
      } else {
        assert.equal(node.op, 'union')
        assert.ok(node.mode === 'hard' || node.mode === 'smooth')
        const b = stack.pop()!, a = stack.pop()!
        const h = node.mode === 'hard' ? 0 : Math.max(0, 1 - Math.abs(a.d - b.d) / node.radius)
        const w = b.d < a.d ? 1 - h / 2 : h / 2
        stack.push({ d: Math.min(a.d, b.d) - node.radius * h * h / 4,
          gradient: xyz(axis => (1 - w) * a.gradient[axis] + w * b.gradient[axis]),
          seam: (w < 1 && a.seam) || (w > 0 && b.seam),
          leaves: [...a.leaves.map(([i, v]): [number, number] => [i, v * (1 - w)]),
            ...b.leaves.map(([i, v]): [number, number] => [i, v * w])].filter(([, v]) => v > 0) })
      }
    }
    return { ...stack[0], grids }
  }

  function taps(point: Point) {
    const h = fieldStep(program)
    const central = (p: Point) => xyz(a => {
      const lo = xyz(i => p[i] - (i === a ? h : 0))
      const hi = xyz(i => p[i] + (i === a ? h : 0))
      return (run(hi, false, false)!.d - run(lo, false, false)!.d) / (2 * h)
    })
    const centre = run(point, false, false)!.d
    const g = central(point)
    const l = mag(g)
    const corrected = l > 1e-6 ? xyz(a => point[a] - g[a] / l * clamp(centre / l, -2 * h, 2 * h)) : point
    return { point: corrected, d: run(corrected, false, false)!.d, gradient: central(corrected) }
  }
  return { run, taps, boxSample }
}

function confidenceNormal(mesh: Point, grad: Point): Point {
  const t = clamp((mag(grad) - 0.05) / 0.20, 0, 1)
  const w = t * t * (3 - 2 * t)
  const blend = xyz(a => mesh[a] * (1 - w) + unit(grad)[a] * w)
  return mag(blend) > 1e-6 ? unit(blend) : mesh
}

async function continuousPenguin(mama: string, program: FieldProgramLike, frame: number[]) {
  const load = (path: string) => import(pathToFileURL(resolve(mama, 'dist', path + '.js')).href)
  const [{ installCorePlugins }, { parseAssetFile }, { resolveMesherSettings }, { planParts }, { classicAsParamesh },
    { parameshPartInput }, { simulatedBooleanDocument }, { parameshQuality }, { isParametricSource }, { multiply }] = await Promise.all([
    'plugins/index', 'core/game/asset-file', 'core/game/mesher-params', 'core/mesh/parts', 'core/paramesh/classic',
    'core/paramesh/mesh-part', 'core/mesh/project-vertices', 'core/paramesh/settings', 'core/paramesh/viewport-mesh', 'core/math/mat4',
  ].map(load))
  const { createContinuousDistanceEvaluator, fromShapeData } = await import(pathToFileURL(resolve(mama, 'packages/paramesh-core/dist/index.js')).href)
  const { Vector3, Matrix4 } = await import(pathToFileURL(resolve(mama, 'node_modules/three/build/three.module.js')).href)
  installCorePlugins()
  const { document } = parseAssetFile(readFileSync('assets/common/penguin.body.asset.json', 'utf8'))
  document.settings = resolveMesherSettings(document, 'penguin')
  const doc = classicAsParamesh(document, { allModifiers: true })
  const plan = planParts(doc, 'single', false)[0]
  const carved = simulatedBooleanDocument(doc)
  const { input, operands } = parameshPartInput(carved, plan, parameshQuality(carved))
  assert.equal(input.sources.length, program.operands.length)
  function postfix(node: { kind: string; operand: number; op: string; a: typeof node; b: typeof node; blend: { mode: string; radius: number } }): unknown[] {
    return node.kind === 'leaf' ? [leaf(node.operand)] : [
      ...postfix(node.a), ...postfix(node.b), { op: node.op, mode: node.blend.mode, radius: node.blend.radius },
    ]
  }
  assert.deepEqual(postfix(input.tree), program.tree.map(n => n.op === 'leaf' ? n : { op: n.op, mode: n.mode, radius: n.radius }))
  const evaluate = program.operands.map((op, index) => {
    const source = input.sources[index]
    assert.ok(isParametricSource(source))
    const composed = multiply(Float64Array.from(source.matrix), Float64Array.from(op.inv))
    frame.forEach((v, component) => close(composed[component], v, `source ${index} transform`, 1e-7))
    return createContinuousDistanceEvaluator({ model: fromShapeData(JSON.parse(source.signature)), matrix: new Matrix4() })
  })
  return {
    names: operands.map((o: { shape: string }) => o.shape) as string[],
    sample(index: number, p: Point): AuditSample | undefined {
      const op = program.operands[index]
      const value = evaluate[index](new Vector3(...moved(op.inv, p)))
      return value === undefined ? undefined : { d: value.distance * op.scale, gradient: intoPart(op, value.normal.toArray()),
        seam: false, leaves: [[index, 1]] }
    },
  }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return [0.5, 0.9, 0.95, 0.99, 1].map(p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(3)).join('/')
}

test('saved penguin rest-space normals against Newton taps and the continuous source when RF_MAMA_DIR is set', async t => {
  const file = decodeMesh(new Uint8Array(readFileSync('assets/common/penguin.body.mesh'))) as unknown as {
    data: { groups: { parts: { fieldProgram: FieldProgramLike; frame: Float64Array;
      meshes: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }[] }[] }[] }
  }
  const { fieldProgram: program, frame, meshes } = file.data.groups[0].parts[0]
  const mama = process.env.RF_MAMA_DIR
  const reference = mama === undefined ? null : await continuousPenguin(mama, program, [...frame])
  const evaluator = penguinEvaluator(program)
  const points = meshes.flatMap(mesh => Array.from({ length: mesh.indices.length / 3 }, (_, tri) => {
    const indices = mesh.indices.subarray(3 * tri, 3 * tri + 3)
    const average = (stream: Float32Array): Point => xyz(a => (stream[3 * indices[0] + a] + stream[3 * indices[1] + a] + stream[3 * indices[2] + a]) / 3)
    return { p: average(mesh.positions), n: unit(average(mesh.normals)) }
  }))
  const errors = { gradientToTaps: [] as number[], smoothToTaps: [] as number[], gradientToSource: [] as number[],
    tapsToSource: [] as number[], smoothToSource: [] as number[] }
  type Row = { values: number[]; site: string }
  const faces: Row[] = [], bands: Row[] = []
  const cells = new Map<string, number[][]>()
  let fallback = 0, gridVisits = 0, projected = 0
  for (const { p, n } of points) {
    const old = evaluator.run(p, false)!
    const smooth = evaluator.run(p, true)!
    const taps = evaluator.taps(p)
    const previousNormal = (s: AuditSample) => s.seam || mag(s.gradient) <= 1e-6 ? n : s.gradient
    const oldNormal = previousNormal(old)
    const smoothNormal = confidenceNormal(n, smooth.gradient)
    const tapNormal = mag(taps.gradient) > 1e-6 ? taps.gradient : n
    if (oldNormal === n) fallback++
    if (Math.abs(taps.d) < Math.abs(old.d)) projected++
    gridVisits += old.grids
    const row = [angle(oldNormal, tapNormal), angle(smoothNormal, tapNormal)]
    errors.gradientToTaps.push(row[0])
    errors.smoothToTaps.push(row[1])
    const [owner] = old.leaves.reduce((a, b) => a[1] >= b[1] ? a : b)
    const op = program.operands[owner]
    const source = reference !== null ? evaluator.run(p, false, false, reference.sample)
      : old.leaves.length === 1 && op.kind === 'box' ? evaluator.boxSample(op, owner, p) : undefined
    if (source !== undefined) {
      row.push(angle(oldNormal, source.gradient), angle(tapNormal, source.gradient), angle(smoothNormal, source.gradient))
      errors.gradientToSource.push(row[2])
      errors.tapsToSource.push(row[3])
      errors.smoothToSource.push(row[4])
    }
    if (op.kind !== 'grid') continue
    const { g, i } = gridGeometry(op, p)
    const name = reference?.names[owner] ?? String(owner)
    const key = `${name}/${i.join(',')}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key)!.push(row)
    const interior = axes.filter(a => Math.round(g[a]) > 0 && Math.round(g[a]) < op.size[a] - 1)
    if (interior.length === 0) continue
    const axis = interior.reduce((a, b) => Math.abs(g[a] - Math.round(g[a])) <= Math.abs(g[b] - Math.round(g[b])) ? a : b)
    const plane = Math.round(g[axis])
    const normal = xyz(a => op.inv[axis + 4 * a])
    const across = (offset: number) => xyz(a => p[a] + (plane + offset - g[axis]) * op.voxel * normal[a] / dot(normal, normal))
    const compare = (a: number, b: number, displayed: boolean) => {
      const l = across(a), r = across(b)
      const p0 = evaluator.run(l, false)!, p1 = evaluator.run(r, false)!
      const s0 = confidenceNormal(n, evaluator.run(l, true)!.gradient)
      const s1 = confidenceNormal(n, evaluator.run(r, true)!.gradient)
      const pNormal = (sample: AuditSample) => displayed ? previousNormal(sample) : sample.gradient
      return { values: [angle(pNormal(p0), pNormal(p1)), angle(s0, s1)],
        site: `${key} axis ${'xyz'[axis]} plane ${plane} at (${across(0).map(n => n.toFixed(3))})` }
    }
    faces.push(compare(-1e-5, 1e-5, false))
    const side = g[axis] < plane ? -1 : 1
    bands.push(compare(side * 0.00999, side * 0.01001, true))
  }
  t.diagnostic(`${points.length} centroids, ${fallback} original mesh normal replacements, ${projected} Newton steps reduced |d|; voxel h=${fieldStep(program).toFixed(5)}`)
  t.diagnostic(`averaged ${(gridVisits / points.length).toFixed(3)} sampled operand visits with pruning, paired atlas reads ${(4 * gridVisits / points.length).toFixed(3)} → ${(3 * gridVisits / points.length).toFixed(3)} each pass`)
  for (const [name, values] of Object.entries(errors)) {
    if (values.length > 0) t.diagnostic(`${name} (${values.length}) P50/P90/P95/P99/max degrees ${distribution(values)}`)
  }
  for (let column = 0; column < 5; column++) {
    const rms = [...cells].flatMap(([key, rows]) => {
      const available = rows.filter(r => r[column] !== undefined)
      return available.length === 0 ? [] : [{ key, value: Math.sqrt(available.reduce((sum, r) => sum + r[column] ** 2, 0) / available.length) }]
    }).sort((a, b) => b.value - a.value)
    if (rms.length > 0) t.diagnostic(`per-cell RMS ${Object.keys(errors)[column]} (${rms.length} cells) ${distribution(rms.map(r => r.value))}, worst ${rms[0].key}`)
  }
  for (const [name, values] of [['lattice face, raw gradient', faces], ['edge of old seam band, shaded', bands]] as const) {
    const describe = (column: number) => {
      const [worst] = [...values].sort((a, b) => b.values[column] - a.values[column])
      return `${distribution(values.map(r => r.values[column]))}, max at ${worst.site}, >1° ${values.filter(r => r.values[column] > 1).length}`
    }
    t.diagnostic(`${name} (${values.length}): old ${describe(0)}; smooth ${describe(1)}`)
  }
  assert.equal(points.length, 2886)
  assert.ok(fallback > points.length / 20)
  assert.ok(faces.filter(face => face.values[1] > 1).length < faces.filter(face => face.values[0] > 1).length / 5)
  assert.ok(bands.filter(face => face.values[1] > 1).length < bands.filter(face => face.values[0] > 1).length / 5)
  const rms = (values: number[]) => Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length)
  assert.ok(rms(errors.smoothToTaps) < rms(errors.gradientToTaps))
  if (reference !== null) assert.ok(rms(errors.smoothToSource) < rms(errors.gradientToSource))
})
