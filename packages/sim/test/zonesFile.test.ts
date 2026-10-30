import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { CONTROL_NO_CELL, ZONE_DEFAULTS } from '@gamesaloon/rollback/zones'
import { isRefusal } from '../src/refusal.ts'
import { cellDistance, cellOf } from '../src/zones/cells.ts'
import {
  ZONES_FORMAT, ZONES_VERSION, loadZonesFile, parseZonesFile, partMode,
} from '../src/zones/zonesFile.ts'
import type { ZonesFile } from '../src/zones/zonesFile.ts'

const COURSE = {
  id: 'test-course',
  obstacles: [
    { id: 'seesaw-1', motion: { kind: 'seesaw' } },
    { id: 'spinner-1', motion: { kind: 'spinner' } },
    { id: 'pendulum-1', motion: { kind: 'pendulum' } },
    { id: 'door-1', motion: { kind: 'rotatingDoor' } },
    { id: 'platform-1', motion: { kind: 'movingPlatform' } },
    { id: 'conveyor-1', motion: { kind: 'conveyor' } },
    { id: 'floor-1', motion: { kind: 'static' } },
  ],
} as const

type Json = Record<string, any>

function valid(): Json {
  return {
    format: ZONES_FORMAT,
    version: ZONES_VERSION,
    course: COURSE.id,
    grid: { origin: [0, 0], cell: [2, 2], cols: 8, rows: 8 },
    parts: {},
    tuning: {},
  }
}

function parse(json: unknown): ZonesFile {
  return parseZonesFile(json, 'sidecar', COURSE)
}

function refuses(build: () => unknown, fragment: string): void {
  assert.throws(build, (error: unknown) =>
    isRefusal(error) && error.message.startsWith('[zones] ') && error.message.includes(fragment))
}

test('format, version and course must match', () => {
  let json = valid()
  json.format = 'other'
  refuses(() => parse(json), 'sidecar/format')
  json = valid()
  json.version = ZONES_VERSION + 1
  refuses(() => parse(json), 'sidecar/version')
  json = valid()
  json.course = 'other-course'
  refuses(() => parse(json), 'sidecar/course')
})

test('unknown keys are refused at every level', () => {
  let json = valid()
  json.extra = true
  refuses(() => parse(json), 'sidecar/extra')
  json = valid()
  json.grid.extra = true
  refuses(() => parse(json), 'sidecar/grid/extra')
  json = valid()
  json.tuning.extra = true
  refuses(() => parse(json), 'sidecar/tuning/extra')
  json = valid()
  json.tuning.farStrides = [{ maxCells: 2, stride: 2, extra: true }]
  refuses(() => parse(json), 'sidecar/tuning/farStrides[0]/extra')
  json = valid()
  json.tuning.costClass = { seat: 'tiebreak', field: 'checkpoint', global: 'reset', extra: true }
  refuses(() => parse(json), 'sidecar/tuning/costClass/extra')
})

test('grid origin and cell must be two finite numbers', () => {
  let json = valid()
  json.grid.origin = [0]
  refuses(() => parse(json), 'sidecar/grid/origin')
  json = valid()
  json.grid.origin = [0, Number.POSITIVE_INFINITY]
  refuses(() => parse(json), 'sidecar/grid/origin')
  json = valid()
  json.grid.cell = ['2', 2]
  refuses(() => parse(json), 'sidecar/grid/cell')
})

test('cell sizes must be greater than 0', () => {
  const json = valid()
  json.grid.cell = [0, 2]
  refuses(() => parse(json), 'sidecar/grid/cell')
})

test('cols and rows must be positive integers', () => {
  let json = valid()
  json.grid.cols = 0
  refuses(() => parse(json), 'sidecar/grid/cols')
  json = valid()
  json.grid.rows = 1.5
  refuses(() => parse(json), 'sidecar/grid/rows')
  json = valid()
  json.grid.rows = -1
  refuses(() => parse(json), 'sidecar/grid/rows')
})

