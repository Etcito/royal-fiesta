import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
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
import { WGSL_RESERVED, wgslReservedNames } from '../src/sdf/wgslReserved.ts'
import * as atlas from '../src/sdf/fieldAtlas.ts'
import * as shading from '../src/sdf/fieldShading.ts'
import type { ResizablePort } from '../src/sdf/sdfPort.ts'

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

test('missing or stale sampled fields are named vertex fallbacks', () => {
  for (const over of [{ grid: null }, { version: 2 }, { grid: { width: 1, height: 1, texels: new Uint8Array(4) } }]) {
    const checked = checkFieldPart(part(over))
    assert.equal(checked.ok, false)
    if (!checked.ok) assert.match(checked.reason, /missing|version|outside/)
  }
  assert.equal(checkFieldPart({ normalVolume: {}, normalScheme: 'stale' }).ok, false)
})

test('runtime atlas fallback retains every drawable part and stays stable during movement', () => {
  // Exercise the actual port without a GPU or its virtual MAMA import.
  const source = readFileSync(new URL('../src/sdf/sdfPort.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source + `\nexports.make = (meshed, budget) => new SdfRenderPort(
    meshed, new Map(), null, { shading: 'field' }, null, budget, false)`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const api = {} as { make(meshed: unknown, budget: number): ResizablePort & { engine: unknown; target: unknown } }
  runInNewContext(compiled, {
    exports: api, Float32Array, Float64Array, Uint32Array, performance, console: { info() {}, warn() {} },
    require(id: string) {
      if (id === './fieldAtlas.ts') return atlas
      if (id === './fieldShading.ts') return shading
      if (id === '@etcito/raa-sdfm') return { fieldSurfaceAttributes: () => ({}) }
      if (id === '../render/asyncPipelines.ts') return { materialKey: () => 'field', fieldReadiness: () => ({ status: 'ready' }) }
      if (id === '@royal-fiesta/game/render/roundLoad') return {
        roundStep: (_: string, fn: () => unknown) => fn(), renderFrame: (_: unknown, fn: () => unknown) => fn(),
      }
      return {}
    },
  })
  const cheap = program(), expensive = program()
  expensive.operands = expensive.operands.map(o => o.kind === 'grid' ? { ...o, size: [8, 4, 4] } : o)
  expensive.grid = { width: 32, height: 4, texels: new Uint8Array(512) }
  const saved = cheap.grid!.texels.slice()
  const programs = [cheap, expensive, null, { ...program(), grid: null }, { ...program(), version: 2 }]
  const parts = programs.map((fieldProgram, i) => ({ name: `part-${i}`, partId: String(i), fieldProgram,
    frame: new Float64Array(IDENTITY), normalVolume: {}, normalScheme: 'stale', meshes: [{ material: null,
      positions: new Float32Array([0, 0, 0, i === 0 ? 10 : 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]), uvs: null }] }))
  for (const budget of [768, 512, 0]) {
    const port = api.make(new Map([['world', { assetId: 'world', data: { materials: [], groups: [{ group: 'g', parts }] } }]]), budget)
    let next = 0, textures = 0
    const visible = new Map<number, boolean>()
    const engine = new Proxy({
      addTexture() { textures++; return ++next },
      addMeshInstance() { const id = ++next; visible.set(id, true); return id },
      setVisible(id: number, on: boolean) { visible.set(id, on) },
      stats: () => ({ drawCalls: 0, triangles: 0, instances: visible.size }),
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => ++next) })
    port.engine = engine
    port.target = { viewports: [{}] }
    const handle = port.registerAsset('world', { id: 'world' } as Parameters<ResizablePort['registerAsset']>[1])
    const instances = [port.createInstance(handle, null), port.createInstance(handle, null)]
    const report = port.shadingReport()
    assert.equal(report.atlasFull, 0)
    assert.equal(report.field, budget === 768 ? 2 : budget === 512 ? 1 : 0)
    assert.equal(report.bytes, budget)
    assert.equal(textures, report.field, 'instances share their uploaded textures')
    assert.equal(port.drawnParts().length, parts.length * 2)
    assert.equal([...visible.values()].filter(Boolean).length, parts.length * 2)
    const before = port.drawnParts()
    if (budget === 512) assert.deepEqual(Array.from(before.slice(0, 2), p => p.mode), ['vertex', 'field'])
    port.setCamera(0, { eye: [10, 20, 30], target: [0, 0, 0], fovYDeg: 60, near: 0.1, far: 500 })
    port.setTransform(instances[0], [5, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    port.render()
    assert.deepEqual(port.drawnParts(), before)
    assert.deepEqual(port.shadingReport(), report)
    port.setShading('vertex')
    assert.ok(port.drawnParts().every(p => p.mode === 'vertex'))
    assert.equal([...visible.values()].filter(Boolean).length, parts.length * 2)
    assert.deepEqual(cheap.grid!.texels, saved)
  }
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
  assert.match(out.wgsl, /pmf_field\(db, p, h, scale, &w\)/)
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
        for (const debug of [false, true]) {
          const out = fieldMaterialWgsl({ program: check.program, labelGraphs: graphs, debug })
          assert.ok(new TextEncoder().encode(out.wgsl).length <= MATERIAL_FUNCTION_MAX_BYTES, file)
          assert.deepEqual(wgslReservedNames(out.wgsl), [], `${file}: WGSL reserved words`)
        }
      }
    }
  }
  assert.ok(parts > 100, `${parts} saved field parts`)
})

// The vertex colours (MAMA meshField) step a colorBlend 'hard' label and draw normalMaterial shapes (the penguin's
// eyes): a saved field program without them painted the face patch white over the head and lost the eyes (run 12160).
// A save older than the MAMA field program that carries both fails here, before any GPU run: re-save it.
test('saved field programs carry the normalMaterial labels and the hard colour blends of their asset', () => {
  type Node = { id: string; kind: string; view?: string; material?: string | null; colorBlend?: string; children?: string[] }
  const stale: string[] = []
  let checked = 0
  for (const world of readdirSync('assets')) {
    if (!statSync(join('assets', world)).isDirectory()) continue
    for (const file of readdirSync(join('assets', world)).filter(name => name.endsWith('.asset.json'))) {
      const meshFile = join('assets', world, file.replace(/\.asset\.json$/, '.mesh'))
      let meshed: { data: { groups: { parts: unknown[] }[] } }
      try { meshed = decodeMesh(new Uint8Array(readFileSync(meshFile))) as unknown as typeof meshed } catch { continue }
      const nodes = (JSON.parse(readFileSync(join('assets', world, file), 'utf8')) as { document: { nodes: Record<string, Node> } }).document.nodes
      const below = (id: string): Node[] => { const n = nodes[id]; return n ? [n, ...(n.children ?? []).flatMap(c => below(c))] : [] }
      const parent = new Map(Object.values(nodes).flatMap(n => (n.children ?? []).map(c => [c, n.id] as const)))
      // The node and its ancestors, by id and name: a part (named after its node) holds the view shapes below it.
      const chain = (id: string): string[] => { const n = nodes[id]; const up = parent.get(id); return n ? [n.id, (n as { name?: string }).name ?? '', ...(up ? chain(up) : [])] : [] }
      const views = Object.values(nodes).filter(n => n.view === 'normalMaterial')
      const hard = Object.values(nodes).some(n => n.colorBlend === 'hard')
      for (const group of meshed.data.groups) for (const part of group.parts) {
        const check = checkFieldPart(part)
        if (!check.ok) continue
        checked++
        const partName = (part as { name?: string }).name ?? ''
        const viewMaterials = new Set(views.filter(v => chain(v.id).includes(partName)).flatMap(v => below(v.id))
          .flatMap(n => n.kind !== 'group' && typeof n.material === 'string' ? [n.material] : []))
        const labels = new Set(check.program.labels.map(l => l.material))
        const missing = [...viewMaterials].filter(m => !labels.has(m))
        const name = `${meshFile}#${partName}`
        if (missing.length) stale.push(`${name}: no label for normalMaterial ${missing.join(', ')}`)
        if (hard && missing.length === 0 && viewMaterials.size > 0 && !check.program.tree.some(n => n.op !== 'leaf' && n.colour === 'hard')) {
          stale.push(`${name}: no colour 'hard' tree node`)
        }
      }
    }
  }
  assert.ok(checked > 0)
  assert.deepEqual(stale, [], 'saved before the field program carried them: npm run mesh:save -- <id> with the MAMA pin')
})

