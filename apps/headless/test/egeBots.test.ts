import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const probePath = 'probe/bots_routes.as.ts'
const probeSource = `import { setComponent, tick } from 'ege'
import { RouteProbe, BehaviourProbe } from '../components.gen'
import { planShowRoute } from '../bots/routes.as'
import { applyShowBehaviour } from '../bots/behaviour.as'
export function rf_bots_probe(): void {
  const row = new RouteProbe()
  row.value = planShowRoute(35, <i32>tick())
  setComponent<RouteProbe>(35, RouteProbe.ID, RouteProbe.SIZE, row)
  const behaviour = new BehaviourProbe()
  behaviour.first = applyShowBehaviour(35, 5, 0x0000ff80)
  behaviour.code = behaviour.first
  for (let i = 0; i < 4; i++) behaviour.code = applyShowBehaviour(35, 5 + i, 0x0000ff80)
  behaviour.idle = applyShowBehaviour(35, 5, 0)
  setComponent<BehaviourProbe>(35, BehaviourProbe.ID, BehaviourProbe.SIZE, behaviour)
}
`

function schemaText(): string {
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))
  schema.components.push({ name: 'route_probe', fields: [{ name: 'value', type: 'i32' }] })
  schema.components.push({ name: 'behaviour_probe', fields: [{ name: 'code', type: 'u32' }, { name: 'first', type: 'u32' }, { name: 'idle', type: 'u32' }] })
  schema.world_kinds.push({ name: 'bots_route_probe', players: 0, schedule: [{
    system: 'rf.bots.probe', kind: 'script',
    reads: ['bot_seat', 'bot_memory', 'bot_behaviour', 'bot_rule', 'bot_route', 'bot_route_waypoint', 'show_nav_region', 'show_nav_edge', 'show_nav_node', 'ege.transform', 'ege.mover'],
    writes: ['bot_memory', 'bot_route', 'bot_route_region', 'bot_route_edge', 'bot_route_waypoint', 'route_probe', 'behaviour_probe'], emits: [],
  }] })
  return JSON.stringify(schema)
}