test('cols*rows must stay within the no-cell value', () => {
  const json = valid()
  json.grid.cols = 0x100
  json.grid.rows = 0x100
  refuses(() => parse(json), 'sidecar/grid')
})

test('parts keys must be course obstacle ids and values must be known modes', () => {
  let json = valid()
  json.parts = { 'missing-part': 'kinematic' }
  refuses(() => parse(json), 'sidecar/parts/missing-part')
  json = valid()
  json.parts = { 'seesaw-1': 'rigid' }
  refuses(() => parse(json), 'sidecar/parts/seesaw-1')
})

test('physics is refused on a part that is not a seesaw', () => {
  const json = valid()
  json.parts = { 'spinner-1': 'physics' }
  refuses(() => parse(json), 'sidecar/parts/spinner-1')
})

test('tuning keys are limited to ZoneTuning and the merged set must validate', () => {
  const json = valid()
  json.tuning = { epochTicks: 0 }
  refuses(() => parse(json), 'sidecar/tuning/epochTicks')
})

test('partMode defaults follow the motion kind', () => {
  const zones = parse(valid())
  const expected: Record<string, 'kinematic' | 'physics'> = {
    seesaw: 'physics',
    spinner: 'kinematic',
    pendulum: 'kinematic',
    rotatingDoor: 'kinematic',
    movingPlatform: 'kinematic',
    conveyor: 'kinematic',
    static: 'kinematic',
  }
  for (const obstacle of COURSE.obstacles) {
    assert.equal(partMode(zones, obstacle), expected[obstacle.motion.kind], obstacle.id)
  }
})

test('an explicit parts override is kept', () => {
  const json = valid()
  json.parts = { 'seesaw-1': 'kinematic', 'spinner-1': 'kinematic' }
  const zones = parse(json)
  assert.deepEqual(zones.parts, { 'seesaw-1': 'kinematic', 'spinner-1': 'kinematic' })
  assert.equal(partMode(zones, COURSE.obstacles[0]), 'kinematic')
  assert.equal(partMode(zones, COURSE.obstacles[1]), 'kinematic')
})

test('tuning overrides are merged over ZONE_DEFAULTS', () => {
  const json = valid()
  json.tuning = { replicas: 3, gridCols: 8 }
  const zones = parse(json)
  assert.equal(zones.tuning.replicas, 3)
  assert.equal(zones.tuning.gridCols, 8)
  assert.equal(zones.tuning.epochTicks, ZONE_DEFAULTS.epochTicks)
  assert.equal(zones.tuning.snapshotRing, ZONE_DEFAULTS.snapshotRing)
})

test('loadZonesFile reads courses/<id>.zones.json through the injected reader', async () => {
  const seen: string[] = []
  const zones = await loadZonesFile(COURSE.id, COURSE, async (path) => {
    seen.push(path)
    return JSON.stringify(valid())
  })
  assert.deepEqual(seen, [`courses/${COURSE.id}.zones.json`])
  assert.equal(zones.course, COURSE.id)
})

test('loadZonesFile refuses a missing sidecar', async () => {
  await assert.rejects(
    loadZonesFile(COURSE.id, COURSE, async () => { throw new Error('ENOENT') }),
    (error: unknown) => isRefusal(error) && error.message ===
      `[zones] courses/${COURSE.id}.zones.json: missing; add the sidecar (zone mode needs it, full-mesh mode does not)`,
  )
})

type CoursePoint = [number, number, number]
interface CourseBox { center: CoursePoint; half: CoursePoint }
interface SidecarCourse {
  id: string
  obstacles: { id: string; t: CoursePoint; motion: { kind: string } }[]
  spawns: { t: CoursePoint }[]
  checkpoints: (CourseBox & { respawn: { t: CoursePoint } })[]
  finish: CourseBox | null
}

async function readRepoText(path: string): Promise<string> {
  return readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')
}

