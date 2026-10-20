import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { degToRad, yawFacing } from '@royal-fiesta/sim/vec'
import { fixtureResolver } from '../src/assets.ts'
import { canonicalJson, loadCourse } from '../src/course.ts'

const FILE = 'fixtures/courses/test-race.course.json'
const CUBE = 'fixtures/assets/cube.prims.json'
const BALL = 'fixtures/assets/ball.prims.json'

type Json = Record<string, any>

function assetText(id: string, colliders: unknown[]): string {
  return JSON.stringify({
    format: 'raa.prims', version: 0, id, name: id,
    nodes: [{ id: 'body', kind: 'box', params: { size: [2, 2, 2] }, material: 'body', op: 'union', transform: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } }],
    materials: { body: { color: [1, 1, 1], roughness: 0.5, metallic: 0, emissive: [0, 0, 0] } },
    collision: { mode: 'override', colliders },
  })
}

const CUBE_TEXT = assetText('cube', [{ node: null, shape: 'cuboid', params: { halfExtents: [1, 1, 1] }, t: [0, 1, 0], r: [0, 0, 0, 1] }])
const BALL_TEXT = assetText('ball', [{ node: null, shape: 'ball', params: { radius: 0.5 }, t: [1, 0, 0], r: [0, 0, 0, 1] }])

// fixtureResolver reads fixtures/assets/<name>.prims.json; the map keeps the two assets in memory.
function resolver(overrides: Record<string, string> = {}) {
  const files = new Map<string, string>([[CUBE, CUBE_TEXT], [BALL, BALL_TEXT], ...Object.entries(overrides)])
  return fixtureResolver(async path => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  })
}

function baseCourse(): Json {
  return {
    format: 'royal-fiesta.course',
    version: 0,
    id: 'test-race',
    name: 'Test Race',
    kind: 'race',
    profiles: ['standard', 'sprint'],
    assetsManifest: null,
    timeLimitS: 120,
    killPlaneY: -12,
    spawns: Array.from({ length: 8 }, (_, i) => ({ t: [i - 3.5, 0, 0], yawDeg: i === 0 ? 90 : 0 })),
    checkpoints: [{ center: [0, 0, 50], half: [4, 4, 1], respawn: { t: [0, 0, 50], yawDeg: 0 } }],
    finish: { center: [0, 0, 100], half: [5, 5, 1] },
    path: [{ p: [0, 0, 0], jump: false, dive: false }, { p: [0, 0, 100], jump: false, dive: false }],
    regions: [
      { id: 0, center: [0, 0, 50], half: [20, 10, 60], adjacent: [1] },
      { id: 1, center: [0, 0, 150], half: [20, 10, 60], adjacent: [0] },
    ],
    queuePad: null,
    obstacles: [
      { id: 'spin-1', asset: 'cube', t: [0, 0, 20], r: [0, 0, 0, 1], s: [2, 2, 2], friction: 0, colliders: null,
        motion: { kind: 'spinner', axis: [0, 1, 0], speedDegS: 90, phaseDeg: 0 } },
      { id: 'pend-1', asset: 'ball', t: [0, 0, 40], r: [0, 0, 0, 1], s: [1, 1, 1], friction: 0.5, colliders: null,
        motion: { kind: 'pendulum', pivot: [0, 5, 40], axis: [1, 0, 0], ampDeg: 60, periodS: 3, phaseDeg: 90 } },
    ],
  }
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).reverse()) out[k] = reverseKeys((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

async function refused(promise: Promise<unknown>, pointer: string, extra?: string): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(isRefusal(e), 'expected a RefusalError')
    const needle = `${FILE}${pointer}`
    assert.ok(e.message.includes(needle), `message ${JSON.stringify(e.message)} lacks ${needle}`)
    assert.ok(e.message.includes('; '), 'message names the fix')
    if (extra !== undefined) assert.ok(e.message.includes(extra), `message ${JSON.stringify(e.message)} lacks ${extra}`)
    return true
  })
}

test('a valid race course loads with converted motion and scaled colliders', async () => {
  const course = await loadCourse(baseCourse(), FILE, resolver())
  assert.equal(course.id, 'test-race')
  assert.equal(course.kind, 'race')
  assert.deepEqual(course.profiles, ['standard', 'sprint'])
  assert.equal(course.spawns.length, 8)
  assert.deepEqual(course.spawns[0].facing, yawFacing(degToRad(90), { x: 0, z: 1 }))
  assert.deepEqual(course.finish, { center: { x: 0, y: 0, z: 100 }, half: { x: 5, y: 5, z: 1 } })
  assert.equal(course.queuePad, null)
  const spinner = course.obstacles[0].motion
  if (spinner.kind !== 'spinner') throw new Error('obstacle 0 is not a spinner')
  assert.equal(spinner.radPerTick, degToRad(90) / 60)
  const pendulum = course.obstacles[1].motion
  if (pendulum.kind !== 'pendulum') throw new Error('obstacle 1 is not a pendulum')
  assert.equal(pendulum.periodTicks, 180)
  assert.equal(pendulum.amp, degToRad(60))
  assert.equal(pendulum.phase, degToRad(90))
  assert.deepEqual(course.obstacles[0].colliders, [
    { shape: 'cuboid', half: { x: 2, y: 2, z: 2 }, t: { x: 0, y: 2, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } },
  ])
  assert.deepEqual(course.obstacles[1].colliders, [
    { shape: 'ball', radius: 0.5, t: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } },
  ])
})

