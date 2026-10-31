import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { LevelSpec, ObstacleSpec } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import type { RefusalError } from '@royal-fiesta/sim/refusal'
import { degToRad, yawFacing } from '@royal-fiesta/sim/vec'
import { canonicalJson } from '../src/course.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import { applyGroups, parseFeatureList, parseLevelBlock } from '../src/levelBlock.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = (rel: string): Record<string, any> => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8'))
const PATH = 'courses/level-block.course.json'
const INVALID = 'fixtures/courses-v1/invalid/'

type Json = Record<string, any>
type CourseArg = { kind: string; checkpoints: unknown[]; obstacles: { id: string }[]; finish: unknown | null }

async function gameAsset(id: string, collision: unknown[]): Promise<ResolvedGameAsset> {
  const document = { nodes: [{ kind: 'box', size: [1, 1, 1] }], note: id }
  const json = {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id, name: id, category: 'obstacle', world: 'candy',
    mesher: { output: 'lowpoly' }, document, collision, anchors: {},
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    hash: createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex'),
  }
  const source = { path: assetFilePath('candy', id), json }
  return { asset: await parseGameAsset(json, source.path), source }
}

const floorTile = gameAsset('candy.floor-tile', [{ shape: 'cuboid', half: [1, 0.1, 1] }])
const assets: GameAssetResolver = {
  async resolve(id: string): Promise<ResolvedGameAsset> {
    const resolved = await floorTile
    if (resolved.asset.id !== id) throw new Error(`unexpected asset '${id}'`)
    return resolved
  },
}

function levelJson(over: Json = {}): Json {
  return {
    season: null,
    map: null,
    kind: 'race',
    finalRule: null,
    stages: ['R1', 'R2'],
    capacity: 60,
    usual: [60, 40],
    quota: null,
    timeCapS: 60,
    overtimeS: 0,
    respawn: { mode: 'checkpoint', waitS: 0, protectS: 0, slots: 12, spacingM: 1.2 },
    route: { ordered: true, laps: 1, stages: [0, 1, 2] },
    teams: null,
    homes: [],
    groups: [],
    grab: { players: true, objects: true },
    ...over,
  }
}

const COURSE: CourseArg = {
  kind: 'race',
  checkpoints: [{}, {}, {}],
  obstacles: [{ id: 'floor-start' }, { id: 'floor-mid' }],
  finish: { center: [0, 1, 50], half: [4, 2, 1] },
}

