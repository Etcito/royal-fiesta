// meshIssues (RAA's mesh rules) and repairMesh (the MAMA-to-RAA conversion step) on hand-made meshes:
// a collapsed triangle, a zero normal on a used vertex, a vertex only the collapsed triangle uses.
import assert from 'node:assert/strict'
import test from 'node:test'
import { meshIssues, repairMesh } from '../src/sdf/meshValidity.ts'
import type { MeshArrays } from '../src/sdf/meshValidity.ts'

// A unit quad in z=0 (two CCW triangles, +z normals), vertex 2's normal zero, plus vertex 4 that only
// the collapsed triangle (0, 4, 4) uses, the shape the poly output gives on candy.floor-tile.
function brokenQuad(): MeshArrays {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 4, 4]),
  }
}

test('meshIssues names every broken rule at once', () => {
  const issues = meshIssues(brokenQuad())
  assert.ok(issues.some(i => i.startsWith('mesh.degenerate_triangle: 1 ')), issues.join('\n'))
  assert.ok(issues.some(i => i.startsWith('mesh.invalid_normal: 2 normals are zero-length')), issues.join('\n'))
  assert.equal(issues.length, 2, issues.join('\n'))
})

test('meshIssues: index range, non-finite position, non-unit normal, unused vertex', () => {
  const m = brokenQuad()
  m.indices = Uint32Array.from([0, 1, 2, 0, 2, 9])
  assert.ok(meshIssues(m).some(i => i.startsWith('mesh.index_range')))
  const n = brokenQuad()
  n.indices = Uint32Array.from([0, 1, 3])
  n.positions[0] = Number.NaN
  n.normals.set([0, 0, 2], 3)
  const issues = meshIssues(n)
  assert.ok(issues.some(i => i.startsWith('mesh.non_finite: positions[0]')), issues.join('\n'))
  assert.ok(issues.some(i => i.startsWith('mesh.unused_vertex: 2 ')), issues.join('\n'))
  assert.ok(issues.some(i => i.includes('not unit length')), issues.join('\n'))
})

test('repairMesh drops the collapsed triangle, rebuilds the zero normal, removes the unused vertex', () => {
  const out = repairMesh(brokenQuad(), 'test')
  assert.ok(out !== null)
  assert.deepEqual(out.stats, { degenerateTriangles: 1, rebuiltNormals: 1, unusedVertices: 1 })
  assert.deepEqual(meshIssues(out.mesh), [])
  assert.deepEqual([...out.mesh.indices], [0, 1, 2, 0, 2, 3])
  assert.deepEqual([...out.mesh.normals.subarray(6, 9)], [0, 0, 1]) // from the two triangles around it
  assert.deepEqual([...out.mesh.uvs!], [0, 0, 1, 0, 1, 1, 0, 1])
})

test('repairMesh keeps valid normals and has no normal to give when the triangles cancel out', () => {
  const m = brokenQuad()
  m.normals.set([0.6, 0, 0.8], 0)
  m.normals.set([0, 0, 1], 6)
  assert.deepEqual([...repairMesh(m, 'test')!.mesh.normals.subarray(0, 3)], [...Float32Array.from([0.6, 0, 0.8])])
  const back = brokenQuad()
  back.indices = Uint32Array.from([0, 1, 2, 2, 1, 0]) // one triangle and its back face
  assert.throws(() => repairMesh(back, 'a#group:g/p/m'), /a#group:g\/p\/m: vertex 2 has a zero normal and its triangles cancel out/)
})

test('repairMesh returns null when every triangle is collapsed', () => {
  const m = brokenQuad()
  m.indices = Uint32Array.from([0, 4, 4, 1, 1, 1])
  assert.equal(repairMesh(m, 'test'), null)
})
