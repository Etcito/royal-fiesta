// Field material for a saved payload part: the part's SDF field program (contract 'mama.field-program')
// evaluated per fragment. The normal comes from six central distance taps, the label materials are
// blended per pixel, and the rest-space normal is carried through the instance and skin transforms the
// same way a normal-volume normal was. This module validates the payload structurally and never imports
// MAMA (the upstream field-shading entry point takes a numeric PartShading record instead).

export interface FieldLabelLike {
  material: string | null
  color: readonly [number, number, number]
  roughness: number
  metallic: number
}

export interface FieldBoxOperandLike {
  kind: 'box'
  label: number
  inv: readonly number[]
  scale: number
  half: readonly [number, number, number]
  radius: number
}

export interface FieldGridOperandLike {
  kind: 'grid'
  label: number
  inv: readonly number[]
  scale: number
  origin: readonly [number, number, number]
  voxel: number
  size: readonly [number, number, number]
  at: readonly [number, number]
  range: number
}

export type FieldOperandLike = FieldBoxOperandLike | FieldGridOperandLike

/** A label's compiled MAMA material graph (the shape of @etcito/raa-sdfm SdfmCompiledMaterial). */
export interface FieldLabelGraphLike {
  name: string
  body: string
  helpers: readonly { id: string; wgsl: string }[]
  constants: readonly number[]
  fields: readonly string[]
}

export interface FieldGridLike {
  width: number
  height: number
  texels: Uint8Array
}

export type FieldTreeNodeLike =
  | { op: 'leaf'; operand: number }
  | { op: 'union' | 'subtract' | 'intersect'; mode: string; radius: number }

export interface FieldProgramLike {
  format: string
  version: number
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] }
  labels: readonly FieldLabelLike[]
  operands: readonly FieldOperandLike[]
  tree: readonly FieldTreeNodeLike[]
  grid: FieldGridLike | null
  stats?: { operands: number; analytic: number; sampled: number }
  functionName: string
  wgsl: string
}

export type FieldCheck = { ok: true; program: FieldProgramLike } | { ok: false; reason: string }

const FORMAT = 'mama.field-program'
const VERSION = 1
const MAX_LABELS = 8
const FUNCTION_NAME = /^pmf_eval_[0-9a-f]{16}$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteArray(v: unknown, n: number): v is readonly number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

function finiteVec(v: unknown, n: number): v is readonly number[] {
  return finiteArray(v, n)
}

function bad(reason: string): FieldCheck {
  return { ok: false, reason }
}

function checkGrid(grid: unknown): string | null {
  if (!isRecord(grid)) return 'field grid is not an object'
  const { width, height, texels } = grid
  if (!Number.isInteger(width) || (width as number) < 1 || (width as number) > 4096) return 'field grid width is not 1..4096'
  if (!Number.isInteger(height) || (height as number) < 1 || (height as number) > 4096) return 'field grid height is not 1..4096'
  if (!(texels instanceof Uint8Array)) return 'field grid texels is not a Uint8Array'
  const want = (width as number) * (height as number) * 4
  if (texels.length !== want) return `field grid texels length ${texels.length} is not ${want} (${width}x${height} rgba8)`
  return null
}

function checkOperand(o: unknown, labels: number): string | null {
  if (!isRecord(o)) return 'field operand is not an object'
  if (!Number.isInteger(o.label) || (o.label as number) < 0 || (o.label as number) >= labels) return 'field operand label is out of range'
  if (!finiteVec(o.inv, 16)) return 'field operand inv is not 16 finite numbers'
  if (typeof o.scale !== 'number' || !Number.isFinite(o.scale) || o.scale <= 0) return 'field operand scale is not a positive number'
  if (o.kind === 'box') {
    if (!finiteVec(o.half, 3)) return 'field box half is not 3 finite numbers'
    if ((o.half as number[]).some((n) => n < 0)) return 'field box half has a negative side'
    if (typeof o.radius !== 'number' || !Number.isFinite(o.radius) || o.radius < 0) return 'field box radius is not a non-negative number'
    return null
  }
  if (o.kind === 'grid') {
    if (!finiteVec(o.origin, 3)) return 'field grid operand origin is not 3 finite numbers'
    if (typeof o.voxel !== 'number' || !Number.isFinite(o.voxel) || o.voxel <= 0) return 'field grid operand voxel is not a positive number'
    if (!finiteVec(o.size, 3) || (o.size as number[]).some((n) => !Number.isInteger(n) || n < 2 || n > 64)) return 'field grid operand size is not 3 integers 2..64'
    if (!finiteVec(o.at, 2) || (o.at as number[]).some((n) => !Number.isInteger(n) || n < 0)) return 'field grid operand at is not 2 non-negative integers'
    if (typeof o.range !== 'number' || !Number.isFinite(o.range) || o.range <= 0) return 'field grid operand range is not a positive number'
    return null
  }
  return `field operand kind '${String(o.kind)}' is not box or grid`
}

