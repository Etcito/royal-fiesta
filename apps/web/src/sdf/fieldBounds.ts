// Conservative lower bounds on the quantized field distance, in the part frame.
import type { FieldGridLike, FieldGridOperandLike, FieldOperandLike, FieldProgramLike, FieldTreeNodeLike } from './fieldShading.ts'

type Vec3 = [number, number, number]
export interface FieldBound {
  min: Vec3
  max: Vec3
  gain: number
  offset: number
  outsideOffset: number
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Clamping a point outside the volume puts its trilinear interpolation on a lattice face.
function boundaryMinimum(grid: FieldGridLike, op: FieldGridOperandLike): number {
  const [nx, ny, nz] = op.size
  const [ax, ay] = op.at
  let minimum = 65535
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      const face = y === 0 || y === ny - 1 || z === 0 || z === nz - 1
      for (let x = 0; x < nx; x += face ? 1 : nx - 1) {
        const i = 4 * ((ay + y) * grid.width + ax + z * nx + x)
        minimum = Math.min(minimum, 256 * grid.texels[i] + grid.texels[i + 1])
      }
    }
  }
  return (2 * minimum / 65535 - 1) * Math.fround(op.range)
}

/** Match the packed f32 coefficients. Each row of the forward transform bounds how far a unit
 * local displacement can move along that part-space axis, including for sheared/scaled operands. */
function operandBound(o: FieldOperandLike, grid: FieldGridLike | null): FieldBound | null {
  const m = o.inv.map(Math.fround)
  const a: Vec3 = [m[0], m[1], m[2]]
  const b: Vec3 = [m[4], m[5], m[6]]
  const c: Vec3 = [m[8], m[9], m[10]]
  const adj = [cross(b, c), cross(c, a), cross(a, b)]
  const det = dot(a, adj[0])
  if (!Number.isFinite(det) || det === 0) return null
  const shift: Vec3 = [m[12], m[13], m[14]]
  const origin: Vec3 = o.kind === 'box' ? [0, 0, 0] : [
    Math.fround(o.origin[0]) + Math.fround(o.voxel) * o.size[0] / 2,
    Math.fround(o.origin[1]) + Math.fround(o.voxel) * o.size[1] / 2,
    Math.fround(o.origin[2]) + Math.fround(o.voxel) * o.size[2] / 2,
  ]
  const half: Vec3 = o.kind === 'box' ? [Math.fround(o.half[0]), Math.fround(o.half[1]), Math.fround(o.half[2])] : [
    Math.fround(o.voxel) * (o.size[0] - 1) / 2, Math.fround(o.voxel) * (o.size[1] - 1) / 2,
    Math.fround(o.voxel) * (o.size[2] - 1) / 2,
  ]
  const fromLocal: Vec3 = [origin[0] - shift[0], origin[1] - shift[1], origin[2] - shift[2]]
  const min: Vec3 = [0, 0, 0]
  const max: Vec3 = [0, 0, 0]
  let reach = 0
  for (let i = 0; i < 3; i++) {
    const row: Vec3 = [adj[i][0] / det, adj[i][1] / det, adj[i][2] / det]
    const center = dot(row, fromLocal)
    const extent = dot([Math.abs(row[0]), Math.abs(row[1]), Math.abs(row[2])], half)
    min[i] = center - extent
    max[i] = center + extent
    reach = Math.max(reach, Math.hypot(...row))
  }
  // Ill-conditioned frames can amplify rounding in the shader's part-to-local transform.
  if (reach * Math.max(Math.hypot(...a), Math.hypot(...b), Math.hypot(...c)) > 32) return null
  const scale = Math.fround(o.scale)
  const gain = scale / reach
  // An outside rounded-box distance is at least its enclosing box distance. A clamped grid adds
  // its outside distance to a convex interpolation of samples in [-range, range].
  const minimum = o.kind === 'box' ? Math.min(...half) : Math.fround(o.range)
  const offset = -scale * minimum
  const outsideOffset = o.kind === 'box' ? 0 : grid !== null ? scale * boundaryMinimum(grid, o) : offset
  if (![...min, ...max, gain, offset, outsideOffset].every(n => Number.isFinite(Math.fround(n)))) return null
  return { min, max, gain, offset, outsideOffset }
}

function combineBounds(node: Exclude<FieldTreeNodeLike, { op: 'leaf' }>, a: FieldBound | null, b: FieldBound | null): FieldBound | null {
  if (node.op === 'subtract') return a
  if (node.op === 'intersect') return a ?? b
  if (!a || !b || (node.mode === 'chamfer' && node.radius > 0)) return null
  const radius = Math.max(0, Math.fround(node.radius))
  const offset = Math.min(a.offset, b.offset)
  // The maximum round correction below the smaller distance d is (sqrt(2)-1)*(r-d),
  // attained for equal inputs when d < r. The bound's offset is itself a lower bound on d.
  const reduction = node.mode === 'smooth' ? radius / 4
    : node.mode === 'round' && radius > 0 ? (Math.SQRT2 - 1) * Math.max(0, radius - offset) : 0
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    gain: Math.min(a.gain, b.gain),
    offset: offset - reduction,
    outsideOffset: Math.min(a.outsideOffset, b.outsideOffset) - reduction,
  }
}

type Guard = { target: number; radius: number; round: boolean; bound: FieldBound }

/** A guard can skip a union's right subtree and its combine instruction, leaving the left value
 * untouched. A lone analytic leaf costs about the same as the guard, so leave it as-is. */
export function fieldUnionGuards(program: FieldProgramLike): Map<number, Guard> {
  const operands = program.operands.map(o => operandBound(o, program.grid))
  const stack: { start: number; bound: FieldBound | null; worthSkipping: boolean }[] = []
  const guards = new Map<number, Guard>()
  for (const [i, node] of program.tree.entries()) {
    if (node.op === 'leaf') {
      stack.push({ start: i, bound: operands[node.operand], worthSkipping: program.operands[node.operand].kind === 'grid' })
      continue
    }
    const b = stack.pop()!
    const a = stack.pop()!
    if (node.op === 'union' && b.worthSkipping && b.bound && (node.mode !== 'chamfer' || node.radius <= 0)) {
      const radius = node.mode === 'hard' ? 0 : Math.max(0, Math.fround(node.radius))
      guards.set(b.start, { target: i + 1, radius, round: node.mode === 'round' && radius > 0, bound: b.bound })
    }
    stack.push({ start: a.start, bound: combineBounds(node, a.bound, b.bound), worthSkipping: true })
  }
  return guards
}
