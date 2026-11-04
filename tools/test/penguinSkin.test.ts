import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('saved penguin has shared position weights and stays closed through every clip', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url))
  const result = JSON.parse(execFileSync(process.execPath, ['tools/m13/poses.mjs'], { cwd, encoding: 'utf8' }))
  assert.equal(result.differingWeightGroups, 0)
  assert.equal(result.maxWeightDelta, 0)
  assert.equal(result.boundaryEdges, 0)
  assert.equal(result.animatedBoundaryMax, 0)
  assert(result.maxGap < 1e-7)
  // Welded: one vertex per position (baseline was 4664; preserve material and hard normal seams). The UV atlas (saved
  // mesh format 4) splits seam vertices, at most once more per position.
  assert(result.distinctPositions <= 1700, 'baseline was 4664; preserve material and hard normal seams')
  assert(result.vertices <= 2 * result.distinctPositions, 'the UV atlas splits only its chart seams')
  assert.equal(result.clips.length, 15)
  assert(result.clips.every((clip: { ticks: number[] }) => clip.ticks.length === 9))
})
