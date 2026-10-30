import assert from 'node:assert/strict'
import test from 'node:test'
import { farFigureMesh, farTint } from '../src/render/farRender.ts'
import { PALETTE } from '../src/render/palette.ts'

test('far silhouette has a body, head, paired flippers and feet with outward faces', () => {
  const mesh = farFigureMesh().groups[0].parts[0].meshes[0]
  assert.equal(mesh.indices.length / 3, 840)
  assert.equal(mesh.positions.length, mesh.normals.length)
  assert.ok(Math.min(...mesh.positions.filter((_, i) => i % 3 === 0)) < -0.6)
  assert.ok(Math.max(...mesh.positions.filter((_, i) => i % 3 === 0)) > 0.6)
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3
    const b = mesh.indices[i + 1] * 3
    const c = mesh.indices[i + 2] * 3
    const p = mesh.positions
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]
    const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    assert.ok(normal.reduce((sum, n, axis) => sum + n * mesh.normals[a + axis], 0) >= -1e-7)
  }
})

test('far tints retain team channel order and wrap seats like the near palette', () => {
  for (let seat = 0; seat < PALETTE.length; seat++) {
    const tint = farTint(seat)
    assert.deepEqual(farTint(seat + PALETTE.length), tint)
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      assert.equal(Math.sign(tint[a] - tint[b]), Math.sign(PALETTE[seat][a] - PALETTE[seat][b]))
    }
  }
})
