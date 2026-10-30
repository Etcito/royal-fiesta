import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { fixtureResolver } from '../src/assets.ts'
import { DPR_CAP, overviewCamera, pixelViewports, splitLayout } from '../src/client/splitLayout.ts'
import type { SplitCell } from '../src/client/splitLayout.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import type { Viewport } from '../src/render/port.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)

test('splitLayout: 1 seat fills the canvas', () => {
  assert.deepEqual(splitLayout(1, false), [{ x: 0, y: 0, width: 1, height: 1, seat: 0 }])
  assert.deepEqual(splitLayout(1, true), [{ x: 0, y: 0, width: 1, height: 1, seat: 0 }])
})

test('splitLayout: 2 seats are side by side at full height', () => {
  const cells = splitLayout(2, false)
  assert.deepEqual(cells, [
    { x: 0, y: 0, width: 0.5, height: 1, seat: 0 },
    { x: 0.5, y: 0, width: 0.5, height: 1, seat: 1 },
  ])
  assert.deepEqual(splitLayout(2, true), cells)
})

test('splitLayout: 3 seats fill the first three cells of a row-major 2x2 grid', () => {
  assert.deepEqual(splitLayout(3, false), [
    { x: 0, y: 0, width: 0.5, height: 0.5, seat: 0 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5, seat: 1 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5, seat: 2 },
  ])
  const withOverview = splitLayout(3, true)
  assert.equal(withOverview.length, 4)
  assert.deepEqual(withOverview[3], { x: 0.5, y: 0.5, width: 0.5, height: 0.5, seat: -1 })
  assert.deepEqual(withOverview.slice(0, 3), splitLayout(3, false))
})

test('splitLayout: 4 seats are row-major and ignore overview', () => {
  const cells = [
    { x: 0, y: 0, width: 0.5, height: 0.5, seat: 0 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5, seat: 1 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5, seat: 2 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5, seat: 3 },
  ]
  assert.deepEqual(splitLayout(4, false), cells)
  assert.deepEqual(splitLayout(4, true), cells)
})

test('splitLayout: seats outside 1..4 are refused', () => {
  for (const seats of [0, 5, -1, 1.5]) {
    assert.throws(() => splitLayout(seats, false), /\[client\] splitLayout:/)
  }
})

function overlaps(a: Viewport, b: Viewport): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function checkViewports(cells: readonly SplitCell[], cssW: number, cssH: number, dpr: number, full: boolean): Viewport[] {
  const W = Math.round(cssW * Math.min(dpr, DPR_CAP))
  const H = Math.round(cssH * Math.min(dpr, DPR_CAP))
  const rects = pixelViewports(cells, cssW, cssH, dpr)
  assert.equal(rects.length, cells.length)
  let area = 0
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y), `rect ${i} origin ${r.x},${r.y} is integral`)
    assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height), `rect ${i} size ${r.width}x${r.height} is integral`)
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H, `rect ${i} stays inside ${W}x${H}`)
    area += r.width * r.height
    for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(r, rects[j]), `rects ${i} and ${j} do not overlap`)
  }
  if (full) assert.equal(area, W * H)
  return rects
}

test('pixelViewports: 1920x1080 at dpr 1 covers the backing exactly', () => {
  const rects = checkViewports(splitLayout(4, false), 1920, 1080, 1, true)
  assert.deepEqual(rects, [
    { x: 0, y: 0, width: 960, height: 540 },
    { x: 960, y: 0, width: 960, height: 540 },
    { x: 0, y: 540, width: 960, height: 540 },
    { x: 960, y: 540, width: 960, height: 540 },
  ])
  checkViewports(splitLayout(1, false), 1920, 1080, 1, true)
  checkViewports(splitLayout(2, false), 1920, 1080, 1, true)
  checkViewports(splitLayout(3, true), 1920, 1080, 1, true)
  checkViewports(splitLayout(3, false), 1920, 1080, 1, false)
})

test('pixelViewports: 1366x768 at dpr 1.5 covers 2049x1152', () => {
  const rects = checkViewports(splitLayout(4, false), 1366, 768, 1.5, true)
  assert.equal(rects[0].width, 1025)
  assert.equal(rects[0].height, 576)
  assert.equal(rects[1].x, 1025)
  assert.equal(rects[1].width, 1024)
  checkViewports(splitLayout(2, false), 1366, 768, 1.5, true)
  checkViewports(splitLayout(3, true), 1366, 768, 1.5, true)
})

test('pixelViewports: 1001x333 at dpr 3 is capped to dpr 2', () => {
  const W = 1001 * DPR_CAP
  const H = 333 * DPR_CAP
  const rects = checkViewports(splitLayout(4, false), 1001, 333, 3, true)
  assert.equal(rects[3].x + rects[3].width, W)
  assert.equal(rects[3].y + rects[3].height, H)
  checkViewports(splitLayout(1, false), 1001, 333, 3, true)
  checkViewports(splitLayout(2, false), 1001, 333, 3, true)
  checkViewports(splitLayout(3, true), 1001, 333, 3, true)
})

test('pixelViewports: non-finite or non-positive sizes are refused', () => {
  const cells = splitLayout(1, false)
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => pixelViewports(cells, bad, 1080, 1), /\[client\] pixelViewports\.cssWidth:/)
    assert.throws(() => pixelViewports(cells, 1920, bad, 1), /\[client\] pixelViewports\.cssHeight:/)
    assert.throws(() => pixelViewports(cells, 1920, 1080, bad), /\[client\] pixelViewports\.dpr:/)
  }
})

async function loadCourses(): Promise<ResolvedCourse[]> {
  const names = readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
  const entries: CourseEntry[] = []
  for (const n of names) {
    const path = `fixtures/courses/${n}`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, resolver, 'sprint')
}

test('overviewCamera: race-sprint is seen from above and behind', async () => {
  const courses = await loadCourses()
  const course = courses.find(c => c.id === 'race-sprint')
  assert.ok(course, 'race-sprint is loaded')
  const cam = overviewCamera(course)
  assert.equal(cam.fovYDeg, 50)
  assert.equal(cam.near, 0.1)
  assert.ok(cam.eye[1] > cam.target[1], `eye.y ${cam.eye[1]} > target.y ${cam.target[1]}`)
  assert.ok(cam.eye[2] < cam.target[2], `eye.z ${cam.eye[2]} < target.z ${cam.target[2]}`)
  for (const v of [...cam.eye, ...cam.target, cam.fovYDeg, cam.near, cam.far]) {
    assert.ok(Number.isFinite(v), `${v} is finite`)
  }
  assert.ok(cam.far > cam.near)
})