function checkProgram(value: unknown): FieldCheck {
  if (!isRecord(value)) return bad('field program is not an object')
  if (value.format !== FORMAT) return bad(`field program format '${String(value.format)}'; expected '${FORMAT}'`)
  if (value.version !== VERSION) return bad(`field program version ${String(value.version)}; this renderer reads ${VERSION}`)
  if (!isRecord(value.bounds) || !finiteVec(value.bounds.min, 3) || !finiteVec(value.bounds.max, 3)) {
    return bad('field program bounds is not { min: [x,y,z], max: [x,y,z] }')
  }
  const min = value.bounds.min as readonly number[]
  const max = value.bounds.max as readonly number[]
  if (max.some((n, i) => n < min[i]!)) return bad('field program bounds max is smaller than min')
  const labels = value.labels
  if (!Array.isArray(labels) || labels.length < 1) return bad('field program has no labels')
  if (labels.length > MAX_LABELS) return bad(`more than ${MAX_LABELS} labels (${labels.length})`)
  for (const label of labels) {
    if (!isRecord(label)) return bad('field label is not an object')
    if (label.material !== null && (typeof label.material !== 'string' || label.material === '')) return bad('field label material is not a name or null')
    if (!finiteVec(label.color, 3)) return bad('field label color is not 3 finite numbers')
    if (typeof label.roughness !== 'number' || !Number.isFinite(label.roughness)) return bad('field label roughness is not a finite number')
    if (typeof label.metallic !== 'number' || !Number.isFinite(label.metallic)) return bad('field label metallic is not a finite number')
  }
  const operands = value.operands
  if (!Array.isArray(operands) || operands.length < 1) return bad('field program has no operands')
  for (const operand of operands) {
    const why = checkOperand(operand, labels.length)
    if (why !== null) return bad(why)
  }
  const tree = value.tree
  if (!Array.isArray(tree) || tree.length < 1) return bad('field program has no tree')
  for (const node of tree) {
    if (!isRecord(node)) return bad('field tree node is not an object')
    if (node.op === 'leaf') {
      if (!Number.isInteger(node.operand) || (node.operand as number) < 0 || (node.operand as number) >= operands.length) return bad('field tree leaf operand is out of range')
    } else if (node.op === 'union' || node.op === 'subtract' || node.op === 'intersect') {
      if (typeof node.mode !== 'string') return bad('field tree mode is not a string')
      if (typeof node.radius !== 'number' || !Number.isFinite(node.radius) || node.radius < 0) return bad('field tree radius is not a non-negative number')
    } else {
      return bad(`field tree op '${String(node.op)}' is not leaf, union, subtract or intersect`)
    }
  }
  if (value.grid !== null) {
    const why = checkGrid(value.grid)
    if (why !== null) return bad(why)
  }
  if (typeof value.functionName !== 'string' || !FUNCTION_NAME.test(value.functionName)) {
    return bad(`bad functionName '${String(value.functionName)}'; expected pmf_eval_<16 lowercase hex>`)
  }
  if (typeof value.wgsl !== 'string') return bad('field program wgsl is not a string')
  if (!new RegExp(`\\bfn\\s+${value.functionName}\\s*\\(`).test(value.wgsl)) {
    return bad(`field program wgsl does not define ${value.functionName}`)
  }
  return { ok: true, program: value as unknown as FieldProgramLike }
}

/**
 * The field program of an unknown payload part, or the reason it has none. Mirrors MAMA's savedPartShading:
 * a saved refusal is reported as is and a part saved before field shading is named as such.
 */
export function checkFieldPart(part: unknown): FieldCheck {
  if (!isRecord(part)) return bad('no field program (the part is not a saved payload part)')
  if (typeof part.fieldRefusal === 'string' && part.fieldRefusal !== '') return bad(part.fieldRefusal)
  if (part.fieldProgram === undefined || part.fieldProgram === null) {
    // A program passed directly is accepted too (the caller already unwrapped the part).
    if (part.format === FORMAT || (typeof part.functionName === 'string' && typeof part.wgsl === 'string')) return checkProgram(part)
    return bad('no field program (saved before field shading); re-save the asset')
  }
  return checkProgram(part.fieldProgram)
}

