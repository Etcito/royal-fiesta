import type { FieldProgramLike, FieldOperandLike, FieldGridLike, FieldGridOperandLike } from './fieldShading.ts'

// Which parts keep per-pixel field shading when the world's grid textures would not fit
// RAA's one material texture atlas. This is a load-time planning step only: it reads the
// instance roots' byte costs and picks the parts that keep their field grid. It never
// builds normals or a normal volume.

// RAA keeps every material texture in one atlas: ATLAS_SIZE = 4096 texels on each side and
// ATLAS_FORMAT = Rgba8Unorm, so one texel is 4 bytes. The source that raises
// `texture.atlas_full` is crates/raa-lit/src/textures.rs (ShelfPacker::alloc in the pinned
// RAA; bricks.pins.json holds the commit). Capacity is 4096 * 4096 * 4 = 67108864 bytes.
const ATLAS_SIZE = 4096
const ATLAS_TEXEL_BYTES = 4
const ATLAS_CAPACITY_BYTES = ATLAS_SIZE * ATLAS_SIZE * ATLAS_TEXEL_BYTES

// RAA allocates whole texels, so a grid's cost is rounded up to that granularity.
const ATLAS_GRANULARITY_BYTES = ATLAS_TEXEL_BYTES

/** Bytes of RAA's atlas the field grids may use: 85% of its capacity, never measured. */
export const FIELD_ATLAS_BYTES: number = Math.floor(ATLAS_CAPACITY_BYTES * 0.85)

export interface PartFieldCost {
  key: string
  diag: number
  bytes: number
}

export interface FieldAtlasPlan {
  field: ReadonlySet<string>
  demoted: readonly string[]
  bytes: number
  budget: number
}

/** Bytes RAA allocates for one rgba8 grid texture; 0 when the part has no grid. */
export function fieldGridBytes(grid: { width: number; height: number } | null): number {
  if (grid === null) return 0
  const bytes = grid.width * grid.height * ATLAS_TEXEL_BYTES
  return Math.ceil(bytes / ATLAS_GRANULARITY_BYTES) * ATLAS_GRANULARITY_BYTES
}

/** Bounding-box diagonal over every position of every mesh; 0 for no vertex. */
export function partDiag(meshes: readonly { positions: Float32Array }[]): number {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let seen = false
  for (const mesh of meshes) {
    const p = mesh.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i]
      const y = p[i + 1]
      const z = p[i + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
      seen = true
    }
  }
  if (!seen) return 0
  const dx = maxX - minX
  const dy = maxY - minY
  const dz = maxZ - minZ
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

type Allocation = PartFieldCost & { width?: number; height?: number }

// RAA@6726387 crates/raa-lit/src/textures.rs: shortest fitting shelf, first on ties,
// in upload order, with ids 1..1023. Area alone does not guarantee an allocation fits.
function fitsAtlas(parts: readonly Allocation[], field: ReadonlySet<string>): boolean {
  const shelves: { width: number; height: number }[] = []
  let top = 0, textures = 0
  for (const p of parts) {
    if (!field.has(p.key) || p.bytes <= 0 || p.width === undefined || p.height === undefined) continue
    if (++textures > 1023 || p.width > ATLAS_SIZE || p.height > ATLAS_SIZE) return false
    let best: { width: number; height: number } | undefined
    for (const shelf of shelves) {
      if (shelf.height >= p.height && shelf.width + p.width <= ATLAS_SIZE &&
        (best === undefined || shelf.height < best.height)) best = shelf
    }
    if (best !== undefined) best.width += p.width
    else {
      top += p.height
      if (top > ATLAS_SIZE) return false
      shelves.push({ width: p.width, height: p.height })
    }
  }
  return true
}

/**
 * Parts whose grid textures fit keep their field shading; the rest are demoted to mesh
 * normals in order until the world fits the budget (FIELD_ATLAS_BYTES by default).
 */
export function planFieldAtlas(parts: readonly PartFieldCost[], budget: number = FIELD_ATLAS_BYTES): FieldAtlasPlan {
  return planAllocations(parts, budget)
}