const NO_ENTITY = 0xffffffff
const probeWasm = (async () => {
  const files = [...collectRfScripts(), { name: probePath, text: probeSource }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
  const result = await (await rfCompiler()).compile(files, schemaText())
  const errors = result.diagnostics.filter(d => d.severity === 'error')
  assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
  assert.ok(result.wasm)
  return result.wasm
})()

function region(id: number, x: number, z: number, index: number, adjacent: number[]) {
  return { show_nav_region: { owner: NO_ENTITY, index, region: id, center: [x, 0, z], half: [0.4, 1, 0.4], adjacent_count: adjacent.length } }
}

function scene(options: { disconnected?: boolean; noPath?: boolean; short?: boolean; seed?: number; predicate?: number; action?: number; secondAction?: number; from?: number; to?: number; stuck?: number; mover?: boolean } = {}) {
  const regions = [region(10, 0, 0, 0, options.disconnected ? [] : [20, 30]), region(20, 1, 0, 1, [40]), region(30, 1, 0, 2, [40]), region(40, 2, 0, 3, [])]
  const entities: any[] = Array.from({ length: 35 }, () => ({ components: {} }))
  entities.push({ components: {
    bot_seat: { owner: 35, character: 35, behaviour: 36 },
    bot_memory: { owner: 35, rng_state: options.seed ?? 7, ticks: 0, wait_ticks: 0, path_index: 0, stuck_ticks: options.stuck ?? 0, last_x: 0, last_z: 0, wobble: 0 },
    route_probe: { value: -99 },
    behaviour_probe: { code: 0, first: 0, idle: 0 },
    'ege.transform': { pos: [0, 0, 0], rot: [0, 0, 0, 1] },
  } })
  entities.push({ components: { bot_behaviour: { owner: NO_ENTITY, index: 0, decision_ticks: 10, reaction_ticks: 0, wobble_ticks: 0, stuck_ticks: 5, preference: options.short ? 0 : 1, advance_m: 0.5, arrive_m: 0.2, rule_count: options.action === undefined ? 0 : options.secondAction === undefined ? 1 : 2 } } })
  if (options.action !== undefined) {
    entities.push({ components: { bot_rule: { owner: 36, behaviour: 36, index: 0, predicate: options.predicate ?? 0, action: options.action, has_phase: options.from === undefined ? 0 : 1, phase_from: options.from ?? 0, phase_to: options.to ?? 0, has_distance: options.predicate === 4 || options.predicate === 5 ? 1 : 0, distance_m: 5 } } })
    if (options.secondAction !== undefined) entities.push({ components: { bot_rule: { owner: 36, behaviour: 36, index: 1, predicate: 0, action: options.secondAction, has_phase: 0, phase_from: 0, phase_to: 0, has_distance: 0, distance_m: 0 } } })
  }
  if (options.mover) entities.push({ components: { 'ege.mover': {}, 'ege.transform': { pos: [0, 0, 1], rot: [0, 0, 0, 1] } } })
  if (!options.noPath) {
    for (const [index, id, x, z] of [[0, 10, 0, 0], [1, 20, 1, 0], [2, 30, 1, 0], [3, 40, 2, 0]] as number[][]) {
      entities.push({ components: { show_nav_node: { owner: NO_ENTITY, index, p: [x, 0, z], jump: 0, dive: 0, region: id, wait_signal: -1, pull_signal: -1 } } })
    }
  }
  if (!options.noPath) {
    for (const r of regions) entities.push({ components: r })
    const links = options.disconnected ? [] : [[0, 0, 20], [0, 1, 30], [1, 0, 40], [2, 0, 40]]
    for (const [region_index, edge_index, adjacent] of links) entities.push({ components: { show_nav_edge: { owner: 0, region_index, edge_index, adjacent } } })
  }
  return { format: 'ege.scene' as const, version: 1 as const, world_kind: 'bots_route_probe', seed: 7, entities }
}

async function run(options: { disconnected?: boolean; noPath?: boolean; short?: boolean; seed?: number; predicate?: number; action?: number; secondAction?: number; from?: number; to?: number; stuck?: number; mover?: boolean } = {}) {
  const engine = await loadEngine()
  engine.setSchema(schemaText())
  const module = await loadScript(engine, await probeWasm, { name: 'bots-route-probe' })
  const world = engine.createWorld(scene(options))
  new ScriptHost(module).stepTick(world, [])
  assert.equal(module.faultCount, 0, JSON.stringify(module.faults[0]))
  const state = readWorldState(engine, world, schemaLayout(engine))
  return state.components
}

test('compiled route helper retains hand-derived shortest path and integer costs', async () => {
  const components = await run()
  const seat = '35'
  assert.equal(components.route_probe[seat].value, 0)
  assert.equal(components.bot_memory[seat].path_index, 0)
  const route: any = Object.values(components.bot_route).find((row: any) => row.owner === 35)
  assert.ok(route, JSON.stringify(components.bot_route))
  assert.equal(route.cost, 2002)
  assert.equal(route.reachable, 1, JSON.stringify(components.bot_route_region))
  const regions = Object.values(components.bot_route_region).filter((row: any) => row.owner === 35).map((row: any) => row.region)
  assert.deepEqual(regions, [10, 20, 40])
  const waypoints = Object.values(components.bot_route_waypoint).filter((row: any) => row.owner === 35).map((row: any) => row.node)
  assert.deepEqual(waypoints, [0, 1, 3])
  const short = await run({ short: true })
  const shortRoute: any = Object.values(short.bot_route).find((row: any) => row.owner === 35)
  assert.equal(shortRoute.cost, 128128)
})

test('compiled route helper uses tieKey for equal paths and falls back when disconnected', async () => {
  const tied = await run({ seed: 0 })
  const regions = Object.values(tied.bot_route_region).filter((row: any) => row.owner === 35).map((row: any) => row.region)
  assert.deepEqual(regions, [10, 30, 40])
  const disconnected = await run({ disconnected: true })
  const disconnectedRoute: any = Object.values(disconnected.bot_route).find((row: any) => row.owner === 35)
  assert.ok(disconnectedRoute)
  assert.equal(disconnectedRoute.reachable, 0)
  assert.equal(disconnectedRoute.cost, 0)
  assert.equal(disconnected.bot_memory['35'].path_index, 0)
  const fallbackNodes = Object.values(disconnected.bot_route_waypoint).filter((row: any) => row.owner === 35).map((row: any) => row.node)
  assert.deepEqual(fallbackNodes, [0, 1, 2, 3])
})

test('compiled route helper returns no route when authored path is absent', async () => {
  const components = await run({ noPath: true })
  assert.equal(components.route_probe['35'].value, -1)
  assert.equal(components.bot_route?.['35'], undefined)
  assert.equal(components.bot_memory['35'].path_index, 0)
})

test('compiled behavior helper evaluates predicates in authored order and returns engine codes', async () => {
  const cases = [
    [0, { predicate: 0 }, 0x1ff80],
    [1, { predicate: 1, mover: true }, 0x2ff80],
    [2, { predicate: 2, mover: true }, 0x4ff80],
    [0, { predicate: 3, stuck: 5 }, 0x1ff80],
    [1, { predicate: 4 }, 0x2ff80],
    [2, { predicate: 5 }, 0x4ff80],
  ] as const
  for (const [action, options, expected] of cases) {
    const components = await run({ ...options, action })
    assert.equal(components.behaviour_probe['35'].code, expected, `predicate/action ${options.predicate}/${action}: ${JSON.stringify({ route: components.bot_route, waypoints: components.bot_route_waypoint, rules: components.bot_rule, behaviours: components.bot_behaviour })}`)
  }
  const lever = await run({ action: 3 })
  assert.equal(lever.behaviour_probe['35'].first, 0x4ff80)
  assert.equal(lever.behaviour_probe['35'].code, 0x0ff80)
})

test('compiled behavior helper honors inclusive phase bounds, rule order and missing routes', async () => {
  assert.equal((await run({ action: 0, from: 0, to: 0 })).behaviour_probe['35'].code, 0x1ff80)
  assert.equal((await run({ action: 0, from: 1, to: 2 })).behaviour_probe['35'].code, 0x0ff80)
  assert.equal((await run({ action: 0, predicate: 3, stuck: 4 })).behaviour_probe['35'].code, 0x0ff80)
  assert.equal((await run({ action: 0, secondAction: 1 })).behaviour_probe['35'].code, 0x1ff80)
  assert.equal((await run({ noPath: true, action: 0 })).behaviour_probe['35'].code, 0)
  assert.equal((await run()).behaviour_probe['35'].idle, 0)
})
