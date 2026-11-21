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

// ---------------------------------------------------------------------------------------------
// G7.3 physics-aware traversal: showTraversalControl reads the route target and engine queries.
// Fixtures below are explicit geometry with hand-derived distances; nothing evaluates geometry
// in host TypeScript beyond placing bodies and reading the returned control.
// ---------------------------------------------------------------------------------------------

const TRAV_NO_ENTITY = 0xffffffff
const TRAV_JUMP = 0x10000
const TRAV_DIVE = 0x20000
const TRAV_GRAB = 0x40000
const traversalProbePath = 'probe/bots_traversal.as.ts'
const traversalProbeSource = `import { getComponent, setComponent, tick } from 'ege'
import { TraversalProbe } from '../components.gen'
import { showTraversalControl } from '../bots/traversal.as'
export function rf_bots_traversal_probe(): void {
  const input = getComponent<TraversalProbe>(34, TraversalProbe.ID, TraversalProbe.SIZE)
  const out = new TraversalProbe()
  out.path_node = input.path_node
  out.code = showTraversalControl(35, <i32>tick(), input.path_node)
  out.neutral = showTraversalControl(35, <i32>tick(), -1)
  setComponent<TraversalProbe>(34, TraversalProbe.ID, TraversalProbe.SIZE, out)
}
`

function traversalSchemaText(): string {
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))
  schema.components.push({ name: 'traversal_probe', fields: [
    { name: 'path_node', type: 'i32' }, { name: 'code', type: 'u32' }, { name: 'neutral', type: 'u32' },
  ] })
  schema.world_kinds.push({ name: 'bots_traversal_probe', players: 0, schedule: [
    {
      system: 'rf.bots.traversal_probe', kind: 'script',
      reads: ['traversal_probe', 'bot_seat', 'bot_memory', 'bot_behaviour', 'bot_route', 'bot_route_waypoint',
        'show_nav_node', 'character', 'ege.transform', 'ege.mover', 'ege.mech.signal', 'ege.mech.lever',
        'feature', 'feature_hex_field', 'feature_hex_field_hex'],
      writes: ['traversal_probe', 'bot_memory'], emits: [],
    },
    { system: 'ege.physics', kind: 'engine' },
  ] })
  return JSON.stringify(schema)
}

