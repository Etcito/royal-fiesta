import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'
import { createEngineHub } from '../src/ege/hub.ts'
import type { HubRuntime } from '../src/ege/hub.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const schemaKey = schemaLayout(engine).key

const ROOT = new URL('../../../', import.meta.url)
const readRepoJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const assetResolver: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readRepoJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}

async function loadShowCourse(id: string): Promise<{ course: CourseV1; assets: Map<string, ResolvedGameAsset> }> {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(readRepoJson(path), path, assetResolver)
  const assets = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) assets.set(assetId, await assetResolver.resolve(assetId))
  return { course, assets }
}

let scriptPromise: Promise<Uint8Array<ArrayBuffer>> | undefined
function scriptBytes(): Promise<Uint8Array<ArrayBuffer>> {
  scriptPromise ??= (async () => {
    const result = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm as Uint8Array<ArrayBuffer>
  })()
  return scriptPromise
}

const plazaLoaded = await loadShowCourse('hub-plaza')
const plaza = plazaLoaded.course
const assets = plazaLoaded.assets
const race = (await loadShowCourse('s1-f-taffy-circuit')).course

function hubConfig(over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: new Uint8Array(), seed: 7,
    identity: { backend: 'engine', schemaKey, moduleKey: 'publication' },
    courses: [plaza], assets, zones: new Map(), season: [], humans: [true],
    ...over,
  }
}

function newOut(): CharState {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

function readState(hub: HubRuntime, player = 0): CharState {
  return hub.state(newOut(), player)
}

function newView(): CharacterView {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
}

const forward = () => ({ ...neutralInput(), moveZ: 1 })
const horizontal = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z)

test('createEngineHub refuses a race course, bad spawns and too many bots', async () => {
  await assert.rejects(createEngineHub(hubConfig(), race, 0), RefusalError)
  await assert.rejects(createEngineHub(hubConfig(), plaza, -1), RefusalError)
  await assert.rejects(createEngineHub(hubConfig(), plaza, plaza.sim!.spawns.length), RefusalError)
  await assert.rejects(createEngineHub(hubConfig(), plaza, 0, 9), RefusalError)
  await assert.rejects(createEngineHub(hubConfig(), plaza, 0, 1.5), RefusalError)
  await assert.rejects(createEngineHub(hubConfig(), plaza, 0, 8), RefusalError)
})

test('forward input moves the local human more than a metre', async () => {
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0)
  try {
    const start = { ...readState(hub).pos }
    for (let i = 0; i < 60; i++) hub.step(forward())
    const end = readState(hub).pos
    assert.ok(horizontal(start, end) > 1, `forward movement ${horizontal(start, end)}m`)
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})

test('emotes last two seconds and refuse an out-of-range id', async () => {
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0)
  try {
    hub.setEmote(1, 1000)
    assert.equal(hub.emote(1500), 1)
    assert.equal(hub.emote(3001), 0)
    assert.throws(() => hub.setEmote(5, 0), RefusalError)
    assert.throws(() => hub.setEmote(1.5, 0), RefusalError)
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})

test('a floorless spawn falls and recovers, and respawn keeps the human on the plaza', async () => {
  const sim = plaza.sim!
  const extra = { t: { x: 500, y: 0, z: 500 }, facing: { x: 0, z: 1 } }
  const modified: CourseV1 = { ...plaza, sim: { ...sim, spawns: [...sim.spawns, extra] } }
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), modified, 8)
  const other = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0)
  try {
    const kill = sim.killPlaneY
    let below = false
    let recovered = false
    for (let i = 0; i < 240 && !recovered; i++) {
      const before = readState(hub)
      hub.step(neutralInput())
      const after = readState(hub)
      if (after.pos.y < kill) below = true
      if (after.teleportTick !== before.teleportTick && after.pos.y - before.pos.y > 5) recovered = true
    }
    assert.ok(below, 'the human fell below the kill plane')
    assert.ok(recovered, 'the hub recovered the fallen human above the kill plane')

    hub.respawn(0)
    assert.equal(hub.spawn, 0)
    for (let i = 0; i < 120; i++) {
      hub.step(neutralInput())
      assert.ok(readState(hub).pos.y > kill, `spawn 0 stays above the kill plane at tick ${i}`)
    }

    other.respawn(9)
    assert.equal(other.spawn, 1)
    assert.equal(hub.faults, 0)
    assert.equal(other.faults, 0)
  } finally {
    hub.free()
    other.free()
  }
})

test('movement and emotes work before and after the return respawn', async () => {
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0)
  try {
    const start = { ...readState(hub).pos }
    for (let i = 0; i < 30; i++) hub.step(forward())
    assert.ok(horizontal(start, readState(hub).pos) > 0.5, 'the human walked before the return')

    const before = hub.tick
    hub.respawn(hub.spawn)
    assert.ok(hub.tick >= before, `tick ${hub.tick} stayed monotonic after ${before}`)
    const respawned = { ...readState(hub).pos }
    for (let i = 0; i < 30; i++) hub.step(forward())
    assert.ok(horizontal(respawned, readState(hub).pos) > 0.5, 'the human walked after the return')

    hub.setEmote(2, 0)
    assert.equal(hub.emote(1000), 2)
    assert.ok(hub.tick > before)
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})

test('lobby bots appear at their seats and walk toward their wander targets', async () => {
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0, 3)
  try {
    assert.equal(hub.botCount, 3)
    assert.deepEqual(hub.botViews().map(view => view.seat), [1, 2, 3])
    const starts = hub.botViews().map(view => ({ ...view.pos }))
    for (let i = 0; i < 240; i++) hub.step(neutralInput())
    const ends = hub.botViews()
    assert.ok(ends.some((view, index) => horizontal(starts[index], view.pos) > 0.5), 'a lobby bot moved')
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})

test('view() follows the live human and refuses a seat beyond the bots', async () => {
  const hub = await createEngineHub(hubConfig({ scriptBytes: await scriptBytes() }), plaza, 0, 3)
  try {
    const view = hub.view()
    assert.equal(view.setup.playerCount, 4)
    assert.equal(view.course(), plaza.sim)
    hub.step(forward())
    const character = view.character(0, newView())
    const state = readState(hub)
    assert.deepEqual(character.pos, state.pos)
    assert.throws(() => view.character(4, newView()), RefusalError)
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})

test('free releases the live world and the module once', async () => {
  let created = 0
  let freed = 0
  const proxied = new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      if (prop === 'createWorld') return (...args: [scene: string]) => { created++; return target.createWorld(...args) }
      if (prop === 'freeWorld') return (...args: [world: number]) => { freed++; return target.freeWorld(...args) }
      return value.bind(target)
    },
  })
  const hub = await createEngineHub(hubConfig({ engine: proxied, scriptBytes: await scriptBytes() }), plaza, 0)
  try {
    assert.equal(created, 1)
    hub.free()
    assert.equal(freed, 1)
    assert.equal(created, freed)
    hub.free()
    assert.equal(freed, 1)
    assert.throws(() => hub.step(neutralInput()), RefusalError)
    assert.throws(() => hub.respawn(0), RefusalError)
    assert.equal(hub.faults, 0)
  } finally {
    hub.free()
  }
})