for (const courseId of ['race-sprint', 'obstacle-gallery']) {
  test(`${courseId} sidecar covers the course with margin and useful cell spacing`, async () => {
    const source: SidecarCourse = JSON.parse(await readRepoText(`courses/${courseId}.course.json`))
    const course = {
      id: source.id,
      obstacles: source.obstacles.map(({ id, motion }) => ({ id, motion: { kind: motion.kind } })),
    }
    const zones = await loadZonesFile(courseId, course, readRepoText)
    assert.equal(zones.format, ZONES_FORMAT)
    assert.equal(zones.version, ZONES_VERSION)
    assert.equal(zones.course, courseId)
    assert.deepEqual(zones.parts, {})
    assert.equal(zones.tuning.gridCols, zones.grid.cols)

    const { grid } = zones
    function covers(x: number, z: number, label: string): void {
      assert.notEqual(cellOf(grid, x, z), CONTROL_NO_CELL, label)
      assert.ok(x >= grid.origin[0] + grid.cell[0], `${label}: left margin`)
      assert.ok(x <= grid.origin[0] + (grid.cols - 1) * grid.cell[0], `${label}: right margin`)
      assert.ok(z >= grid.origin[1] + grid.cell[1], `${label}: back margin`)
      assert.ok(z <= grid.origin[1] + (grid.rows - 1) * grid.cell[1], `${label}: front margin`)
    }

    function coversBox(box: CourseBox, label: string): void {
      for (const x of [box.center[0] - box.half[0], box.center[0] + box.half[0]]) {
        for (const z of [box.center[2] - box.half[2], box.center[2] + box.half[2]]) {
          covers(x, z, label)
        }
      }
    }

    for (const obstacle of source.obstacles) covers(obstacle.t[0], obstacle.t[2], obstacle.id)
    const spawnCells = new Set<number>()
    for (const spawn of source.spawns) {
      covers(spawn.t[0], spawn.t[2], 'spawn')
      spawnCells.add(cellOf(grid, spawn.t[0], spawn.t[2]))
    }
    assert.ok(spawnCells.size > 1, 'start spawns span more than one cell')
    for (const checkpoint of source.checkpoints) {
      coversBox(checkpoint, 'checkpoint')
      covers(checkpoint.respawn.t[0], checkpoint.respawn.t[2], 'checkpoint respawn')
    }
    if (source.finish) coversBox(source.finish, 'finish')
    const positions = [...source.obstacles, ...source.spawns].map(({ t }) => t[2])
    assert.ok(Math.max(...positions) - Math.min(...positions) >= 3 * grid.cell[1],
      'course length spans several cells')
  })
}

const GRID = {
  origin: [-8, -4] as [number, number],
  cell: [2, 5] as [number, number],
  cols: 4,
  rows: 3,
}

test('cellOf maps points inside the grid and clamps the edges', () => {
  assert.equal(cellOf(GRID, -8, -4), 0)
  assert.equal(cellOf(GRID, -7.9, -4), 0)
  assert.equal(cellOf(GRID, -6, -4), 1)
  assert.equal(cellOf(GRID, -8, 1), 4)
  assert.equal(cellOf(GRID, -1, 10.9), 11)
  assert.equal(cellOf(GRID, -1, 11), CONTROL_NO_CELL)
  assert.equal(cellOf(GRID, 0, -4), CONTROL_NO_CELL)
})

test('cellOf returns no cell outside the grid and at negative coordinates', () => {
  assert.equal(cellOf(GRID, -8.001, -4), CONTROL_NO_CELL)
  assert.equal(cellOf(GRID, -8, -4.001), CONTROL_NO_CELL)
  assert.equal(cellOf(GRID, -100, -100), CONTROL_NO_CELL)
})

test('cellDistance is symmetric Chebyshev and keeps the no-cell value', () => {
  assert.equal(cellDistance(GRID, 0, 11), 3)
  assert.equal(cellDistance(GRID, 11, 0), 3)
  assert.equal(cellDistance(GRID, 1, 4), 1)
  assert.equal(cellDistance(GRID, CONTROL_NO_CELL, 0), CONTROL_NO_CELL)
  assert.equal(cellDistance(GRID, 0, CONTROL_NO_CELL), CONTROL_NO_CELL)
})