let traversalWasmPromise: Promise<Uint8Array> | null = null
function traversalWasm(): Promise<Uint8Array> {
  traversalWasmPromise ??= (async () => {
    const files = [...collectRfScripts(), { name: traversalProbePath, text: traversalProbeSource }]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    const result = await (await rfCompiler()).compile(files, traversalSchemaText())
    const errors = result.diagnostics.filter(d => d.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm
  })()
  return traversalWasmPromise
}

function floorSlab(x: number, top: number, z: number, hx: number, hz: number) {
  return {
    body: { type: 'fixed' as const },
    colliders: [{ shape: 'box' as const, half_extents: [hx, 0.5, hz], group: 'static' }],
    components: { 'ege.transform': { pos: [x, top - 0.5, z], rot: [0, 0, 0, 1] } },
  }
}

function moverEntity(kind: number, pos: [number, number, number], axis: [number, number, number], half: [number, number, number]) {
  const kinematic = kind === 1 || kind === 2 || kind === 3 || kind === 4 || kind === 7
  return {
    body: { type: kinematic ? 'kinematic_position' as const : 'fixed' as const },
    colliders: [{ shape: 'box' as const, half_extents: half, group: 'moving' }],
    components: {
      'ege.transform': { pos, rot: [0, 0, 0, 1] },
      'ege.mover': {
        kind, axis, vec: [0, 0, 0], a: 0, b: 0, c: 0, d: 0, wave: 0,
        rest_pos: pos, rest_rot: [0, 0, 0, 1], start_tick: 0,
      },
    },
  }
}

interface TraversalOptions {
  pathNode?: number
  character?: [number, number, number]
  nodes?: { index: number; p: [number, number, number]; jump?: number; wait?: number; pull?: number }[]
  waypoints?: number[]
  advance?: number
  arrive?: number
  memory?: { wait_ticks?: number; path_index?: number }
  geometry?: unknown[]
  movers?: { kind: number; pos: [number, number, number]; axis?: [number, number, number]; half?: [number, number, number] }[]
  signals?: { value: number; handle?: [number, number, number]; grab?: number }[]
  hexes?: { x: number; z: number; state: number; flat?: number }[]
  noRoute?: boolean
}

function traversalScene(options: TraversalOptions) {
  const character = options.character ?? [0, 0.85, 0]
  const entities: any[] = []
  for (let i = 0; i < 34; i++) entities.push({ components: {} })
  entities.push({ components: { traversal_probe: { path_node: options.pathNode ?? 0, code: 0, neutral: 0 } } })
  entities.push({
    body: { type: 'dynamic', gravity_scale: 0, can_sleep: false, ccd: false },
    colliders: [{ shape: 'capsule', radius: 0.4, half_height: 0.45, density: 0, friction: 0, restitution: 0, group: 'char' }],
    components: {
      bot_seat: { owner: 35, character: 35, behaviour: 36 },
      bot_memory: {
        owner: 35, rng_state: 7, ticks: 0, wait_ticks: options.memory?.wait_ticks ?? 0,
        path_index: options.memory?.path_index ?? Math.max(0, options.pathNode ?? 0), stuck_ticks: 0, last_x: 0, last_z: 0, wobble: 0,
      },
      'ege.transform': { pos: character, rot: [0, 0, 0, 1] },
      character: {
        mode: 1, placed: 1, protected_until: -1, facing: [0, 1], radius: 0.4, half_height: 0.45, stand: 0.85,
        grounded: 1, ground_entity: TRAV_NO_ENTITY, grab_target: -1, grab_lever: -1, prev_buttons: 0,
      },
    },
  })
  entities.push({ components: { bot_behaviour: {
    owner: TRAV_NO_ENTITY, index: 0, decision_ticks: 10, reaction_ticks: 0, wobble_ticks: 45, stuck_ticks: 30,
    preference: 1, advance_m: options.advance ?? 0.5, arrive_m: options.arrive ?? 0.5, rule_count: 0,
  } } })
  if (!options.noRoute) {
    entities.push({ components: { bot_route: {
      owner: 35, preference: 1, seed: 7, plan_tick: 0, next_plan_tick: 10, cost: 0, reachable: 1,
      region_count: 0, edge_count: 0, waypoint_count: options.waypoints?.length ?? 0,
    } } })
  }
  for (const node of options.nodes ?? []) {
    entities.push({ components: { show_nav_node: {
      owner: TRAV_NO_ENTITY, index: node.index, p: node.p, jump: node.jump ?? 0, dive: 0,
      region: 0, wait_signal: node.wait ?? -1, pull_signal: node.pull ?? -1,
    } } })
  }
  for (let i = 0; i < (options.waypoints ?? []).length; i++) {
    entities.push({ components: { bot_route_waypoint: { owner: 35, index: i, node: options.waypoints![i] } } })
  }
  for (const entity of options.geometry ?? []) entities.push(entity)
  for (const mover of options.movers ?? []) {
    entities.push(moverEntity(mover.kind, mover.pos, mover.axis ?? [0, 1, 0], mover.half ?? [1, 1, 1]))
  }
  for (const signal of options.signals ?? []) {
    let handle = -1
    if (signal.handle !== undefined) {
      handle = entities.length
      entities.push({ components: { 'ege.transform': { pos: signal.handle, rot: [0, 0, 0, 1] } } })
    }
    entities.push({ components: {
      'ege.mech.signal': { value: signal.value, prev: signal.value },
      ...(handle < 0 ? {} : { 'ege.mech.lever': { handle, joint: 0, on: 1, off: 0, grab_range: signal.grab ?? 1.5 } }),
    } })
  }
  if ((options.hexes ?? []).length > 0) {
    const flat = options.hexes![0].flat ?? 2
    entities.push({ components: {
      feature: { kind: 9, index: 0, salt: 0 },
      feature_hex_field: {
        origin: [0, 0, 0], layers: 1, layer_spacing_m: 1, rings: 1, flat_m: flat, point_m: flat,
        thick_m: 0.3, warn_s: 0, decay_s: 0, scale_with_entrants: 0, placed: 1,
      },
      'ege.transform': { pos: [0, 0, 0], rot: [0, 0, 0, 1] },
    } })
    const hexList = options.hexes ?? []
    for (let index = 0; index < hexList.length; index++) {
      const hex = hexList[index]
      entities.push({ components: {
        'ege.transform': { pos: [hex.x, 0, hex.z], rot: [0, 0, 0, 1] },
        feature_hex_field_hex: { owner: 0, index, t: [hex.x, 0, hex.z], state: hex.state, timer: 0 },
      } })
    }
  }
  return { format: 'ege.scene' as const, version: 1 as const, world_kind: 'bots_traversal_probe', seed: 7, entities }
}

async function runTraversal(options: TraversalOptions) {
  const engine = await loadEngine()
  engine.setSchema(traversalSchemaText())
  const module = await loadScript(engine, await traversalWasm(), { name: 'bots-traversal-probe' })
  const world = engine.createWorld(traversalScene(options))
  new ScriptHost(module).stepTick(world, [])
  const state = readWorldState(engine, world, schemaLayout(engine))
  return { components: state.components, faults: module.faultCount, firstFault: module.faults[0] }
}

function traversalControl(components: Record<string, any>): number {
  return components.traversal_probe['34'].code
}

function signedAxis(code: number, shift: number): number {
  let byte = (code >> shift) & 0xff
  if (byte > 127) byte -= 256
  return byte
}

test('traversal helper jumps a supported gap and does not jump a blocked one', async () => {
  const nodes = [{ index: 0, p: [0, 0, 0] as [number, number, number] }, { index: 1, p: [0, 0, 12] as [number, number, number] }]
  const geometry = [floorSlab(0, 0, 2.5, 10, 2.5), floorSlab(0, 0, 9.5, 10, 2.5)]
  const supported = await runTraversal({ pathNode: 1, character: [0, 0.85, 3.5], nodes, waypoints: [0, 1], geometry })
  assert.equal(supported.faults, 0, JSON.stringify(supported.firstFault))
  const supportedCode = traversalControl(supported.components)
  assert.notEqual(supportedCode & TRAV_JUMP, 0, `2 m gap at 1.5 m: ${supportedCode.toString(16)}`)
  assert.ok(signedAxis(supportedCode, 8) > 100, 'keeps steering at the far slab')

  const blocked = await runTraversal({
    pathNode: 1, character: [0, 0.85, 3.5], nodes, waypoints: [0, 1],
    geometry: [floorSlab(0, 0, 2.5, 10, 2.5), floorSlab(0, 0, 10, 10, 2)],
  })
  assert.equal(blocked.faults, 0, JSON.stringify(blocked.firstFault))
  const blockedCode = traversalControl(blocked.components)
  assert.equal(blockedCode & TRAV_JUMP, 0, `4 m gap is not jumped: ${blockedCode.toString(16)}`)
  assert.ok(signedAxis(blockedCode, 8) > 100, 'still steers toward the route')
})

test('traversal helper jumps a reachable ledge and grabs it only while airborne', async () => {
  const nodes = [{ index: 0, p: [0, 0, 0] as [number, number, number] }, { index: 1, p: [0, 2.45, 9.5] as [number, number, number] }]
  const geometry = [floorSlab(0, 0, 3, 4, 3), floorSlab(0, 2, 8, 4, 2)]
  const ground = await runTraversal({ pathNode: 1, character: [0, 0.85, 4.5], nodes, waypoints: [0, 1], geometry })
  assert.equal(ground.faults, 0, JSON.stringify(ground.firstFault))
  const groundCode = traversalControl(ground.components)
  assert.notEqual(groundCode & TRAV_JUMP, 0, `ledge 2.0 m up, 1.5 m ahead: ${groundCode.toString(16)}`)
  assert.equal(groundCode & TRAV_GRAB, 0, 'no grab from the floor')

  const air = await runTraversal({ pathNode: 1, character: [0, 1.4, 5.6], nodes, waypoints: [0, 1], geometry })
  assert.equal(air.faults, 0, JSON.stringify(air.firstFault))
  const airCode = traversalControl(air.components)
  assert.notEqual(airCode & TRAV_GRAB, 0, `airborne ledge grab: ${airCode.toString(16)}`)
  assert.equal(airCode & TRAV_JUMP, 0, 'no second jump mid-air')
})

test('traversal helper follows a long rise along its support centreline', async () => {
  const nodes = [{ index: 0, p: [0, 0, 0] as [number, number, number] }, { index: 1, p: [0, 3, 20] as [number, number, number] }]
  const geometry: unknown[] = [floorSlab(0, 0, 0.5, 2, 2.5)]
  for (let i = 0; i < 9; i++) geometry.push(floorSlab(3, 0.5 + i * 0.25, 4 + i, 2, 0.5))
  const ramp = await runTraversal({ pathNode: 1, character: [0, 0.85, 2], nodes, waypoints: [0, 1], geometry })
  assert.equal(ramp.faults, 0, JSON.stringify(ramp.firstFault))
  const code = traversalControl(ramp.components)
  assert.equal(code & TRAV_JUMP, 0, `a rising support is not a gap or ledge: ${code.toString(16)}`)
  assert.ok(signedAxis(code, 0) > 20, `steers toward the ramp centreline, x=${signedAxis(code, 0)}`)
  assert.ok(signedAxis(code, 8) > 40, `still forward, z=${signedAxis(code, 8)}`)
})

test('traversal helper waits on a predictable track, jumps a marked rotor and dives a see-saw', async () => {
  const nodes = [{ index: 0, p: [0, 0, 0] as [number, number, number] }, { index: 1, p: [0, 0, 10] as [number, number, number] }]
  const geometry = [floorSlab(0, 0, 5, 4, 5)]
  const blocked = await runTraversal({
    pathNode: 1, nodes, waypoints: [0, 1], geometry,
    movers: [{ kind: 1, pos: [0, 1, 2], axis: [0, 1, 0], half: [1, 1, 1] }],
  })
  assert.equal(blocked.faults, 0, JSON.stringify(blocked.firstFault))
  assert.equal(traversalControl(blocked.components), 0, 'waits outside a predictable spinner sweep')

  const rotor = await runTraversal({
    pathNode: 1, nodes: [...nodes, { index: 2, p: [0, 0, 2], jump: 1 }], waypoints: [0, 1], geometry,
    movers: [{ kind: 1, pos: [0, 1, 2], axis: [0, 1, 0], half: [1, 1, 1] }],
  })
  assert.equal(rotor.faults, 0, JSON.stringify(rotor.firstFault))
  const rotorCode = traversalControl(rotor.components)
  assert.notEqual(rotorCode & TRAV_JUMP, 0, `a marked horizontal rotor is jumped: ${rotorCode.toString(16)}`)

  const seeSaw = await runTraversal({
    pathNode: 1, nodes, waypoints: [0, 1], geometry,
    movers: [{ kind: 3, pos: [0, 0.3, 2], axis: [1, 0, 0], half: [2, 0.2, 1.5] }],
  })
  assert.equal(seeSaw.faults, 0, JSON.stringify(seeSaw.firstFault))
  const seeSawCode = traversalControl(seeSaw.components)
  assert.notEqual(seeSawCode & TRAV_DIVE, 0, `a stateful see-saw is dived: ${seeSawCode.toString(16)}`)
  assert.equal(seeSawCode & TRAV_JUMP, 0)
})

test('traversal helper preserves wait and pull timing', async () => {
  const nodes = [
    { index: 0, p: [0, 0, 10] as [number, number, number] },
    { index: 1, p: [0, 0, 1] as [number, number, number], wait: 0 },
    { index: 2, p: [0, 0, 10] as [number, number, number] },
  ]
  const waiting = await runTraversal({
    pathNode: 1, nodes, waypoints: [1, 2], advance: 2, signals: [{ value: 0 }],
  })
  assert.equal(waiting.faults, 0, JSON.stringify(waiting.firstFault))
  assert.equal(traversalControl(waiting.components), 0, 'a closed wait signal holds neutral')
  assert.equal(waiting.components.bot_memory['35'].wait_ticks, 1)

  const opened = await runTraversal({
    pathNode: 1, nodes, waypoints: [1, 2], advance: 2, signals: [{ value: 1 }],
  })
  assert.equal(opened.faults, 0, JSON.stringify(opened.firstFault))
  const openedCode = traversalControl(opened.components)
  assert.ok(signedAxis(openedCode, 8) > 100, 'an open signal advances to the next node')
  assert.equal(opened.components.bot_memory['35'].wait_ticks, 0)
  assert.equal(opened.components.bot_memory['35'].path_index, 2)

  const pullNodes = [
    { index: 0, p: [0, 0, 10] as [number, number, number] },
    { index: 1, p: [0, 0, 1] as [number, number, number], pull: 0 },
    { index: 2, p: [0, 0, 10] as [number, number, number] },
  ]
  const pressing = await runTraversal({
    pathNode: 1, nodes: pullNodes, waypoints: [1, 2], advance: 2,
    signals: [{ value: 0, handle: [0.5, 0.85, 0.5] }],
  })
  assert.equal(pressing.faults, 0, JSON.stringify(pressing.firstFault))
  const pressCode = traversalControl(pressing.components)
  assert.notEqual(pressCode & TRAV_GRAB, 0, 'stands still and presses the lever')
  assert.equal(pressCode & 0xffff, 0)
  assert.equal(pressing.components.bot_memory['35'].wait_ticks, 1)

  const pulled = await runTraversal({
    pathNode: 1, nodes: pullNodes, waypoints: [1, 2], advance: 2,
    signals: [{ value: 1, handle: [0.5, 0.85, 0.5] }],
  })
  assert.equal(pulled.faults, 0, JSON.stringify(pulled.firstFault))
  assert.ok(signedAxis(traversalControl(pulled.components), 8) > 100, 'an on lever advances the route')
})

test('traversal helper targets valid hex support and returns neutral for path node -1', async () => {
  const nodes = [
    { index: 0, p: [3, 0, 0] as [number, number, number] },
    { index: 1, p: [0, 0, 4] as [number, number, number] },
  ]
  const rerouted = await runTraversal({
    pathNode: 0, nodes, waypoints: [0, 1],
    hexes: [{ x: 0, z: 0, state: 0 }, { x: 3, z: 0, state: 3 }, { x: 0, z: 4, state: 0 }],
  })
  assert.equal(rerouted.faults, 0, JSON.stringify(rerouted.firstFault))
  const code = traversalControl(rerouted.components)
  assert.equal(signedAxis(code, 8), 127, `steers to the solid hex instead of the dropped one: ${code.toString(16)}`)
  assert.equal(signedAxis(code, 0), 0)
  assert.equal(rerouted.components.traversal_probe['34'].neutral, 0)
})

test('traversal helper traps an unresolved path node but -1 never reads one', async () => {
  const nodes = [{ index: 0, p: [0, 0, 0] as [number, number, number] }]
  const missing = await runTraversal({ pathNode: 9, nodes, waypoints: [0] })
  assert.ok(missing.faults > 0, 'an invalid node index is a script fault')
  const neutral = await runTraversal({ pathNode: -1, nodes, waypoints: [0], noRoute: true })
  assert.equal(neutral.faults, 0, JSON.stringify(neutral.firstFault))
  assert.equal(neutral.components.traversal_probe['34'].code, 0)
  assert.equal(neutral.components.traversal_probe['34'].neutral, 0)
})

const brainProbePath = 'probe/bots_brain.as.ts'
const brainProbeSource = `import { tick } from 'ege'
import { rf_show_controls, rf_show_bots } from '../bots/brain.as'
export function rf_bots_controls_probe(): void { rf_show_controls() }
export function rf_bots_brain_probe(): void { rf_show_bots() }
`

function brainSchemaText(): string {
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))
  const reads = ['show_seat_identity', 'show_control', 'bot_seat', 'bot_memory', 'bot_skill', 'bot_behaviour', 'bot_rule', 'bot_route', 'bot_route_waypoint', 'show_nav_node', 'show_nav_region', 'show_nav_edge', 'ege.transform', 'ege.mover', 'character', 'ege.mech.signal', 'ege.mech.lever', 'feature', 'feature_hex_field', 'feature_hex_field_hex', 'bot_reaction', 'bot_reaction_chunk']
  schema.world_kinds.push({ name: 'bots_brain_probe', players: 8, schedule: [
    { system: 'rf.bots.controls_probe', kind: 'script', reads: ['show_seat_identity', 'show_control'], writes: ['show_control'], emits: [] },
    { system: 'rf.bots.brain_probe', kind: 'script', reads, writes: ['bot_memory', 'bot_skill', 'bot_reaction', 'bot_reaction_chunk', 'bot_route', 'bot_route_region', 'bot_route_edge', 'bot_route_waypoint', 'show_control'], emits: [] },
  ] })
  return JSON.stringify(schema)
}

