import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import type { EgeRecordValue, EgeScene } from '@etcito/game-engine'
import { assemblyScene, buildAssembly } from '@etcito/game-engine/formats'
import { loadBehaviour } from '@royal-fiesta/sim/bots/behaviour'
import type { BotBehaviour } from '@royal-fiesta/sim/bots/behaviour'
import { regionOf } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { GameAssetResolver } from '../src/courseV1.ts'
import { serializeBotData } from '../src/ege/botData.ts'
import type { RawEntity } from '../src/ege/featureEmitters.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}

const engine = await loadEngine()
engine.setSchema(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))

const SHORT = loadBehaviour(
  readFileSync(new URL('../../sim/src/bots/behaviours/short.bot.json', import.meta.url), 'utf8'),
  'short.bot.json',
)
const SAFE = loadBehaviour(
  readFileSync(new URL('../../sim/src/bots/behaviours/safe.bot.json', import.meta.url), 'utf8'),
  'safe.bot.json',
)

async function courseOf(id: string) {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(readJson(path), path, assets)
  assert.ok(course.sim, `${id} has a simulation part`)
  return course.sim
}

function build(entities: readonly RawEntity[]): { scene: EgeScene; text: string; index(name: string): number } {
  const built = assemblyScene(engine, buildAssembly({
    worldKind: 'show_field',
    seed: 7,
    entities: [...entities],
  }))
  assert.ok(engine.createWorld(built.text) >= 1, 'the actual engine builder creates the world')
  return built
}

function rowOf(built: { scene: EgeScene; index(name: string): number }, name: string, component: string): EgeRecordValue {
  const entity = built.scene.entities[built.index(name)]
  const row = entity?.components?.[component]
  assert.ok(row, `${name} has ${component}`)
  return row
}

function authored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'royal-fiesta.bot',
    version: 0,
    id: 'test-bot',
    name: 'Test bot',
    tick: { decisionTicks: 30, reactionTicks: 7, wobbleTicks: 45, stuckTicks: 30, ...(over.tick as object ?? {}) },
    route: { preference: 'short', advanceDist: 2.5, arriveDist: 0.5, ...(over.route as object ?? {}) },
    rules: over.rules ?? [{ id: 'jump-wall', predicate: 'obstacleAhead', action: 'jump' }],
    ...Object.fromEntries(Object.entries(over).filter(([key]) => !['tick', 'route', 'rules'].includes(key))),
  }
}

const asBehaviour = (raw: Record<string, unknown>): BotBehaviour => raw as unknown as BotBehaviour
const refusal = (e: unknown) => isRefusal(e)

test('navigation rows copy authored regions, directed adjacency and path actions', async () => {
  const course = await courseOf('mech-lab')
  const entities = serializeBotData(course, [SHORT, SAFE])
  const built = build(entities)

  assert.equal(entities.filter(e => e.components?.show_nav_region !== undefined).length, course.regions.length)
  for (let index = 0; index < course.regions.length; index++) {
    const region = course.regions[index]
    const row = rowOf(built, `show/nav/region/${index}`, 'show_nav_region')
    assert.equal(row.index, index)
    assert.equal(row.region, region.id)
    assert.deepEqual(row.center, [region.box.center.x, region.box.center.y, region.box.center.z])
    assert.deepEqual(row.half, [region.box.half.x, region.box.half.y, region.box.half.z])
    assert.equal(row.adjacent_count, region.adjacent.length)
    const owner = built.index(`show/nav/region/${index}`)
    for (let edge = 0; edge < region.adjacent.length; edge++) {
      const edgeRow = rowOf(built, `show/nav/edge/${index}/${edge}`, 'show_nav_edge')
      assert.equal(edgeRow.owner, owner)
      assert.equal(edgeRow.region_index, index)
      assert.equal(edgeRow.edge_index, edge)
      assert.equal(edgeRow.adjacent, region.adjacent[edge])
    }
  }
  for (let index = 0; index < course.path.length; index++) {
    const node = course.path[index]
    const row = rowOf(built, `show/nav/node/${index}`, 'show_nav_node')
    assert.deepEqual(row.p, [node.p.x, node.p.y, node.p.z])
    assert.equal(row.jump, node.jump ? 1 : 0)
    assert.equal(row.dive, node.dive ? 1 : 0)
    assert.equal(row.region, regionOf(course, node.p))
    const signals = course.mechanisms?.signals ?? []
    assert.equal(row.wait_signal, node.wait === undefined ? -1 : signals.indexOf(node.wait))
    assert.equal(row.pull_signal, node.pull === undefined ? -1 : signals.indexOf(node.pull))
  }
  const short = rowOf(built, 'show/bot/behaviour/0', 'bot_behaviour')
  assert.equal(short.preference, 0)
  assert.equal(short.decision_ticks, SHORT.tick.decisionTicks)
  assert.equal(short.advance_m, SHORT.route.advanceDist)
  assert.equal(short.arrive_m, SHORT.route.arriveDist)
  const safe = rowOf(built, 'show/bot/behaviour/1', 'bot_behaviour')
  assert.equal(safe.preference, 1)
  assert.equal(safe.reaction_ticks, SAFE.tick.reactionTicks)
})

