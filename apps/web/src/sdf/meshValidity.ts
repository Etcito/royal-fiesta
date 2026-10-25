// The mesh rules RAA applies at upload (raa-mesh validate: lengths, finite values, index range, non-zero
// normals), plus the geometry rules that keep them true: no degenerate triangle, no vertex no triangle uses.
// repairMesh is the MAMA-to-RAA conversion step for MAMA sub-meshes that break them; meshIssues is the
// node-side check (m17 mesh-node) that names every bad mesh before any GPU run. Pure: no MAMA, no DOM.

export interface MeshArrays {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
}

export interface MeshRepairStats {
  degenerateTriangles: number // dropped: a repeated index or a zero-area (collapsed) triangle
  rebuiltNormals: number // zero-length or non-finite normals rebuilt from the triangles around the vertex
  unusedVertices: number // removed: no triangle uses them
}

// A unit normal is within this of length 1; RAA normalises, so this only catches broken writers.
const UNIT_TOLERANCE = 1e-3
// Zero area relative to the triangle's own size: collinear float32 corners never give an exact 0.
const DEGENERATE_RELATIVE_AREA = 1e-9

// Twice the area vector of triangle (a, b, c), or null when the triangle is degenerate.
function faceNormal(p: Float32Array, a: number, b: number, c: number): [number, number, number] | null {
  if (a === b || b === c || a === c) return null
  const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2]
  const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2]
  const wx = vx - ux, wy = vy - uy, wz = vz - uz
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const area = Math.hypot(nx, ny, nz)
  const edge2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz)
  if (!Number.isFinite(area) || area <= DEGENERATE_RELATIVE_AREA * edge2) return null
  return [nx, ny, nz]
}

function validNormal(n: Float32Array, v: number): boolean {
  const l = Math.hypot(n[3 * v], n[3 * v + 1], n[3 * v + 2])
  return Number.isFinite(l) && l > 0
}

function allFinite(a: Float32Array): number {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return i
  return -1
}

/**
 * Every rule a mesh breaks, as '<rule>: <detail>' lines (empty = valid): non-empty, lengths, finite
 * positions/normals/uvs, indices in range, unit non-zero normals, no degenerate triangle, no unused vertex.
 */
export function meshIssues(mesh: MeshArrays): string[] {
  const issues: string[] = []
  const { positions, normals, uvs, indices } = mesh
  const n = positions.length / 3
  if (n === 0 || indices.length === 0) return [`mesh.empty: ${n} vertices, ${indices.length} indices`]
  if (positions.length % 3 !== 0) issues.push(`mesh.length_mismatch: positions length ${positions.length} is not a multiple of 3`)
  if (normals.length !== positions.length) issues.push(`mesh.length_mismatch: normals length ${normals.length}, positions ${positions.length}`)
  if (uvs !== null && uvs.length !== n * 2) issues.push(`mesh.length_mismatch: uvs length ${uvs.length} for ${n} vertices`)
  if (indices.length % 3 !== 0) issues.push(`mesh.length_mismatch: indices length ${indices.length} is not a multiple of 3`)
  if (issues.length > 0) return issues
  const badPosition = allFinite(positions)
  if (badPosition >= 0) issues.push(`mesh.non_finite: positions[${badPosition}] = ${positions[badPosition]}`)
  const badUv = uvs === null ? -1 : allFinite(uvs)
  if (badUv >= 0) issues.push(`mesh.non_finite: uvs[${badUv}] = ${uvs![badUv]}`)
  const used = new Uint8Array(n)
  let outOfRange = 0, degenerate = 0, firstOut = -1, firstDegenerate = -1
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    if (a >= n || b >= n || c >= n) { if (outOfRange++ === 0) firstOut = t; continue }
    used[a] = used[b] = used[c] = 1
    if (faceNormal(positions, a, b, c) === null && degenerate++ === 0) firstDegenerate = t / 3
  }
  if (outOfRange > 0) issues.push(`mesh.index_range: ${outOfRange} triangles index past ${n} vertices (first at indices[${firstOut}])`)
  if (degenerate > 0) issues.push(`mesh.degenerate_triangle: ${degenerate} triangles have zero area (first triangle ${firstDegenerate})`)
  let zero = 0, notUnit = 0, unused = 0, firstZero = -1, firstNotUnit = -1, firstUnused = -1
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
    if (!Number.isFinite(l) || l === 0) { if (zero++ === 0) firstZero = v }
    else if (Math.abs(l - 1) > UNIT_TOLERANCE && notUnit++ === 0) firstNotUnit = v
    if (used[v] === 0 && unused++ === 0) firstUnused = v
  }
  if (zero > 0) issues.push(`mesh.invalid_normal: ${zero} normals are zero-length or non-finite (first normals[${firstZero}])`)
  if (notUnit > 0) issues.push(`mesh.invalid_normal: ${notUnit} normals are not unit length (first normals[${firstNotUnit}])`)
  if (unused > 0) issues.push(`mesh.unused_vertex: ${unused} vertices are used by no triangle (first vertex ${firstUnused})`)
  return issues
}

