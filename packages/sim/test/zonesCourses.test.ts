import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { CONTROL_NO_CELL } from '@gamesaloon/rollback/zones'
import { cellOf } from '../src/zones/cells.ts'
import { parseZonesFile } from '../src/zones/zonesFile.ts'
import type { ZonesFile } from '../src/zones/zonesFile.ts'

const COURSES = new URL('../../../courses/', import.meta.url)
const COURSE_SUFFIX = '.course.json'
const SPAWN_MARGIN_M = 8
const OBSTACLE_MARGIN_M = 4
// The two M4 sidecars stay as shipped; only the sidecars added here are held to
// the spawn and obstacle margin boxes.
const INHERITED = new Set(['race-sprint', 'obstacle-gallery'])

type Point = [number, number, number]

interface CourseObstacle {
  id: string
  t: Point
  motion: { kind: string }
}

interface CourseSource {
  id: string
  spawns: { t: Point }[]
  obstacles: CourseObstacle[]
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, COURSES), 'utf8'))
}

const courseNames = (await readdir(COURSES)).filter((name) => name.endsWith(COURSE_SUFFIX)).sort()

test('every course has a zones sidecar', async () => {
  assert.ok(courseNames.length > 0, 'courses directory has no course files')
  const files = new Set(await readdir(COURSES))
  for (const name of courseNames) {
    const id = name.slice(0, -COURSE_SUFFIX.length)
    assert.ok(files.has(`${id}.zones.json`), `courses/${id}.zones.json is missing`)
  }
})

for (const name of courseNames) {
  const id = name.slice(0, -COURSE_SUFFIX.length)
  test(`${id}: zones sidecar parses and covers the course`, async () => {
    const source = await readJson(name) as CourseSource
    assert.equal(source.id, id)
    const json = await readJson(`${id}.zones.json`)
    const zones: ZonesFile = parseZonesFile(json, `courses/${id}.zones.json`, {
      id: source.id,
      obstacles: source.obstacles.map(({ id: obstacleId, motion }) => ({
        id: obstacleId,
        motion: { kind: motion.kind },
      })),
    })
    assert.equal(zones.format, 'royal-fiesta.zones')
    assert.equal(zones.version, 0)
    assert.equal(zones.course, id)
    assert.equal(zones.tuning.gridCols, zones.grid.cols)

    const seesaws = source.obstacles.filter(({ motion }) => motion.kind === 'seesaw')
    if (!INHERITED.has(id)) {
      const expectedParts: Record<string, 'physics'> = {}
      for (const seesaw of seesaws) expectedParts[seesaw.id] = 'physics'
      assert.deepEqual(zones.parts, expectedParts, `${id}: parts hold exactly the seesaws`)
    }

    const grid = zones.grid
    const covered = (x: number, z: number, label: string): void => {
      assert.notEqual(cellOf(grid, x, z), CONTROL_NO_CELL, `${id}: ${label} has no cell`)
    }
    for (const spawn of source.spawns) covered(spawn.t[0], spawn.t[2], `spawn ${spawn.t[0]},${spawn.t[2]}`)
    for (const obstacle of source.obstacles) covered(obstacle.t[0], obstacle.t[2], `obstacle ${obstacle.id}`)

    if (INHERITED.has(id)) return
    const boxes = [
      {
        margin: SPAWN_MARGIN_M,
        label: 'spawn box',
        xs: source.spawns.map(({ t }) => t[0]),
        zs: source.spawns.map(({ t }) => t[2]),
      },
      {
        margin: OBSTACLE_MARGIN_M,
        label: 'obstacle box',
        xs: source.obstacles.map(({ t }) => t[0]),
        zs: source.obstacles.map(({ t }) => t[2]),
      },
    ]
    for (const box of boxes) {
      if (box.xs.length === 0) continue
      const xs = [Math.min(...box.xs) - box.margin, Math.max(...box.xs) + box.margin]
      const zs = [Math.min(...box.zs) - box.margin, Math.max(...box.zs) + box.margin]
      for (const x of xs) {
        for (const z of zs) covered(x, z, `${box.label} corner ${x},${z}`)
      }
    }
  })
}
