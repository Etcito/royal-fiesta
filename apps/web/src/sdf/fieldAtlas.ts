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

// Smallest on-screen (diagonal) first, then cheapest grid, then key: stable and locale-free.
function compareParts(a: PartFieldCost, b: PartFieldCost): number {
  if (a.diag !== b.diag) return a.diag - b.diag
  if (a.bytes !== b.bytes) return a.bytes - b.bytes
  if (a.key < b.key) return -1
  if (a.key > b.key) return 1
  return 0
}

/**
 * Parts whose grid textures fit keep their field shading; the rest are demoted to mesh
 * normals in order until the world fits the budget (FIELD_ATLAS_BYTES by default).
 */
export function planFieldAtlas(parts: readonly PartFieldCost[], budget: number = FIELD_ATLAS_BYTES): FieldAtlasPlan {
  const field = new Set<string>()
  let bytes = 0
  for (const part of parts) {
    field.add(part.key)
    bytes += part.bytes
  }
  const order = [...parts].sort(compareParts)
  const demoted: string[] = []
  for (const part of order) {
    if (bytes <= budget) break
    if (part.bytes <= 0) continue
    bytes -= part.bytes
    demoted.push(part.key)
    field.delete(part.key)
  }
  return { field, demoted, bytes, budget }
}