/** The half-step of the six normal taps: half the smallest grid voxel, or 1e-3 of the bounds diagonal. */
function fieldStep(program: FieldProgramLike): number {
  let voxel = Infinity
  for (const operand of program.operands) if (operand.kind === 'grid') voxel = Math.min(voxel, operand.voxel)
  if (Number.isFinite(voxel)) return voxel / 2
  const [ax, ay, az] = program.bounds.min
  const [bx, by, bz] = program.bounds.max
  const diagonal = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
  return 1e-3 * diagonal
}

function f32(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`field shading: ${n} is not a finite WGSL literal`)
  const text = String(n)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

function textHash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(((b ^ c) << 13) | ((b ^ c) >>> 19), 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/**
 * The host function MAMA's field evaluator calls: texel (x, y) of the current instance's grid image in
 * RAA's texture atlas, clamped to the image, as rgba in 0..1. The instance params carry the handle and
 * the image size (fieldInstanceParams); material_main copies them here because pmf_grid has no input.
 */
export const PMF_GRID_HOST_WGSL = /* wgsl */ `
var<private> pmf_grid_texture: u32 = 0u;
var<private> pmf_grid_size: vec2<u32> = vec2<u32>(0u, 0u);

fn pmf_grid(x: i32, y: i32) -> vec4f {
  if (pmf_grid_texture == 0u || pmf_grid_size.x == 0u || pmf_grid_size.y == 0u) { return vec4f(0.0); }
  let xi = clamp(x, 0, i32(pmf_grid_size.x) - 1);
  let yi = clamp(y, 0, i32(pmf_grid_size.y) - 1);
  let uv = (vec2f(f32(xi), f32(yi)) + vec2f(0.5)) / vec2f(pmf_grid_size);
  return raa_texture(pmf_grid_texture, uv);
}
`

/** The same rest-frame carry a normal volume uses (sdfm_posed_normal): the rest normal and its tangent are rebuilt from the interpolated streams. */
const POSED_NORMAL_WGSL = /* wgsl */ `
const PMF_REST_TANGENT_AXIS = vec3f(${[1, 2, 3].map((n) => f32(n / Math.sqrt(14))).join(', ')});

fn sdfm_posed_normal(in: MaterialInput, g: vec3f) -> vec3f {
  let n = normalize(in.normal);
  if (dot(g, g) == 0.0) { return n; }
  let nr0 = vec3f(in.uv, in.color.w);
  if (dot(nr0, nr0) < 1e-12) { return n; }
  let nr = normalize(nr0);
  let tr0 = cross(PMF_REST_TANGENT_AXIS, nr0);
  let trp = tr0 - nr * dot(nr, tr0);
  let tw = in.tangent.xyz - n * dot(n, in.tangent.xyz);
  if (dot(trp, trp) < 1e-8 || dot(tw, tw) < 1e-12) { return n; }
  let tr = normalize(trp);
  let br = cross(nr, tr);
  let t = normalize(tw);
  let bw = cross(n, t) * select(-1.0, 1.0, in.tangent.w >= 0.0);
  var m = normalize(dot(g, tr) * t + dot(g, br) * bw + dot(g, nr) * n);
  // Keep the SDF gradient intact; a view-dependent nudge adds a visible seam at grazing angles.
  return m;
}
`

// The part's field program as RAA material data (Engine.addMaterialData), read by the ONE fixed evaluator below
// (owner 2026-11-04: one shader with the SDF as data, no per-part compile). The program's own `wgsl` (straight-line
// code per operand, 25 KB to over 1 MB on the candy set) is never embedded: RAA refuses a material function over
// 64 KB. Layout, all f32 (integers stored exactly), offsets from the block base:
//   [0] version, [1] tree node count, [2] operand table offset, [3] tree offset, [4..6] bounds.min, [7] normal tap
//   half-step, [8..10] bounds.max, [11] label count, [12 + 8i] label i: colour xyz, roughness, metallic
//   operand records (PMF_OPERAND_FLOATS each): kind (0 box, 1 grid), label, scale, 0, inv[16] (column-major),
//     box: half xyz, radius; grid: origin xyz, voxel, size xyz, at xy, range
//   tree nodes, 4 floats each: op (0 leaf, 1 union, 2 subtract, 3 intersect), operand index or mode (0 hard, 1 round,
//     2 smooth, 3 chamfer), radius, 0
const PMF_LABELS_AT = 12
const PMF_OPERAND_FLOATS = 32
const PMF_OPERANDS_AT = PMF_LABELS_AT + 8 * MAX_LABELS
/** The evaluator's stack depth: a program whose postfix tree needs more is drawn with vertex normals (named). */
export const PMF_STACK = 16
const TREE_OPS = { leaf: 0, union: 1, subtract: 2, intersect: 3 } as const
const BLEND_MODES: Record<string, number> = { hard: 0, round: 1, smooth: 2, chamfer: 3 }

/** The deepest stack the program's postfix tree needs, or the reason it is malformed. */
function treeDepth(program: FieldProgramLike): number | string {
  let top = 0
  let depth = 0
  for (const node of program.tree) {
    if (node.op === 'leaf') depth = Math.max(depth, ++top)
    else if (top < 2) return 'field tree operation has fewer than two operands'
    else top--
  }
  return top === 1 ? depth : 'field tree does not leave exactly one value'
}

/**
 * The material data words of a field part (layout above), or the reason the fixed evaluator cannot draw it: an
 * unknown blend mode or a tree deeper than PMF_STACK.
 */
export function fieldProgramWords(program: FieldProgramLike): { ok: true; words: Uint32Array } | { ok: false; reason: string } {
  const depth = treeDepth(program)
  if (typeof depth === 'string') return { ok: false, reason: depth }
  if (depth > PMF_STACK) return { ok: false, reason: `field tree needs a stack of ${depth}, more than ${PMF_STACK}` }
  const treeAt = PMF_OPERANDS_AT + PMF_OPERAND_FLOATS * program.operands.length
  const floats = new Float32Array(treeAt + 4 * program.tree.length)
  floats[0] = VERSION
  floats[1] = program.tree.length
  floats[2] = PMF_OPERANDS_AT
  floats[3] = treeAt
  floats.set(program.bounds.min, 4)
  floats[7] = fieldStep(program)
  floats.set(program.bounds.max, 8)
  const labels = program.labels.slice(0, MAX_LABELS)
  floats[11] = labels.length
  labels.forEach((label, i) => {
    floats.set(label.color, PMF_LABELS_AT + 8 * i)
    floats[PMF_LABELS_AT + 8 * i + 3] = label.roughness
    floats[PMF_LABELS_AT + 8 * i + 4] = label.metallic
  })
  program.operands.forEach((o, i) => {
    const at = PMF_OPERANDS_AT + PMF_OPERAND_FLOATS * i
    floats[at] = o.kind === 'box' ? 0 : 1
    floats[at + 1] = o.label
    floats[at + 2] = o.scale
    floats.set(o.inv, at + 4)
    if (o.kind === 'box') {
      floats.set(o.half, at + 20)
      floats[at + 23] = o.radius
    } else {
      floats.set(o.origin, at + 20)
      floats[at + 23] = o.voxel
      floats.set(o.size, at + 24)
      floats.set(o.at, at + 27)
      floats[at + 29] = o.range
    }
  })
  for (const [k, node] of program.tree.entries()) {
    const at = treeAt + 4 * k
    floats[at] = TREE_OPS[node.op]
    if (node.op === 'leaf') {
      floats[at + 1] = node.operand
      continue
    }
    const mode = BLEND_MODES[node.mode]
    if (mode === undefined) return { ok: false, reason: `field blend mode '${node.mode}' has no WGSL port` }
    floats[at + 1] = mode
    floats[at + 2] = node.radius
  }
  return { ok: true, words: new Uint32Array(floats.buffer) }
}

/**
 * The fixed evaluator of a field program in material data at word `db` (fieldProgramWords): MAMA fieldProgramWgsl's
 * operand distances, blends and label weights, run as a stack machine over the tree instead of emitted per part.
 */
export const PMF_INTERPRETER_WGSL = /* wgsl */ `
fn pmf_f(i: u32) -> f32 { return raa_material_f32(i); }
fn pmf_u(i: u32) -> u32 { return u32(raa_material_f32(i) + 0.5); }
fn pmf_v3(i: u32) -> vec3f { return vec3f(raa_material_f32(i), raa_material_f32(i + 1u), raa_material_f32(i + 2u)); }

fn pmf_texel(x: i32, y: i32, range: f32) -> f32 {
  let t = pmf_grid(x, y);
  return ((t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * 2.0 - 1.0) * range;
}

// The distance of the operand record at word r at point p of the part frame.
fn pmf_operand(r: u32, p: vec3f) -> f32 {
  let local = vec3f(
    pmf_f(r + 4u) * p.x + pmf_f(r + 8u) * p.y + pmf_f(r + 12u) * p.z + pmf_f(r + 16u),
    pmf_f(r + 5u) * p.x + pmf_f(r + 9u) * p.y + pmf_f(r + 13u) * p.z + pmf_f(r + 17u),
    pmf_f(r + 6u) * p.x + pmf_f(r + 10u) * p.y + pmf_f(r + 14u) * p.z + pmf_f(r + 18u));
  var d = 0.0;
  if (pmf_u(r) == 0u) {
    let radius = pmf_f(r + 23u);
    let q = abs(local) - (pmf_v3(r + 20u) - vec3f(radius));
    d = length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - radius;
  } else {
    let voxel = pmf_f(r + 23u);
    let size = pmf_v3(r + 24u);
    let ax = i32(pmf_u(r + 27u));
    let ay = i32(pmf_u(r + 28u));
    let range = pmf_f(r + 29u);
    let g = (local - pmf_v3(r + 20u)) / voxel - vec3f(0.5);
    let c = clamp(g, vec3f(0.0), size - vec3f(1.0));
    let i = vec3i(clamp(floor(c), vec3f(0.0), size - vec3f(2.0)));
    let t = c - vec3f(i);
    let sx = i32(size.x);
    // The eight trilinear corners in one loop: a single pmf_texel (raa_texture) call site, since the shader compiler
    // inlines every call and eight sites per operand made the field pipelines minutes long to compile.
    var trilinear = 0.0;
    for (var k = 0u; k < 8u; k = k + 1u) {
      let o = vec3<u32>(k & 1u, (k >> 1u) & 1u, k >> 2u);
      let corner = select(vec3f(1.0) - t, t, o == vec3<u32>(1u));
      let x = ax + (i.z + i32(o.z)) * sx + i.x + i32(o.x);
      trilinear = trilinear + pmf_texel(x, ay + i.y + i32(o.y), range) * corner.x * corner.y * corner.z;
    }
    d = trilinear + length((g - c) * voxel);
  }
  return d * pmf_f(r + 2u);
}

// The field program at word db, at point p: the distance, and the label weights in w.
fn pmf_run(db: u32, p: vec3f, w: ptr<function, array<f32, 8>>) -> f32 {
  var sd: array<f32, ${PMF_STACK}>;
  var sw: array<array<f32, 8>, ${PMF_STACK}>;
  var top = 0u;
  let count = pmf_u(db + 1u);
  let operands = db + pmf_u(db + 2u);
  let tree = db + pmf_u(db + 3u);
  for (var k = 0u; k < count; k = k + 1u) {
    let node = tree + 4u * k;
    let op = pmf_u(node);
    if (op == 0u) {
      if (top >= ${PMF_STACK}u) { break; }
      let r = operands + ${PMF_OPERAND_FLOATS}u * pmf_u(node + 1u);
      sd[top] = pmf_operand(r, p);
      let label = pmf_u(r + 1u);
      for (var s = 0u; s < 8u; s = s + 1u) { sw[top][s] = select(0.0, 1.0, s == label); }
      top = top + 1u;
      continue;
    }
    if (top < 2u) { break; }
    let mode = pmf_u(node + 1u);
    let r = pmf_f(node + 2u);
    let a = sd[top - 2u];
    let bd = sd[top - 1u];
    let av = select(-a, a, op == 1u);
    let bv = select(bd, -bd, op == 3u);
    let hard = mode == 0u || r <= 0.0;
    var blend = min(av, bv);
    var share = select(0.0, 1.0, bv < av);
    if (!hard && mode == 2u) {
      let h = max(r - abs(av - bv), 0.0) / r;
      blend = blend - r * h * h * 0.25;
      share = select(0.5 * h, 1.0 - 0.5 * h, bv < av);
    } else if (!hard && mode == 3u) {
      let bevel = (av + bv - r) * ${f32(Math.SQRT1_2)};
      blend = min(min(av, bv), bevel);
      share = select(share, 0.5, bevel < min(av, bv));
    } else if (!hard && mode == 1u) {
      let u = max(vec2f(r - av, r - bv), vec2f(0.0));
      let ul = length(u);
      blend = max(r, min(av, bv)) - ul;
      var gradient = vec2f(0.0);
      if (ul > 0.0) { gradient = u / ul; }
      if (min(av, bv) > r) { gradient += select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), av <= bv); }
      if (gradient.x + gradient.y > 0.0) { share = gradient.y / (gradient.x + gradient.y); }
    }
    if (op != 2u) {
      let h = select(share, 0.5, av == bv);
      for (var s = 0u; s < 8u; s = s + 1u) { sw[top - 2u][s] = (1.0 - h) * sw[top - 2u][s] + h * sw[top - 1u][s]; }
    }
    sd[top - 2u] = select(-blend, blend, op == 1u);
    top = top - 1u;
  }
  for (var s = 0u; s < 8u; s = s + 1u) { (*w)[s] = sw[0][s]; }
  return sd[0];
}
`

/** The field grid as an Engine.addTexture argument, or null when the program has no grid. */
export function fieldGridTexture(program: FieldProgramLike): { width: number; height: number; data: Uint8Array } | null {
  if (program.grid === null) return null
  return { width: program.grid.width, height: program.grid.height, data: program.grid.texels }
}

/**
 * The 16 Engine.setInstanceParams floats of a field part: bounds.min and 0, then the grid handle in the
 * volume layout's texture slot, the image width and height, and the "grid is set" flag at p3.x.
 */
export function fieldInstanceParams(texture: number | null, program: FieldProgramLike): number[] {
  const grid = program.grid
  const handle = texture ?? 0
  const [x, y, z] = program.bounds.min
  return [
    x, y, z, 0,
    0, 0, 0, handle,
    grid === null ? 0 : grid.width, grid === null ? 0 : grid.height, 0, 0,
    grid !== null && handle > 0 ? 1 : 0, 0, 0, 0,
  ]
}

// The labels' constant looks, read from the part's data block, weighted by the field.
const COLOUR_SUMS = `  var base = vec3f(0.0);
  var roughness = 0.0;
  var metallic = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let l = db + ${PMF_LABELS_AT}u + 8u * i;
    base += w[i] * pmf_v3(l);
    roughness += w[i] * pmf_f(l + 3u);
    metallic += w[i] * pmf_f(l + 4u);
  }
  o.base_color = base;
  o.roughness = roughness;
  o.metallic = metallic;`

const MATERIAL_FULL_FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height']

// `text` with every `extra_words[i]` (MAMA's binding-7 constant reads; i is `b + K` or derived from b, such as a ramp's
// stop offsets) read from the material's inlined constants instead: `PMF_K[i]`, b being the graph's base in PMF_K.
function constantReads(text: string): string {
  let out = ''
  let at = 0
  for (const m of text.matchAll(/\bextra_words\s*\[/g)) {
    const start = m.index ?? 0
    if (start < at) continue
    let depth = 1
    let i = start + m[0].length
    for (; i < text.length && depth > 0; i++) depth += text[i] === '[' ? 1 : text[i] === ']' ? -1 : 0
    if (depth > 0) throw new Error('field shading: unterminated extra_words read in a label material')
    out += `${text.slice(at, start)}PMF_K[${constantReads(text.slice(start + m[0].length, i - 1))}]`
    at = i
  }
  return out + text.slice(at)
}

const structNames = (text: string): string =>
  text.replace(/\bMaterialFull\b/g, 'SdfmMaterialFull').replace(/\bMatMasks\b/g, 'SdfmMatMasks')

// The label graphs embedded in the field material, as @etcito/raa-sdfm fieldShadingCore embeds them: one function
// per distinct body, its helpers once by id, every graph's constants in one inlined PMF_K at the graph's base b.
// A compiled material's RAA function (its name is a registry key such as 'sdfm.buffer_<hash>') defines its own
// material_main and cannot be called from another material, so the graph text itself is embedded.
function labelGraphs(graphs: readonly (FieldLabelGraphLike | null)[]): { text: string; calls: (string | null)[] } {
  const helpers = new Map<string, string>()
  const bodies: string[] = []
  const constants: number[] = []
  const calls = graphs.map((graph) => {
    if (graph === null) return null
    if (graph.fields.join() !== MATERIAL_FULL_FIELDS.join()) {
      throw new Error(`field shading: material '${graph.name}': MaterialFull fields ${graph.fields.join(', ')}; expected ${MATERIAL_FULL_FIELDS.join(', ')}`)
    }
    for (const word of graph.constants) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) throw new Error(`field shading: material '${graph.name}': constant ${word} is not a u32`)
    }
    for (const h of graph.helpers) {
      const text = structNames(constantReads(h.wgsl)).trim()
      const known = helpers.get(h.id)
      if (known !== undefined && known !== text) throw new Error(`field shading: material '${graph.name}': helper '${h.id}' differs from another material's`)
      helpers.set(h.id, text)
    }
    const body = structNames(constantReads(graph.body)).replace(/\s+$/, '')
    let k = bodies.indexOf(body)
    if (k < 0) k = bodies.push(body) - 1
    const base = constants.length
    constants.push(...graph.constants)
    return `pmf_graph_${k}(${base}u, p, p, n, SdfmMatMasks(0.5, 1.0, 1.0, 0.0, 1.0))`
  })
  const text = [
    'struct SdfmMatMasks { curvature: f32, cavity: f32, ao: f32, height: f32, proximity: f32 }',
    ...(constants.length > 0 ? [`const PMF_K = array<u32, ${constants.length}>(${constants.map((w) => `${w}u`).join(', ')});`] : []),
    ...[...helpers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, text]) => `// MAMA helper ${id}\n${text}`),
    ...bodies.map((body, k) =>
      `fn pmf_graph_${k}(b: u32, p: vec3<f32>, pn: vec3<f32>, n: vec3<f32>, mk: SdfmMatMasks) -> SdfmMaterialFull {\n${body}\n}`),
  ].join('\n\n')
  return { text, calls }
}

