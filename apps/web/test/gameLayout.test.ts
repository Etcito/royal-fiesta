// Layout math of game.html's local canvas (S26): the split cells and the DPR-capped pixel viewports
// main.ts hands port.resize. main.ts itself imports vite-only modules, so this checks the DOM-free
// splitLayout module it uses.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DPR_CAP, pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'

interface Rect { x: number; y: number; width: number; height: number }

// The canvas backing size a viewport list covers: the union's far edge.
function backing(rects: readonly Rect[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const r of rects) {
    width = Math.max(width, r.x + r.width)
    height = Math.max(height, r.y + r.height)
  }
  return { width, height }
}

// Integer, in-bounds rects whose areas sum to the backing: no gap and no overlap.
function assertCovers(rects: readonly Rect[], width: number, height: number): void {
  let area = 0
  for (const r of rects) {
    for (const n of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(n), `rect ${JSON.stringify(r)} has a non-integer edge`)
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height, `rect ${JSON.stringify(r)} leaves ${width}x${height}`)
    assert.ok(r.width > 0 && r.height > 0, `rect ${JSON.stringify(r)} is empty`)
    area += r.width * r.height
  }
  assert.equal(area, width * height, 'the rects do not cover the canvas without gaps or overlap')
  assert.deepEqual(backing(rects), { width, height })
}

test('pixelViewports: 1..4 seats cover 1920x1080 at dpr 1', () => {
  for (let seats = 1; seats <= 4; seats++) {
    const cells = splitLayout(seats, seats === 3)
    const rects = pixelViewports(cells, 1920, 1080, 1)
    assert.equal(rects.length, seats < 3 ? seats : 4, `${seats} seats: 1, 2, 4 and 4 rects`)
    assertCovers(rects, 1920, 1080)
  }
})

test('pixelViewports: the DPR is capped at 2', () => {
  assert.equal(DPR_CAP, 2)
  const cells = splitLayout(3, true)
  const cases: readonly (readonly [number, number, number])[] = [[1, 1920, 1080], [2, 3840, 2160], [3, 3840, 2160]]
  for (const [dpr, width, height] of cases) {
    const rects = pixelViewports(cells, 1920, 1080, dpr)
    assertCovers(rects, width, height)
    assert.deepEqual(backing(rects), { width, height }, `dpr ${dpr}`)
  }
})

test('pixelViewports: a resize from 1280x720 to 844x390 at dpr 3 backs at 1688x780', () => {
  const cells = splitLayout(3, true)
  assertCovers(pixelViewports(cells, 1280, 720, 3), 2560, 1440)
  const rects = pixelViewports(cells, 844, 390, 3)
  assert.equal(rects.length, 4)
  assertCovers(rects, 1688, 780)
})
