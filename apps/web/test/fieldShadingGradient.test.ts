import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import test from 'node:test'
import {
  PMF_INTERPRETER_WGSL, PMF_PRUNED_INTERPRETER_WGSL, PMF_PAIRED_INTERPRETER_WGSL, PMF_PRUNED_PAIRED_INTERPRETER_WGSL,
  fieldPruningEnabled, fieldGridPairsEnabled, fieldGridTexture, fieldProgramWords, type FieldGridOperandLike, type FieldProgramLike, type FieldTreeNodeLike,
} from '../src/sdf/fieldShading.ts'

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
fn pmf_grid(x: i32, y: i32) -> vec4f {
  grid_reads += 1u;
  let texel = atlas[1u + u32(y) * atlas[0] + u32(x)];
  return vec4f(f32((texel >> 24u) & 255u), f32((texel >> 16u) & 255u), f32((texel >> 8u) & 255u), f32(texel & 255u)) / 255.0;
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
const shaders = [
  [PMF_INTERPRETER_WGSL, PMF_PRUNED_INTERPRETER_WGSL],
  [PMF_PAIRED_INTERPRETER_WGSL, PMF_PRUNED_PAIRED_INTERPRETER_WGSL],
].map(modes => modes.map(mode => instrument(kernel.replace(PMF_INTERPRETER_WGSL, mode))))

function sample(program: FieldProgramLike, points: Point[], prune = false, pairGrid = false) {
  const data = fieldProgramWords(program, prune)
  assert.ok(data.ok)
  const { width, height, data: texels } = fieldGridTexture(program, pairGrid) ?? { width: 0, height: 0, data: new Uint8Array(0) }
  const atlas = new Uint32Array(1 + width * height)
  atlas[0] = width
  for (let i = 0; i < width * height; i++) {
    const at = 4 * i
    atlas[i + 1] = texels[at] * 2 ** 24 + texels[at + 1] * 2 ** 16 + texels[at + 2] * 256 + texels[at + 3]
  }
  const output = new Float32Array(14 * points.length).fill(NaN)
  new WgslExec(shaders[Number(pairGrid)][Number(prune)]).dispatchWorkgroups('sample_field', points.length, {
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


test('paired grid texels halve atlas reads with identical field outputs and untouched source bytes', t => {
  assert.equal(fieldGridPairsEnabled('?normals=field'), true)
  assert.equal(fieldGridPairsEnabled('?normals=field&fieldGridPairs=0'), false)
  const assets = [
    savedSurface('assets/common/penguin.body.mesh'),
    savedSurface('assets/candy/candy.floor-tile.mesh'),
    { program: fixture(), points: [[0, 0, 0], [-0.68, 0.9, -0.73], [0.68, -0.15, 0.22], [0, -0.15, 0.22]] as Point[] },
  ]
  for (const [index, { program, points }] of assets.entries()) {
    const original = program.grid!.texels.slice()
    for (const prune of [false, true]) {
      const full = sample(program, points, prune)
      const paired = sample(program, points, prune, true)
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