function materialSwitch(graphs: readonly (FieldLabelGraphLike | null)[]): string {
  const embedded = labelGraphs(graphs)
  // A label without a graph wears its constant look from the data block (default).
  const cases = embedded.calls.flatMap((call, i) => call === null ? [] : [`    case ${i}u: { return ${call}; }`])
  return `struct SdfmMaterialFull { base_color: vec3f, metallic: f32, roughness: f32, emissive: vec3f, height: f32 }

${embedded.text}

fn pmf_label(db: u32, p: vec3f, n: vec3f, i: u32) -> SdfmMaterialFull {
  let l = db + ${PMF_LABELS_AT}u + 8u * i;
  switch i {
${cases.join('\n')}
    default: { return SdfmMaterialFull(pmf_v3(l), pmf_f(l + 4u), pmf_f(l + 3u), vec3f(0.0), 0.0); }
  }
}`
}

const GRAPH_BLEND = `  // The four heaviest labels, renormalised, so a material boundary follows the field per pixel.
  var i0: i32 = -1; var v0 = 0.0;
  var i1: i32 = -1; var v1 = 0.0;
  var i2: i32 = -1; var v2 = 0.0;
  var i3: i32 = -1; var v3 = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let value = w[i];
    if (value <= 0.0) { continue; }
    if (value > v0) { i3 = i2; v3 = v2; i2 = i1; v2 = v1; i1 = i0; v1 = v0; i0 = i; v0 = value; }
    else if (value > v1) { i3 = i2; v3 = v2; i2 = i1; v2 = v1; i1 = i; v1 = value; }
    else if (value > v2) { i3 = i2; v3 = v2; i2 = i; v2 = value; }
    else if (value > v3) { i3 = i; v3 = value; }
  }
  var base = vec3f(0.0);
  var metallic = 0.0;
  var roughness = 0.0;
  var emissive = vec3f(0.0);
  var height = 0.0;
  var total = 0.0;
  // One pmf_label call site (it inlines every embedded label graph): the four picks in a loop.
  var picks = array<i32, 4>(i0, i1, i2, i3);
  var shares = array<f32, 4>(v0, v1, v2, v3);
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (picks[k] < 0) { continue; }
    let v = shares[k];
    let m = pmf_label(db, p, n, u32(picks[k]));
    base += m.base_color * v; metallic += m.metallic * v; roughness += m.roughness * v; emissive += m.emissive * v; height += m.height * v; total += v;
  }
  if (total > 0.0) { base /= total; metallic /= total; roughness /= total; emissive /= total; height /= total; }
  o.base_color = base;
  o.metallic = metallic;
  o.roughness = roughness;
  o.emissive = emissive;`