test('rotatingDoor seconds become ticks and phaseS 0 gives 0 ticks', async () => {
  const json = baseCourse()
  json.obstacles[0].motion = { kind: 'rotatingDoor', axis: [0, 1, 0], stepDeg: 90, periodS: 2, moveS: 0.5, phaseS: 0 }
  const course = await loadCourse(json, FILE, resolver())
  const m = course.obstacles[0].motion
  if (m.kind !== 'rotatingDoor') throw new Error('obstacle 0 is not a rotatingDoor')
  assert.equal(m.moveTicks, 30)
  assert.equal(m.phaseTicks, 0)
  assert.equal(m.periodTicks, 120)
  assert.equal(m.stepAngle, degToRad(90))
})

test('a colliders override replaces the asset colliders', async () => {
  const json = baseCourse()
  json.obstacles[0].s = [1, 1, 1]
  json.obstacles[0].colliders = [{ shape: 'ball', radius: 0.25, t: [1, 0, 0] }]
  const course = await loadCourse(json, FILE, resolver())
  assert.deepEqual(course.obstacles[0].colliders, [
    { shape: 'ball', radius: 0.25, t: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } },
  ])
})

test('canonicalJson sorts keys and drops spaces', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}')
})

test('contentHash is stable across key order and moves with content', async () => {
  const base = baseCourse()
  const original = await loadCourse(base, FILE, resolver())
  const reordered = await loadCourse(reverseKeys(base), FILE, resolver())
  assert.equal(reordered.contentHash, original.contentHash)
  const movedNumber = baseCourse()
  movedNumber.killPlaneY = -13
  assert.notEqual((await loadCourse(movedNumber, FILE, resolver())).contentHash, original.contentHash)
  const changedAsset = await loadCourse(baseCourse(), FILE, resolver({ [CUBE]: `${CUBE_TEXT} ` }))
  assert.notEqual(changedAsset.contentHash, original.contentHash)
})

const RULES: [string, (j: Json) => void, string, string?][] = [
  ['an unknown course kind', j => { j.kind = 'gauntlet' }, '#/kind'],
  ['an unknown motion kind', j => { j.obstacles[0].motion = { kind: 'float', axis: [0, 1, 0] } }, '#/obstacles/0/motion/kind'],
  ['periodS 0.001', j => { j.obstacles[1].motion.periodS = 0.001 }, '#/obstacles/1/motion/periodS'],
  ['a non-unit axis', j => { j.obstacles[0].motion.axis = [0, 2, 0] }, '#/obstacles/0/motion/axis'],
  ['a non-unit quaternion', j => { j.obstacles[0].r = [0, 0, 0, 0.9] }, '#/obstacles/0/r'],
  ['7 spawns for a race', j => { j.spawns = j.spawns.slice(0, 7) }, '#/spawns'],
  ['a race with finish null', j => { j.finish = null }, '#/finish'],
  ['a non-null finish on survival', j => { j.kind = 'survival' }, '#/finish'],
  ['duplicate obstacle ids', j => { j.obstacles[1].id = 'spin-1' }, '#/obstacles/1/id'],
  ['97 obstacles', j => {
    j.obstacles = Array.from({ length: 97 }, (_, i) => ({ id: `o${i}`, asset: 'cube', t: [0, 0, i], r: [0, 0, 0, 1], s: [1, 1, 1], friction: 0, colliders: null, motion: { kind: 'static' } }))
  }, '#/obstacles'],
  ['a trimesh colliders override', j => { j.obstacles[0].colliders = [{ shape: 'trimesh' }] }, '#/obstacles/0/colliders/0', 'primitive colliders only'],
  ['a non-uniform s with a ball collider', j => { j.obstacles[0].asset = 'ball'; j.obstacles[0].s = [2, 1, 1] }, '#/obstacles/0/s'],
  ['an unknown asset name', j => { j.obstacles[0].asset = 'ghost' }, '#/obstacles/0/asset'],
  ['an id that is not the file stem', j => { j.id = 'other-race' }, '#/id'],
  ['a NaN-like string in a number', j => { j.killPlaneY = 'NaN' }, '#/killPlaneY'],
  ['an unknown top-level key', j => { j.extra = 1 }, '#/extra'],
]

for (const [name, patch, pointer, extra] of RULES) {
  test(`refuses ${name}`, async () => {
    const json = baseCourse()
    patch(json)
    await refused(loadCourse(json, FILE, resolver()), pointer, extra)
  })
}

const REPO_ROOT = new URL('../../../', import.meta.url)

async function readRepoFile(repoRelPath: string): Promise<string> {
  return readFile(new URL(repoRelPath, REPO_ROOT), 'utf8')
}

const INVALID: [string, string][] = [
  ['trimesh-collider.course.json', '#/obstacles/0/colliders/0/shape'],
  ['bad-motion.course.json', '#/obstacles/1/motion/periodS'],
  ['unknown-asset.course.json', '#/obstacles/0/asset'],
  ['race-without-finish.course.json', '#/finish'],
]

test('the invalid course fixtures each refuse with a file#pointer', async () => {
  for (const [file, pointer] of INVALID) {
    const rel = `fixtures/courses/invalid/${file}`
    const json: unknown = JSON.parse(await readRepoFile(rel))
    await assert.rejects(loadCourse(json, rel, fixtureResolver(readRepoFile)), (e: unknown) => {
      assert.ok(isRefusal(e), `${rel} threw a non-refusal: ${String(e)}`)
      const needle = `${rel}${pointer}`
      assert.ok(e.message.includes(needle), `message ${JSON.stringify(e.message)} lacks ${needle}`)
      return true
    })
  }
})