test('behaviour rows carry every predicate and action form', async () => {
  const course = await courseOf('mech-lab')
  const rules = [
    { id: 'always-jump', predicate: 'always', action: 'jump' },
    { id: 'obstacle-dive', predicate: 'obstacleAhead', action: 'dive' },
    { id: 'hazard-grab', predicate: 'hazardNear', action: 'grab' },
    { id: 'stuck-lever', predicate: 'stuck', action: 'useLever' },
    { id: 'node-jump', predicate: 'nearNode', distance: 1.5, action: 'jump' },
    { id: 'finish-dive', predicate: 'nearFinish', distance: 3, phase: { from: 10, to: 20 }, action: 'dive' },
  ]
  const built = build(serializeBotData(course, [asBehaviour(authored({ rules }))]))
  const behaviour = rowOf(built, 'show/bot/behaviour/0', 'bot_behaviour')
  assert.equal(behaviour.rule_count, rules.length)
  const owner = built.index('show/bot/behaviour/0')
  const expectedPredicate = [0, 1, 2, 3, 4, 5]
  const expectedAction = [0, 1, 2, 3, 0, 1]
  for (let index = 0; index < rules.length; index++) {
    const row = rowOf(built, `show/bot/rule/0/${index}`, 'bot_rule')
    assert.equal(row.owner, owner)
    assert.equal(row.behaviour, owner)
    assert.equal(row.index, index)
    assert.equal(row.predicate, expectedPredicate[index])
    assert.equal(row.action, expectedAction[index])
  }
  const node = rowOf(built, 'show/bot/rule/0/4', 'bot_rule')
  assert.equal(node.has_distance, 1)
  assert.equal(node.distance_m, 1.5)
  assert.equal(node.has_phase, 0)
  const finish = rowOf(built, 'show/bot/rule/0/5', 'bot_rule')
  assert.equal(finish.has_distance, 1)
  assert.equal(finish.distance_m, 3)
  assert.equal(finish.has_phase, 1)
  assert.equal(finish.phase_from, 10)
  assert.equal(finish.phase_to, 20)
  for (const index of [0, 1, 2, 3]) {
    const row = rowOf(built, `show/bot/rule/0/${index}`, 'bot_rule')
    assert.equal(row.has_phase, 0)
    assert.equal(row.has_distance, 0)
    assert.equal(row.distance_m, 0)
  }
})

test('reaction endpoints are preserved and out-of-range values refuse', async () => {
  const course = await courseOf('mech-lab')
  for (const reactionTicks of [0, 120]) {
    const built = build(serializeBotData(course, [asBehaviour(authored({ tick: { reactionTicks } }))]))
    assert.equal(rowOf(built, 'show/bot/behaviour/0', 'bot_behaviour').reaction_ticks, reactionTicks)
  }
  assert.throws(
    () => serializeBotData(course, [asBehaviour(authored({ tick: { reactionTicks: 121 } }))]),
    (e: unknown) => refusal(e) && e.message.includes('reactionTicks') && e.message.includes('0..120'),
  )
})

test('malformed required authored data refuses with the field path and a repair', async () => {
  const course = await courseOf('mech-lab')
  const cases: { raw: Record<string, unknown>; part: string }[] = [
    { raw: authored({ name: '' }), part: '/name' },
    { raw: authored({ tick: { decisionTicks: 0 } }), part: '/tick/decisionTicks' },
    { raw: authored({ rules: [{ id: 'x', predicate: 'sideways', action: 'jump' }] }), part: '/rules/0/predicate' },
    { raw: authored({ rules: [{ id: 'x', predicate: 'always', action: 'teleport' }] }), part: '/rules/0/action' },
  ]
  for (const entry of cases) {
    assert.throws(
      () => serializeBotData(course, [asBehaviour(entry.raw)]),
      (e: unknown) => refusal(e) && e.message.includes(entry.part),
      entry.part,
    )
  }
  const withoutTick = authored()
  delete withoutTick.tick
  assert.throws(
    () => serializeBotData(course, [asBehaviour(withoutTick)]),
    (e: unknown) => refusal(e) && e.message.includes('/tick') && e.message.includes('missing required field'),
  )
})

test('unresolved mechanism references refuse instead of silently defaulting', async () => {
  const course = await courseOf('mech-lab')
  const waitAt = course.path.findIndex(node => node.wait !== undefined)
  const pullAt = course.path.findIndex(node => node.pull !== undefined)
  assert.ok(waitAt >= 0 && pullAt >= 0)
  const badWait = {
    ...course,
    path: course.path.map((node, index) => index === waitAt ? { ...node, wait: 'missing-signal' } : node),
  }
  assert.throws(
    () => serializeBotData(badWait, []),
    (e: unknown) => refusal(e) && e.area === 'ege-bots' && e.path.endsWith(`/path/${waitAt}/wait`) &&
      e.reason.includes("unknown signal 'missing-signal'") && e.reason.includes('use a switch'),
  )
  const badPull = {
    ...course,
    path: course.path.map((node, index) => index === pullAt ? { ...node, pull: 'missing-lever' } : node),
  }
  assert.throws(
    () => serializeBotData(badPull, []),
    (e: unknown) => refusal(e) && e.area === 'ege-bots' && e.path.endsWith(`/path/${pullAt}/pull`) &&
      e.reason.includes("unknown lever 'missing-lever'") && e.reason.includes('use a lever id'),
  )
  const noLevers = { ...course, mechanisms: null }
  assert.throws(
    () => serializeBotData(noLevers, [asBehaviour(authored({
      rules: [{ id: 'pull', predicate: 'always', action: 'useLever' }],
    }))]),
    (e: unknown) => refusal(e) && e.message.includes('useLever needs a course with levers'),
  )
})

test('a missing course route emits neutral navigation without refusing', async () => {
  const course = await courseOf('mech-lab')
  const bare = { ...course, path: [], regions: [] }
  const entities = serializeBotData(bare, [SHORT])
  assert.equal(entities.some(e => Object.keys(e.components ?? {}).some(k => k.startsWith('show_nav_'))), false)
  const built = build(entities)
  assert.equal(rowOf(built, 'show/bot/behaviour/0', 'bot_behaviour').rule_count, SHORT.rules.length)
})