/**
 * The mesh with its degenerate triangles dropped, each zero-length or non-finite normal rebuilt as the
 * area-weighted normal of the triangles around that vertex, and the vertices no triangle uses removed
 * (first-use order kept). Valid MAMA normals (sharp-edge splits included) are kept as they are. Returns
 * null when no triangle is left. Throws when a normal cannot be rebuilt (its triangles cancel out):
 * that mesh has no normal to give, and RAA would refuse it.
 */
export function repairMesh(mesh: MeshArrays, where: string): { mesh: MeshArrays; stats: MeshRepairStats } | null {
  const { positions, normals, uvs, indices } = mesh
  const n = positions.length / 3
  const stats: MeshRepairStats = { degenerateTriangles: 0, rebuiltNormals: 0, unusedVertices: 0 }
  const kept: number[] = []
  const sum = new Float64Array(n * 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    const f = faceNormal(positions, a, b, c)
    if (f === null) { stats.degenerateTriangles++; continue }
    kept.push(a, b, c)
    for (const v of [a, b, c]) { sum[3 * v] += f[0]; sum[3 * v + 1] += f[1]; sum[3 * v + 2] += f[2] }
  }
  if (kept.length === 0) return null
  const remap = new Int32Array(n).fill(-1)
  const order: number[] = []
  for (const v of kept) if (remap[v] < 0) { remap[v] = order.length; order.push(v) }
  stats.unusedVertices = n - order.length
  const m = order.length
  const outPositions = new Float32Array(m * 3), outNormals = new Float32Array(m * 3)
  const outUvs = uvs === null ? null : new Float32Array(m * 2)
  for (let r = 0; r < m; r++) {
    const v = order[r]
    outPositions.set(positions.subarray(3 * v, 3 * v + 3), 3 * r)
    if (outUvs !== null) outUvs.set(uvs!.subarray(2 * v, 2 * v + 2), 2 * r)
    if (validNormal(normals, v)) {
      outNormals.set(normals.subarray(3 * v, 3 * v + 3), 3 * r)
      continue
    }
    const l = Math.hypot(sum[3 * v], sum[3 * v + 1], sum[3 * v + 2])
    if (!(l > 0) || !Number.isFinite(l)) {
      throw new Error(`${where}: vertex ${v} has a zero normal and its triangles cancel out, so no normal can be rebuilt; re-save the asset in SDF Modeler`)
    }
    outNormals[3 * r] = sum[3 * v] / l
    outNormals[3 * r + 1] = sum[3 * v + 1] / l
    outNormals[3 * r + 2] = sum[3 * v + 2] / l
    stats.rebuiltNormals++
  }
  const outIndices = new Uint32Array(kept.length)
  for (let i = 0; i < kept.length; i++) outIndices[i] = remap[kept[i]]
  return { mesh: { positions: outPositions, normals: outNormals, uvs: outUvs, indices: outIndices }, stats }
}