let brainWasmPromise: Promise<Uint8Array> | null = null
function brainWasm(): Promise<Uint8Array> {
  brainWasmPromise ??= compileBrainWasm(brainSchemaText())
  return brainWasmPromise
}

async function compileBrainWasm(schema: string): Promise<Uint8Array> {
    const files = [...collectRfScripts(), { name: brainProbePath, text: brainProbeSource }]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    const result = await (await rfCompiler()).compile(files, schema)
    const errors = result.diagnostics.filter(d => d.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm
}

function brainScene(delay = 0) {
  const entities: any[] = Array.from({ length: 35 }, () => ({ components: {} }))
  entities.push({ components: {
    show_seat_identity: { room_seat: 47, round_seat: 47, input_slot: -1, bot: 1 },
    show_control: { code: 0x1234 },
    bot_seat: { owner: 35, character: 35, behaviour: 36 },
    bot_memory: { owner: 35, rng_state: 7, ticks: 0, wait_ticks: 0, path_index: 0, stuck_ticks: 0, last_x: 0, last_z: 0, wobble: 0 },
  } })
  entities.push({ components: { bot_behaviour: { owner: NO_ENTITY, index: 0, decision_ticks: 1, reaction_ticks: delay, wobble_ticks: 45, stuck_ticks: 30, preference: 0, advance_m: 1.5, arrive_m: 0.5, rule_count: 0 } } })
  return { format: 'ege.scene' as const, version: 1 as const, world_kind: 'bots_brain_probe', seed: 7, entities }
}

async function runBrain(delay: number, steps: number) {
  const engine = await loadEngine()
  engine.setSchema(brainSchemaText())
  const module = await loadScript(engine, await brainWasm(), { name: 'bots-brain-probe' })
  const world = engine.createWorld(brainScene(delay))
  const host = new ScriptHost(module)
  for (let i = 0; i < steps; i++) host.stepTick(world, Array(8).fill(0))
  const components = readWorldState(engine, world, schemaLayout(engine)).components
  assert.equal(module.faultCount, 0, JSON.stringify(module.faults[0]))
  return { engine, world, module, host, components }
}

test('bot brain preserves neutral no-route output and reaction delay endpoints', async () => {
  const immediate = await runBrain(0, 1)
  assert.equal(immediate.components.show_control['35'].code, 32639, 'no-route neutral is S1 neutral')
  assert.equal(Object.values(immediate.components.bot_route ?? {}).length, 0)
  const delayed = await runBrain(120, 121)
  assert.equal(delayed.components.bot_reaction['36']?.code_count ?? Object.values(delayed.components.bot_reaction).find((r: any) => r.owner === 35)?.code_count, 120)
  assert.equal(delayed.components.show_control['35'].code, 32639, 'warm-up neutral is S1 neutral')
})

// Engine inputs as the runtime passes them to the host. Expected S1 codes are hand-derived:
// axis byte a maps to a + 127 after clamping to -127..127; buttons keep bits 16..18.
const HUMAN_INPUTS = [
  0,
  0x7f,
  0x81,
  0x80,
  0x10000,
  0x20000,
  0x40000,
  0x8100,
]
const HUMAN_EXPECTED = [
  32639,
  32766,
  32512,
  32512,
  98175,
  163711,
  294783,
  127,
]

test('show human controls convert assigned engine slots to S1 with neutral, signs, buttons and clamping', async () => {
  const schema = JSON.parse(brainSchemaText())
  const worldKind = schema.world_kinds.find((kind: any) => kind.name === 'bots_brain_probe')
  worldKind.schedule = [worldKind.schedule[0]]
  const entities: any[] = Array.from({ length: 35 }, () => ({ components: {} }))
  HUMAN_INPUTS.forEach((_, slot) => {
    entities.push({ components: { show_seat_identity: { room_seat: 50 + slot, round_seat: 50 + slot, input_slot: slot, bot: 0 }, show_control: { code: 1 } } })
  })
  entities.push({ components: { show_seat_identity: { room_seat: 59, round_seat: 59, input_slot: -1, bot: 1 }, show_control: { code: 0x55 } } })
  const engine = await loadEngine()
  const controlsSchema = JSON.stringify(schema)
  engine.setSchema(controlsSchema)
  const module = await loadScript(engine, await compileBrainWasm(controlsSchema), { name: 'bots-control-probe' })
  const world = engine.createWorld({ format: 'ege.scene', version: 1, world_kind: 'bots_brain_probe', seed: 7, entities })
  new ScriptHost(module).stepTick(world, HUMAN_INPUTS)
  const controls = readWorldState(engine, world, schemaLayout(engine)).components.show_control
  HUMAN_EXPECTED.forEach((expected, slot) => {
    assert.equal(controls[String(35 + slot)].code, expected, `slot ${slot} input ${HUMAN_INPUTS[slot]}`)
  })
  assert.equal(controls['43'].code, 0x55, 'bot control is left to the brain path')
  assert.equal(module.faultCount, 0, JSON.stringify(module.faults[0]))
})

test('show human control keeps a high stable seat id mapped to its slot and leaves bots alone', async () => {
  const schema = JSON.parse(brainSchemaText())
  const worldKind = schema.world_kinds.find((kind: any) => kind.name === 'bots_brain_probe')
  worldKind.schedule = [worldKind.schedule[0]]
  const entities: any[] = Array.from({ length: 35 }, () => ({ components: {} }))
  entities.push({ components: { show_seat_identity: { room_seat: 50, round_seat: 50, input_slot: 6, bot: 0 }, show_control: { code: 1 } } })
  entities.push({ components: { show_seat_identity: { room_seat: 59, round_seat: 59, input_slot: -1, bot: 1 }, show_control: { code: 0x55 } } })
  const engine = await loadEngine()
  const controlsSchema = JSON.stringify(schema)
  engine.setSchema(controlsSchema)
  const module = await loadScript(engine, await compileBrainWasm(controlsSchema), { name: 'bots-control-probe' })
  const world = engine.createWorld({ format: 'ege.scene', version: 1, world_kind: 'bots_brain_probe', seed: 7, entities })
  new ScriptHost(module).stepTick(world, Array.from({ length: 8 }, (_, slot) => slot * 101))
  const controls = readWorldState(engine, world, schemaLayout(engine)).components.show_control
  assert.equal(controls['35'].code, 33245, 'engine 606 is axes +94,+2 and S1 221,129')
  assert.equal(controls['36'].code, 0x55)
  assert.equal(module.faultCount, 0, JSON.stringify(module.faults[0]))
})

test('pending bot reaction chunks remain equal after snapshot restore and entity transfer', async () => {
  const source = await runBrain(120, 121)
  const layout = schemaLayout(source.engine)
  const snapshot = source.engine.snapshot(source.world)
  const restored = source.engine.createWorld(JSON.stringify(brainScene(120)))
  source.engine.restore(restored, snapshot)
  const before = readWorldState(source.engine, source.world, layout).components
  const owned = [35, 36, ...Object.entries(before.bot_reaction).filter(([, row]: any) => row.owner === 35).map(([entity]) => Number(entity)),
    ...Object.entries(before.bot_reaction_chunk).filter(([, row]: any) => row.owner === 35).map(([entity]) => Number(entity))]
  const blank = { ...brainScene(120), entities: [] }
  const transferred = source.engine.createWorld(JSON.stringify(blank))
  try {
    const moved = source.engine.importEntities(transferred, source.engine.exportEntities(source.world, owned, true))
    const movedSeat = moved[0]
    const live = source.components
    const replay = readWorldState(source.engine, restored, layout).components
    const transfer = readWorldState(source.engine, transferred, layout).components
    const liveSeat = '35'
    const replaySeat = '35'
    assert.ok(replay.show_control[replaySeat], JSON.stringify({ replaySeat, keys: Object.keys(replay.show_control), liveSeat, liveKeys: Object.keys(live.show_control) }))
    assert.equal(replay.show_control[replaySeat].code, live.show_control[liveSeat].code)
    assert.equal(replay.bot_memory[replaySeat].rng_state, live.bot_memory[liveSeat].rng_state)
    assert.equal(Object.values(replay.bot_reaction).find((row: any) => row.owner === Number(replaySeat))?.code_count,
      Object.values(live.bot_reaction).find((row: any) => row.owner === Number(liveSeat))?.code_count)
    const movedQueue: any = Object.values(transfer.bot_reaction)[0]
    assert.ok(movedQueue, JSON.stringify({ movedSeat, moved, bot_reaction: transfer.bot_reaction, owned }))
    assert.equal(movedQueue.code_count, 120)
    const transferredSeat = Object.keys(transfer.bot_seat)[0]
    assert.equal(transfer.show_control[transferredSeat].code, live.show_control[liveSeat].code)
    assert.equal(transfer.bot_memory[transferredSeat].rng_state, live.bot_memory[liveSeat].rng_state)
    assert.equal(source.module.faultCount, 0, JSON.stringify(source.module.faults[0]))
  } finally {
    source.engine.freeWorld(restored)
    source.engine.freeWorld(transferred)
    source.engine.freeWorld(source.world)
    source.module.dispose()
  }
})