test('a colour hard tree node steps the label to the nearer side; a smooth one follows the blend', () => {
  const p = program()
  p.tree = [{ op: 'leaf', operand: 0 }, { op: 'leaf', operand: 1 }, { op: 'union', mode: 'smooth', radius: 0.1, colour: 'hard' }]
  const words = fieldProgramWords(p)
  assert.ok(words.ok)
  if (!words.ok) return
  const f = new Float32Array(words.words.buffer)
  const treeAt = f[3]!
  assert.equal(f[treeAt + 8 + 3], 1)
  const smooth = fieldProgramWords(program())
  assert.ok(smooth.ok)
  if (smooth.ok) assert.equal(new Float32Array(smooth.words.buffer)[treeAt + 8 + 3], 0)
  assert.match(PMF_INTERPRETER_WGSL, /let h = select\(select\(share, 0\.5, av == bv\), stepped, pmf_f\(node \+ 3u\) > 0\.5\);/)
  const bad = checkFieldPart(part({ tree: [{ op: 'leaf', operand: 0 }, { op: 'leaf', operand: 1 }, { op: 'union', mode: 'smooth', radius: 0.1, colour: 'soft' as 'hard' }] }))
  assert.equal(bad.ok, false)
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

test('mechanisms camera: one camera fitted to the two captured hammer poses clears the guard; the whole swing arc does not', () => {
  const source = readFileSync(new URL('../src/game/checks/fieldShading.ts', import.meta.url), 'utf8')
  const functions = source.slice(source.indexOf('function boundCorners('), source.indexOf('function pageErrors()'))
  const exports: any = {}
  runInNewContext(transpileModule('const WIDTH = 1920, HEIGHT = 1080\n' + functions, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText, { exports })
  // race-hammer-hill hammer-1 (hanging) and hammer-2 (at 55 degrees): world bounds of run 12107 at tick 0 and tick 30.
  const a = [{ key: 'h1/head', min: [-1.54, 0.65, 17], max: [1.54, 2.65, 19] }, { key: 'h1/arm', min: [-0.42, 2.44, 17.52], max: [0.42, 7.35, 18.48] },
    { key: 'h2/head', min: [2.99, 2.92, 21], max: [6.19, 6.35, 23] }, { key: 'h2/arm', min: [-0.15, 4.85, 21.52], max: [4.07, 8.08, 22.48] }]
  const b = [{ key: 'h1/head', min: [2.78, 2.09, 17], max: [6.04, 5.51, 19] }, { key: 'h1/arm', min: [-0.16, 4.06, 17.52], max: [3.94, 7.47, 18.48] },
    { key: 'h2/head', min: [-0.13, 1.16, 21], max: [3.16, 3.78, 23] }, { key: 'h2/arm', min: [-0.33, 3.18, 21.52], max: [1.61, 7.96, 22.48] }]
  const target = [2.3, 4.35, 20]
  const initial = { eye: [target[0] + 4, target[1] + 1.8, target[2] + 4], target, fovYDeg: 65, near: 0.1, far: 300 }
  const camera = exports.fitBounds(initial, [...a, ...b])
  for (const pose of [a, b]) assert.ok(exports.guardFraming('mechanisms', camera, pose) >= 0.15)
  // The +-60 degree swing of both hammers about their pivot (0, 8.4): the run-12108 framing, refused by the guard.
  const arc = a.slice(0, 2).flatMap(box => [17, 21].map(z => {
    const swept = { key: box.key, min: [Infinity, Infinity, box.min[2] - 17 + z], max: [-Infinity, -Infinity, box.max[2] - 17 + z] }
    for (let deg = -60; deg <= 60; deg += 2) {
      const r = deg * Math.PI / 180
      for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) {
        const px = x * Math.cos(r) - (y - 8.4) * Math.sin(r), py = 8.4 + x * Math.sin(r) + (y - 8.4) * Math.cos(r)
        swept.min[0] = Math.min(swept.min[0], px); swept.max[0] = Math.max(swept.max[0], px)
        swept.min[1] = Math.min(swept.min[1], py); swept.max[1] = Math.max(swept.max[1], py)
      }
    }
    return swept
  }))
  assert.throws(() => exports.guardFraming('mechanisms-a', exports.fitBounds(initial, arc), a), /bounds.small/)
  assert.match(source, /const posed = poses\.flatMap/)
  assert.doesNotMatch(source, /mechanismArcBounds/)
})

test('candy-world camera: the whole level stays in frame and its parts are drawn larger than from the fixed diagonal', () => {
  const source = readFileSync(new URL('../src/game/checks/fieldShading.ts', import.meta.url), 'utf8')
  const functions = source.slice(source.indexOf('function boundCorners('), source.indexOf('function pageErrors()'))
  const exports: any = {}
  runInNewContext(transpileModule('const WIDTH = 1920, HEIGHT = 1080\n' + functions + '\nexports.partsArea = partsArea', {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText, { exports })
  // race-hammer-hill as run 12111 drew it: floor tiles and walls along z 0..136, towers and balloons out to x +-30.
  const level: any[] = []
  for (let z = 0; z < 136; z += 20) {
    level.push({ key: 'floor', min: [-5.2, 0, z], max: [5.2, 1.9, z + 18] })
    for (const x of [-6.1, 4.9]) level.push({ key: 'wall', min: [x, 0, z], max: [x + 1.2, 2, z + 18] })
  }
  for (const [x, z] of [[24, 26], [-25, 70], [27, 104]]) level.push({ key: 'tower', min: [x - 2.3, 0, z - 2.3], max: [x + 2.3, 14, z + 2.3] })
  level.push({ key: 'balloon', min: [-32, 10, 40], max: [-26, 18, 46] }, { key: 'cloud', min: [10, 24, 90], max: [18, 29, 96] })
  const initial = { eye: [38, 26, 42], target: [0, 1.5, 0], fovYDeg: 45, near: 0.1, far: 500 }
  const world = exports.fitWorld(initial, level)
  assert.ok(exports.guardFraming('candy-world', world, level) >= 0.15)
  const diagonal = exports.fitBounds({ ...initial, fovYDeg: 60 }, level)
  assert.ok(exports.partsArea(world, level) > 1.3 * exports.partsArea(diagonal, level))
  assert.match(source, /const cam = fitWorld\(initial, port\.worldBounds\(\)\)/)
})

test('fieldShading collects every capture failure in one run and still fails', () => {
  const source = readFileSync(new URL('../src/game/checks/fieldShading.ts', import.meta.url), 'utf8')
  assert.match(source, /ok: captures\.failures\.length === 0/)
  for (const what of ['penguin', 'penguin-vertex']) assert.ok(source.includes(`attempt(captures, '${what}'`), what)
  assert.ok(source.includes('attempt(captures, name, async'))
  const check = readFileSync(new URL('../../../tools/chromeCheck.ts', import.meta.url), 'utf8')
  assert.ok(check.includes('out.ok === false'))
  assert.ok(check.includes('FIELD SHADING FAILURES'))
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


import { uniformFieldFrameScale } from '../src/sdf/fieldShading.ts'

test('uniform frame scale accepts rotations and rejects shear, reflection and unequal axes', () => {
  const frame = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 3, 4, 5, 1]
  assert.equal(uniformFieldFrameScale(frame), 2)
  assert.equal(uniformFieldFrameScale(undefined), 1)
  const unequal = [...frame]; unequal[10] = 3
  assert.equal(uniformFieldFrameScale(unequal), null)
  const shear = [...frame]; shear[4] = 0; shear[5] = 2
  assert.equal(uniformFieldFrameScale(shear), null)
  const reflected = [...frame]; reflected[10] = -2
  assert.equal(uniformFieldFrameScale(reflected), null)
  const invalid = [...frame]; invalid[10] = NaN
  assert.equal(uniformFieldFrameScale(invalid), null)
})

test('rounded scenery rejects the failed distant camera and fills half the frame with the close camera', () => {
  const source = readFileSync(new URL('../src/game/checks/fieldShading.ts', import.meta.url), 'utf8')
  const functions = source.slice(source.indexOf('function boundCorners('), source.indexOf('function pageErrors()'))
  const exports: any = {}
  runInNewContext(transpileModule('const WIDTH = 1920, HEIGHT = 1080\n' + functions, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText, { exports })
  const bounds = [{ key: 'candy.plaza-fountain', min: [-2.16, 0, -2.16], max: [2.16, 2.02, 2.16] }]
  const previous = { eye: [4.0179, 2.5167, 4.6876], target: [0, 1.0099, 0], fovYDeg: 55, near: 0.05, far: 200 }
  assert.throws(() => exports.guardFraming('rounded-scenery', previous, bounds), /minimum 0.4/)
  const saved = decodeMesh(new Uint8Array(readFileSync(new URL('../../../assets/candy/candy.plaza-fountain.mesh', import.meta.url))))
  const data = saved.data as { groups: { parts: { meshes: { positions: Float32Array }[] }[] }[] }
  const surface = data.groups.flatMap(g => g.parts.flatMap(p => p.meshes.flatMap(m =>
    Array.from({ length: m.positions.length / 3 }, (_, i) => Array.from(m.positions.subarray(i * 3, i * 3 + 3))))))
  const drawnBounds = bounds.map(b => ({ ...b, surface }))
  const camera = exports.sceneryCamera(drawnBounds)
  assert.ok(exports.guardFraming('rounded-scenery', camera, drawnBounds) >= 0.5)
  for (const suffix of ['normals', 'vertex']) {
    assert.ok(exports.guardFraming('rounded-scenery-' + suffix, camera, drawnBounds) >= 0.5)
  }
})

test('normal taps respect operand scale, never fall inside one grid voxel, and stop at narrow blends', () => {
  const p = program()
  const step = (p: FieldProgramLike) => {
    const data = fieldProgramWords(p)
    assert.ok(data.ok)
    return new Float32Array(data.words.buffer)[7]
  }
  const grid = p.operands[1]
  assert.equal(grid.kind, 'grid')
  const voxel = (grid as { voxel: number }).voxel
  const scaled = { ...p, operands: [{ ...grid, scale: 0.1 }] }
  assert.ok(step(scaled) >= voxel * 0.1 / 2 - 1e-8 && step(scaled) <= voxel * 0.1 + 1e-8, 'taps follow the operand scale')
  // The plaza fountain: 0.0554 voxels and a 0.04 smooth blend. The step 0.01 of card 7014 put all six taps inside one
  // voxel, so every voxel lit as a flat facet (judge: 'triangular faceting', run 12143).
  const fountain = { ...p, operands: [{ ...grid, voxel: 0.0554, scale: 1 }],
    tree: p.tree.map(n => n.op !== 'leaf' && n.mode !== 'hard' ? { ...n, radius: 0.04 } : n) } as FieldProgramLike
  assert.ok(Math.abs(step(fountain) - 0.04) < 1e-6, String(step(fountain)))
  const resampled = { ...p, operands: [{ ...grid, voxel: 0.6 }] }
  assert.ok(Math.abs(step(resampled) - 0.3) < 1e-6, 'never below half a voxel, even across a narrower blend')
  const fine = { ...p, operands: [{ ...grid, voxel: 0.01 }] }
  assert.ok(Math.abs(step(fine) - 0.01) < 1e-8, 'one voxel when the blends are wider')
  const wgsl = fieldMaterialWgsl({ program: resampled, labelGraphs: [], debug: false }).wgsl
  assert.match(wgsl, /newton < 2u/)
  assert.match(wgsl, /p -= taps.xyz \/ sqrt\(gg\) \* clamp/)
  assert.match(wgsl, /taps = pmf_field\(db, p, h, scale, &w\)/)
})

// RAA parses material functions with naga, which refuses a reserved word as a name (material.fn_invalid, 'name `pass`
// is a reserved keyword'): only the GPU run saw it. Every field material variant is checked here.
test('wgslReservedNames reports reserved words used as names, as naga does, and skips comments', () => {
  assert.ok(WGSL_RESERVED.has('pass') && !WGSL_RESERVED.has('var') && !WGSL_RESERVED.has('vec3f'))
  assert.deepEqual(wgslReservedNames('fn f() {\n  for (var pass = 0u; pass < 2u; pass++) {}\n}'), ['2:12 pass', '2:23 pass', '2:34 pass'])
  assert.deepEqual(wgslReservedNames('// one pass\n/* the final pass */ let x = 0x1fu + 1e3f; let y = v.xyz;'), [])
})

test('every field material variant (plain, label graphs, normalsDebug) names no WGSL reserved word', () => {
  for (const labelGraphs of [[null, null], [STRIPES, null]]) for (const debug of [false, true]) {
    const out = fieldMaterialWgsl({ program: program(), labelGraphs, debug })
    assert.deepEqual(wgslReservedNames(out.wgsl), [], `graphs ${labelGraphs[0] !== null}, debug ${debug}`)
  }
})