function refusalFrom(fn: () => unknown): RefusalError {
  try {
    fn()
  } catch (error) {
    assert.ok(isRefusal(error), `expected a RefusalError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a refusal')
}

function refusedLevel(level: unknown, pointer: string, course: CourseArg = COURSE): void {
  const error = refusalFrom(() => parseLevelBlock(level, PATH, course))
  assert.ok(error.message.startsWith(`[course] ${PATH}#/level${pointer}: `), error.message)
  assert.ok(error.message.includes('; '), `message ${JSON.stringify(error.message)} has no fix after '; '`)
}

function refusedFeatures(features: unknown, pointer: string): void {
  const error = refusalFrom(() => parseFeatureList(features, PATH))
  assert.ok(error.message.startsWith(`[course] ${PATH}#/features${pointer}: `), error.message)
  assert.ok(error.message.includes('; '), `message ${JSON.stringify(error.message)} has no fix after '; '`)
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<RefusalError> {
  try {
    await fn()
  } catch (error) {
    assert.ok(isRefusal(error), `expected a RefusalError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a refusal')
}

function courseOf(json: Json): CourseArg {
  return { kind: json.kind, checkpoints: json.checkpoints, obstacles: json.obstacles, finish: json.finish }
}

async function fixtureRefusal(name: string, pointer: string): Promise<void> {
  const where = INVALID + name
  const json = readJson(where)
  const first = await rejectionOf(() => loadCourseV1(json, where, assets))
  const error = first.path === `${where}#/level` && first.reason.startsWith("unknown key 'level'")
    ? refusalFrom(() => parseLevelBlock(json.level, where, courseOf(json)))
    : first
  assert.ok(error.message.startsWith(`[course] ${where}${pointer}: `), error.message)
  assert.ok(error.message.includes('; '), `message ${JSON.stringify(error.message)} has no fix after '; '`)
}

test('a full valid race block parses to the expected LevelSpec ticks and defaults', () => {
  const course: CourseArg = {
    kind: 'race',
    checkpoints: [{}, {}, {}, {}],
    obstacles: [{ id: 'floor-start' }, { id: 'gate-a' }],
    finish: { center: [0, 1, 50], half: [4, 2, 1] },
  }
  const json = levelJson({
    season: 's1',
    map: 'E',
    overtimeS: 2,
    respawn: { waitS: 3, protectS: 1, slots: 12, spacingM: 1.2 },
    route: { ordered: true, laps: 2, stages: [0, 1, 1, 2] },
    groups: [
      { id: 'floor-main', role: 'floor', friction: 0.6, surface: 'normal', members: ['floor-start'] },
      { id: 'gate-main', role: 'wall', friction: null, surface: null, members: ['gate-a'] },
    ],
  })
  delete json.grab
  const level = parseLevelBlock(json, PATH, course)
  const expected: LevelSpec = {
    season: 's1', map: 'E', kind: 'race', finalRule: null,
    stages: ['R1', 'R2'], capacity: 60, usual: [60, 40], quota: null,
    timeCapTicks: 3600, overtimeTicks: 120,
    respawn: { mode: 'checkpoint', waitTicks: 180, protectTicks: 60, slots: 12, spacingM: 1.2 },
    route: { ordered: true, laps: 2, stages: [0, 1, 1, 2] },
    teams: null, homes: [],
    groups: [
      { id: 'floor-main', role: 'floor', friction: 0.6, surface: 'normal', members: ['floor-start'] },
      { id: 'gate-main', role: 'wall', friction: null, surface: null, members: ['gate-a'] },
    ],
    grab: { players: true, objects: true },
  }
  assert.deepEqual(level, expected)
})

const spawn = (t: [number, number, number], yawDeg: number) => ({
  t: { x: t[0], y: t[1], z: t[2] },
  facing: yawFacing(degToRad(yawDeg), { x: 0, z: 1 }),
})

test('a team block with homes and mode home', () => {
  const course: CourseArg = {
    kind: 'team',
    checkpoints: [{}, {}, {}],
    obstacles: [{ id: 'floor-start' }],
    finish: null,
  }
  const json = levelJson({
    kind: 'team',
    timeCapS: 120,
    overtimeS: 20,
    respawn: { mode: 'home', waitS: 0.5, protectS: 1, slots: 8, spacingM: 2 },
    route: { ordered: false, laps: 1, stages: [0, 1, 1] },
    teams: { count: 2, maxPerTeam: 12 },
    homes: [
      { team: 0, center: [0, 0, 0], half: [4, 2, 3], respawn: [{ t: [0, 1, 0], yawDeg: 0 }, { t: [1, 1, 0], yawDeg: 90 }] },
      { team: 1, center: [20, 0, 0], half: [4, 2, 3], respawn: [{ t: [20, 1, 0], yawDeg: 180 }] },
    ],
  })
  delete json.grab
  const level = parseLevelBlock(json, PATH, course)
  assert.deepEqual(level, {
    season: null, map: null, kind: 'team', finalRule: null,
    stages: ['R1', 'R2'], capacity: 60, usual: [60, 40], quota: null,
    timeCapTicks: 7200, overtimeTicks: 1200,
    respawn: { mode: 'home', waitTicks: 30, protectTicks: 60, slots: 8, spacingM: 2 },
    route: { ordered: false, laps: 1, stages: [0, 1, 1] },
    teams: { count: 2, maxPerTeam: 12 },
    homes: [
      { team: 0, box: { center: { x: 0, y: 0, z: 0 }, half: { x: 4, y: 2, z: 3 } }, respawn: [spawn([0, 1, 0], 0), spawn([1, 1, 0], 90)] },
      { team: 1, box: { center: { x: 20, y: 0, z: 0 }, half: { x: 4, y: 2, z: 3 } }, respawn: [spawn([20, 1, 0], 180)] },
    ],
    groups: [],
    grab: { players: true, objects: true },
  })
})

test('a survival block with mode none defaults grab.players to false', () => {
  const course: CourseArg = {
    kind: 'survival',
    checkpoints: [{}, {}],
    obstacles: [{ id: 'pad-a' }],
    finish: null,
  }
  const json = levelJson({
    kind: 'survival',
    quota: { count: 5 },
    timeCapS: 150,
    overtimeS: 30,
    respawn: { mode: 'none', waitS: 0, protectS: 0, slots: 1, spacingM: 1 },
    route: { ordered: false, laps: 1, stages: [0, 1] },
  })
  delete json.grab
  const level = parseLevelBlock(json, PATH, course)
  assert.equal(level.respawn.mode, 'none')
  assert.deepEqual(level.grab, { players: false, objects: true })
  assert.equal(level.timeCapTicks, 9000)
  assert.equal(level.overtimeTicks, 1800)
  assert.equal(level.quota, 5)
})

test('applyGroups sets friction and surface on the members only', () => {
  const level = parseLevelBlock(levelJson({
    groups: [
      { id: 'g-floor', role: 'floor', friction: 0.9, surface: 'ice', members: ['floor-start'] },
      { id: 'g-wall', role: 'wall', friction: null, surface: 'rubber', members: ['floor-mid'] },
    ],
  }), PATH, COURSE)
  const obstacles = [
    { id: 'floor-start', friction: 0.2, surface: 'normal' },
    { id: 'floor-mid', friction: 0.3, surface: 'mud' },
    { id: 'floor-end', friction: 0.4 },
  ] as unknown as ObstacleSpec[]
  applyGroups(level, obstacles)
  assert.equal(obstacles[0].friction, 0.9)
  assert.equal(obstacles[0].surface, 'ice')
  assert.equal(obstacles[1].friction, 0.3, 'a null friction keeps the member value')
  assert.equal(obstacles[1].surface, 'rubber')
  assert.equal(obstacles[2].friction, 0.4, 'a non-member keeps its value')
  assert.equal(obstacles[2].surface, undefined)
})

test('parseFeatureList accepts a marker and refuses a duplicate id, an unknown kind and 33 entries', () => {
  assert.deepEqual(parseFeatureList([{ id: 'm-1', kind: 'marker', t: [0, 1, 0], radiusM: 2 }], PATH), [
    { id: 'm-1', kind: 'marker', params: { t: [0, 1, 0], radiusM: 2 } },
  ])
  refusedFeatures([{ id: 'm-1', kind: 'marker', t: [0, 1, 0] }, { id: 'm-1', kind: 'marker', t: [0, 1, 0] }], '/1/id')
  refusedFeatures([{ id: 'm-1', kind: 'glue' }], '/0/kind')
  refusedFeatures(Array.from({ length: 33 }, (_, i) => ({ id: `m-${i}`, kind: 'marker', t: [0, 1, 0] })), '')
})

test('one S13 refusal per rule, each with the file#pointer prefix and a fix', () => {
  const unknownKey = levelJson()
  unknownKey.extra = 1
  refusedLevel(unknownKey, '/extra')

  refusedLevel(levelJson({ kind: 'sprint' }), '/kind')

  const decreasing = structuredClone(levelJson())
  decreasing.route.stages = [0, 2, 1]
  refusedLevel(decreasing, '/route/stages/2')

  refusedLevel(levelJson({ route: { ordered: true, laps: 1, stages: [0, 1] } }), '/route/stages')

  refusedLevel(levelJson({ route: { ordered: true, laps: 2, stages: [0, 1, 2] } }), '/route/laps', { ...COURSE, finish: null })

  refusedLevel(levelJson({ respawn: { mode: 'none', waitS: 0, protectS: 0, slots: 12, spacingM: 1 } }), '/respawn/mode')

  refusedLevel(levelJson({ respawn: { mode: 'home', waitS: 0, protectS: 0, slots: 12, spacingM: 1 } }), '/homes')

  refusedLevel(levelJson({ groups: [{ id: 'g', role: 'ceiling', friction: null, surface: null, members: [] }] }), '/groups/0/role')

  refusedLevel(levelJson({ groups: [
    { id: 'g0', role: 'floor', friction: null, surface: null, members: ['floor-start'] },
    { id: 'g1', role: 'wall', friction: null, surface: null, members: ['floor-start'] },
  ] }), '/groups/1/members/0')

  refusedLevel(levelJson({ groups: [{ id: 'g', role: 'floor', friction: null, surface: null, members: ['ghost'] }] }), '/groups/0/members/0')

  refusedLevel(levelJson({ groups: [{ id: 'g', role: 'floor', friction: 2.5, surface: null, members: [] }] }), '/groups/0/friction')

  refusedLevel(levelJson({ respawn: { mode: 'checkpoint', waitS: 0, protectS: 0, slots: 13, spacingM: 1 } }), '/respawn/slots')

  refusedLevel(levelJson({ teams: { count: 2, maxPerTeam: 31 } }), '/teams/maxPerTeam')
})

test('invalid level fixtures refuse through the loader (or the parser before the loader is wired)', async () => {
  await fixtureRefusal('bad-level-route.course.json', '#/level/route/stages/2')
  await fixtureRefusal('bad-level-group.course.json', '#/level/groups/1/members/0')
})