// One entry per key, at its first traversal position: a resource retained from the previous
// scene and referenced again by the next is still one upload and keeps its existing cost,
// rather than being counted twice or moved by the later reference.
function firstByKey(parts: readonly Allocation[]): Allocation[] {
  const unique = new Map<string, Allocation>()
  for (const part of parts) if (!unique.has(part.key)) unique.set(part.key, part)
  return [...unique.values()]
}

function planAllocations(parts: readonly Allocation[], budget: number): FieldAtlasPlan {
  // A key names an uploaded part, shared by all its drawable instances. Demoting that
  // allocation changes their normal tier together; it releases its bytes only once.
  const unique = firstByKey(parts)
  const field = new Set<string>()
  let bytes = 0
  for (const part of unique) {
    field.add(part.key)
    bytes += part.bytes
  }
  const order = unique.map((part, position) => ({ part, position }))
    .sort((a, b) => a.part.bytes - b.part.bytes || a.position - b.position)
  const demoted: string[] = []
  for (const { part } of order) {
    if (bytes <= budget && fitsAtlas(unique, field)) break
    if (part.bytes <= 0) continue
    bytes -= part.bytes
    demoted.push(part.key)
    field.delete(part.key)
  }
  return { field, demoted, bytes, budget }
}

export interface PartFieldProgram { key: string; diag: number; program: FieldProgramLike }

// Shelf placement is independent of texel contents, so bisection never allocates images.
function packOperands(operands: readonly FieldOperandLike[]) {
  const slabs = operands.flatMap((o, index) => o.kind === 'grid'
    ? [{ index, width: o.size[0] * o.size[2], height: o.size[1] }] : [])
    .sort((a, b) => b.height - a.height || b.width - a.width || a.index - b.index)
  const at = new Map<number, readonly [number, number]>()
  let x = 0, y = 0, row = 0, width = 0
  for (const slab of slabs) {
    if (x + slab.width > 4096) { y += row; x = 0; row = 0 }
    at.set(slab.index, [x, y])
    x += slab.width
    width = Math.max(width, x)
    row = Math.max(row, slab.height)
  }
  return { at, width, height: y + row }
}

/** MAMA's centre-sampled trilinear distance, including extension beyond the lattice. */
export function sampleFieldGrid(grid: FieldGridLike, op: FieldGridOperandLike, p: readonly number[]): number {
  const g = p.map((v, a) => (v - op.origin[a]) / op.voxel - 0.5)
  const c = g.map((v, a) => Math.max(0, Math.min(op.size[a] - 1, v)))
  const i = c.map((v, a) => Math.min(Math.floor(v), op.size[a] - 2))
  const t = c.map((v, a) => v - i[a])
  let d = 0
  for (let k = 0; k < 8; k++) {
    const x = k & 1, y = (k >> 1) & 1, z = k >> 2
    const at = ((op.at[1] + i[1] + y) * grid.width + op.at[0] + (i[2] + z) * op.size[0] + i[0] + x) * 4
    const value = (((grid.texels[at] << 8) | grid.texels[at + 1]) / 65535 * 2 - 1) * op.range
    d += value * (x ? t[0] : 1 - t[0]) * (y ? t[1] : 1 - t[1]) * (z ? t[2] : 1 - t[2])
  }
  return d + Math.hypot(...g.map((v, a) => (v - c[a]) * op.voxel))
}

function scaledOperands(program: FieldProgramLike, diag: number, factor: number): readonly FieldOperandLike[] {
  if (factor === 1) return program.operands
  const blend = Math.max(0, ...program.tree.map(n => n.op === 'leaf' ? 0 : n.radius))
  return program.operands.map(o => {
    if (o.kind !== 'grid') return o
    const extent = o.size.map(n => Math.max(0, n - 4) * o.voxel)
    // Preserve already-coarser source grids. Never coarsen past either quality floor.
    const limit = Math.max(o.voxel, Math.min(diag / 32, Math.max(...extent) / 12))
    const voxel = Math.min(o.voxel * factor, limit)
    if (voxel === o.voxel) return o
    return { ...o, voxel,
      size: extent.map(e => Math.max(8, Math.min(64, Math.ceil(e / voxel) + 4))) as [number, number, number],
      origin: o.origin.map(v => v + 2 * o.voxel - 2 * voxel) as [number, number, number],
      range: Math.max(o.range, 4 * voxel, blend + 2 * voxel),
    }
  })
}