/** RAA's largest material function source in bytes (raa-shader USER_FN_MAX_BYTES). */
export const MATERIAL_FUNCTION_MAX_BYTES = 65536

/**
 * The RAA material function of field parts: the fixed evaluator (PMF_INTERPRETER_WGSL) reads the part's program from
 * its material data block (fieldProgramWords), the normal comes from six central distance taps, the mesh normal
 * replaces it only where p leaves the program bounds or the gradient vanishes, and the labels (their constant look, or
 * their embedded MAMA material graphs for the four heaviest) mix per pixel. The text depends only on the label graphs
 * and debug, so parts with the same graphs share one function; the returned name keys it.
 * @throws when the text exceeds MATERIAL_FUNCTION_MAX_BYTES (label graphs too large to embed)
 */
export function fieldMaterialWgsl(src: {
  program: FieldProgramLike
  labelGraphs: readonly (FieldLabelGraphLike | null)[]
  debug: boolean
}): { functionName: string; wgsl: string } {
  const { program, debug } = src
  const labels = program.labels.slice(0, MAX_LABELS)
  const graphs = labels.map((_, i) => src.labelGraphs[i] ?? null)
  const graph = graphs.some((g) => g !== null)
  // The label switch and its graphs are module-scope declarations; only the blend runs inside material_main.
  const declarations = graph ? `${materialSwitch(graphs)}\n\n` : ''
  const colour = graph ? GRAPH_BLEND : COLOUR_SUMS
  const debugText = debug
    ? '\n  // ?normalsDebug: the normal lighting receives, 0.5 + n / 2.\n  o.base_color = n * 0.5 + vec3f(0.5);\n  o.metallic = 0.0;\n  o.roughness = 1.0;'
    : ''
  const wgsl = `// field material (mama.field-program v${VERSION}, the program in material data)
${PMF_GRID_HOST_WGSL}
${PMF_INTERPRETER_WGSL}
${POSED_NORMAL_WGSL}
// The centre run (distance and label weights in w) and six central taps at p +- h * e_i, h = half the smallest grid
// voxel, in ONE loop: pmf_run has a single call site. The shader compiler inlines every call, and the seven call sites
// (centre + taps) made each field pipeline so large that a level's pipelines were still compiling after 180 s.
// Returns the gradient in xyz and the centre distance in w.
fn pmf_field(db: u32, p: vec3f, h: f32, w: ptr<function, array<f32, 8>>) -> vec4f {
  var g = vec3f(0.0);
  var centre = 0.0;
  var wt: array<f32, 8>;
  for (var t = 0u; t < 7u; t = t + 1u) {
    let axis = (t + 1u) / 2u;
    let e = vec3f(select(0.0, 1.0, axis == 1u), select(0.0, 1.0, axis == 2u), select(0.0, 1.0, axis == 3u));
    let s = select(-1.0, 1.0, (t & 1u) == 0u);
    let d = pmf_run(db, p + e * (s * h), &wt);
    if (t == 0u) {
      centre = d;
      *w = wt;
    } else {
      g = g + e * (s * d);
    }
  }
  return vec4f(g / (2.0 * h), centre);
}

${declarations}fn material_main(in: MaterialInput) -> MaterialOutput {
  var o = raa_default_output(in);
  o.opacity = 1.0;
  let p = in.color.xyz;
  let db = raa_material_data_base(in.record);
  pmf_grid_texture = u32(in.instance_params[1].w + 0.5);
  pmf_grid_size = vec2<u32>(u32(in.instance_params[2].x + 0.5), u32(in.instance_params[2].y + 0.5));
  var w: array<f32, 8>;
  let taps = pmf_field(db, p, pmf_f(db + 7u), &w);
  let g = taps.xyz;
  let inside = all(p >= pmf_v3(db + 4u)) && all(p <= pmf_v3(db + 8u));
  let glen = length(g);
  var n = normalize(in.normal);
  // The mesh normal only where the field is undefined: local to these fragments.
  if (inside && glen > 1e-6) { n = sdfm_posed_normal(in, g / glen); }
  o.normal = n;
${colour}${debugText}
  return o;
}
`
  const bytes = new TextEncoder().encode(wgsl).length
  if (bytes > MATERIAL_FUNCTION_MAX_BYTES) {
    throw new Error(`field shading: the field material needs ${bytes} bytes of WGSL (RAA limit ${MATERIAL_FUNCTION_MAX_BYTES})`)
  }
  return { functionName: `pmf.${textHash(wgsl)}`, wgsl }
}