// Weak ownership releases the cached grids with their original saved program.
const repackedPrograms = new WeakMap<FieldProgramLike, Map<string, FieldProgramLike>>()

/** A fresh runtime program; the saved program and its bytes remain untouched. */
export function repackFieldProgram(program: FieldProgramLike, diag = 0, factor = 1): FieldProgramLike {
  if (program.grid === null) return program
  const cacheKey = `${program.functionName}:${diag}:${factor}`
  const cache = repackedPrograms.get(program) ?? new Map<string, FieldProgramLike>()
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const operands = scaledOperands(program, diag, factor)
  const packed = packOperands(operands)
  if (packed.width === 0) return { ...program, grid: null }
  const texels = new Uint8Array(packed.width * packed.height * 4)
  const rewritten = operands.map((o, index) => {
    if (o.kind !== 'grid') return o
    const old = program.operands[index] as FieldGridOperandLike
    const at = packed.at.get(index)!
    const width = o.size[0] * o.size[2]
    if (o.voxel === old.voxel) {
      for (let y = 0; y < o.size[1]; y++) {
        const start = ((old.at[1] + y) * program.grid!.width + old.at[0]) * 4
        texels.set(program.grid!.texels.subarray(start, start + width * 4), ((at[1] + y) * packed.width + at[0]) * 4)
      }
    } else {
      for (let y = 0; y < o.size[1]; y++) for (let z = 0; z < o.size[2]; z++) for (let x = 0; x < o.size[0]; x++) {
        const p = [x, y, z].map((v, a) => o.origin[a] + (v + 0.5) * o.voxel)
        const d = sampleFieldGrid(program.grid!, old, p)
        const q = Math.round((Math.max(-1, Math.min(1, d / o.range)) * 0.5 + 0.5) * 65535)
        const dest = ((at[1] + y) * packed.width + at[0] + z * o.size[0] + x) * 4
        texels[dest] = q >> 8
        texels[dest + 1] = q & 255
        texels[dest + 3] = 255
      }
    }
    return { ...o, at }
  })
  const result = { ...program, operands: rewritten, grid: { width: packed.width, height: packed.height, texels } }
  cache.set(cacheKey, result)
  repackedPrograms.set(program, cache)
  return result
}

export function planFieldPrograms(parts: readonly PartFieldProgram[], budget = FIELD_ATLAS_BYTES) {
  const costsAt = (factor: number) => parts.map(p => {
    const packed = packOperands(scaledOperands(p.program, p.diag, factor))
    return { key: p.key, diag: p.diag, bytes: fieldGridBytes(packed), width: packed.width, height: packed.height }
  })
  const total = (factor: number) => [...new Map(costsAt(factor).map(p => [p.key, p.bytes])).values()]
    .reduce((sum, bytes) => sum + bytes, 0)
  const repackedBytes = total(1)
  let factor = 1
  if (repackedBytes > budget) {
    // At this factor every operand has reached its floor; no unbounded search.
    const ceiling = Math.max(1, ...parts.flatMap(p => p.program.operands.flatMap(o => o.kind === 'grid'
      ? [Math.max(1, p.diag / 32 / o.voxel)] : [])))
    let lo = 1, hi = ceiling
    if (total(hi) <= budget) {
      while (hi / lo > 1.01) {
        const mid = (lo + hi) / 2
        if (total(mid) <= budget) hi = mid
        else lo = mid
      }
    }
    factor = hi
  }
  const programs = new Map(parts.map(p => [p.key, repackFieldProgram(p.program, p.diag, factor)]))
  const resampledParts = parts.filter(p => programs.get(p.key)!.operands.some((o, i) =>
    o.kind === 'grid' && o.voxel !== (p.program.operands[i] as FieldGridOperandLike).voxel)).length
  return { plan: planAllocations(costsAt(factor), budget), programs, fieldGridScale: factor, resampledParts, repackedBytes }
}
