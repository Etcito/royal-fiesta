import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { EgeError } from '@etcito/game-engine/abi'
import { schemaLayout } from '@etcito/game-engine/script'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'
import { createEngineOnlineShow } from '../src/ege/online.ts'
import { engineOnlineStats, onlineMeasurements } from '../src/ege/onlineState.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'
import { onlineRoster } from '../src/net/onlineMatch.ts'
import { ZoneLoopback } from '../src/net/zoneLoopback.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const schemaKey = schemaLayout(engine).key

const script = await (async () => {
  const result = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
  assert.ok(result.wasm)
  return result.wasm as Uint8Array<ArrayBuffer>
})()

const ROOT = new URL('../../../', import.meta.url)
const readRepoJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const readRepoText = async (path: string): Promise<string> => readFileSync(new URL(path, ROOT), 'utf8')
const assetResolver: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    return { asset: await parseGameAsset(readRepoJson(path), path), source: { path, json: readRepoJson(path) } }
  },
}

async function loadCourse(id: string): Promise<{ course: CourseV1; assets: Map<string, ResolvedGameAsset> }> {
  const path = `fixtures/ege/${id}.course.json`
  const course = await loadCourseV1(readRepoJson(path), path, assetResolver)
  const assets = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) assets.set(assetId, await assetResolver.resolve(assetId))
  return { course, assets }
}

const loaded = await loadCourse('ege-strip')
const authored = loaded.course.sim!.level ?? legacyLevel(loaded.course.sim!)
const course = {
  ...loaded.course,
  sim: { ...loaded.course.sim!, level: { ...authored, timeCapTicks: 300, overtimeTicks: 0 } },
} as CourseV1
const zones = new Map<string, ZonesFile>([[course.id, parseZonesFile({
  format: 'royal-fiesta.zones', version: 0, course: course.id,
  grid: { origin: [-64, -64], cell: [2, 2], cols: 64, rows: 64 }, parts: {}, tuning: {},
}, `courses/${course.id}.zones.json`, course.sim!)]])

const season = [
  { id: 'A', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
] as const
const roster: Roster = onlineRoster(2, 60)
const NEUTRAL = 32639

function config(over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: script.slice(), seed: 7,
    identity: { backend: 'engine', schemaKey, moduleKey: 'publication' },
    courses: [course], assets: loaded.assets, zones, season,
    humans: Array.from({ length: 60 }, (_, seat) => seat < 2), plan: [60, 12, 1], testMode: true,
    ...over,
  }
}

function network(localPeer: number, transport: GroupTransport) {
  return { localPeer, roster, transport, measurements: onlineMeasurements(roster) }
}

type Runtime = Awaited<ReturnType<typeof createEngineOnlineShow>>

async function open(net: ZoneLoopback, peer: number): Promise<Runtime> {
  return createEngineOnlineShow(config(), network(peer, net.transport(peer)))
}

function disposeAll(runtimes: readonly (Runtime | undefined)[]): void {
  for (const runtime of runtimes) runtime?.dispose()
}

test('two peers play one scripted round to the same confirmed result', async () => {
  const net = new ZoneLoopback(2, { seed: 1, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes: (Runtime | undefined)[] = [await open(net, 0), await open(net, 1)]
  const sampled: number[][] = [[], []]
  try {
    for (let frame = 0; frame < 12000; frame++) {
      net.advance(1000 / 60)
      for (let peer = 0; peer < 2; peer++) {
        runtimes[peer]!.frame(1 / 60, seat => { sampled[peer]!.push(seat); return NEUTRAL })
      }
      if (runtimes.every(runtime => runtime!.snapshot().results.length > 0)) break
    }
    const states = runtimes.map(runtime => runtime!.snapshot())
    for (const state of states) {
      assert.ok(state.screen === 'results' || state.screen === 'podium' || state.screen === 'done')
      assert.equal(state.faults, 0)
      assert.equal(state.round, 0)
      assert.equal(state.results.length, 1)
    }
    const first = states[0]!.results[0]!
    assert.deepEqual(first, states[1]!.results[0]!)
    assert.equal(first.index, 0)
    assert.equal(first.course, course.id)
    for (const runtime of runtimes) {
      const stats = engineOnlineStats(runtime!)!
      assert.equal(stats.desyncs, 0)
      assert.equal(stats.spectator, false)
    }
    assert.deepEqual([...new Set(sampled[0]!)], [0])
    assert.deepEqual([...new Set(sampled[1]!)], [1])
  } finally {
    disposeAll(runtimes)
  }
})

test('a late-joining peer keeps the first peer out of playing until both sessions agree', async () => {
  const net = new ZoneLoopback(2, { seed: 2, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes: (Runtime | undefined)[] = [await open(net, 0)]
  let joined = false
  try {
    for (let frame = 0; frame < 12000; frame++) {
      net.advance(1000 / 60)
      runtimes[0]!.frame(1 / 60, () => NEUTRAL)
      if (!joined) {
        assert.notEqual(runtimes[0]!.snapshot().screen, 'playing')
        if (net.now() >= 2000) {
          runtimes[1] = await open(net, 1)
          joined = true
        }
      }
      runtimes[1]?.frame(1 / 60, () => NEUTRAL)
      if (runtimes[0]!.snapshot().results.length > 0 && runtimes[1]!.snapshot().results.length > 0) break
    }
    assert.equal(joined, true)
    const states = runtimes.map(runtime => runtime!.snapshot())
    assert.deepEqual(states[0]!.results, states[1]!.results)
    assert.equal(states[0]!.results.length, 1)
    assert.equal(states[0]!.faults, 0)
  } finally {
    disposeAll(runtimes)
  }
})

test('a peer whose transport closes is dropped and the remaining peer confirms the round', async () => {
  const net = new ZoneLoopback(2, { seed: 3, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes: (Runtime | undefined)[] = [await open(net, 0), await open(net, 1)]
  try {
    for (let frame = 0; frame < 12000 && runtimes[0]!.snapshot().screen !== 'playing'; frame++) {
      net.advance(1000 / 60)
      for (const runtime of runtimes) runtime!.frame(1 / 60, () => NEUTRAL)
    }
    assert.equal(runtimes[0]!.snapshot().screen, 'playing')
    net.net.kill(1)
    for (let frame = 0; frame < 12000 && runtimes[0]!.snapshot().results.length === 0; frame++) {
      net.advance(1000 / 60)
      runtimes[0]!.frame(1 / 60, () => NEUTRAL)
    }
    const state = runtimes[0]!.snapshot()
    assert.equal(state.results.length, 1)
    assert.equal(state.results[0]!.course, course.id)
    assert.equal(state.faults, 0)
    assert.equal(engineOnlineStats(runtimes[0]!)!.livePeers, 1)
  } finally {
    disposeAll(runtimes)
  }
})

test('preparation pending leaves the online gate loading and exposes no runtime', async () => {
  const realCompile = WebAssembly.compile
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  Reflect.set(WebAssembly, 'compile', async (source: BufferSource) => { await blocked; return realCompile(source) })
  let runtime: Runtime | undefined
  const gate = { state: 'loading' as 'loading' | 'ready' | 'failed', ready: false }
  try {
    const net = new ZoneLoopback(2, { seed: 5, rttMs: 0, jitterMs: 0, loss: 0 })
    const preparing = open(net, 0).then(value => { gate.state = 'ready'; gate.ready = true; return value },
      error => { gate.state = 'failed'; throw error })
    assert.equal(gate.state, 'loading')
    assert.equal(gate.ready, false)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(gate.state, 'loading')
    assert.equal(gate.ready, false)
    release()
    runtime = await preparing
    assert.equal(gate.state, 'ready')
    assert.equal(gate.ready, true)
    assert.equal(runtime.mode, 'online')
  } finally {
    release()
    Reflect.set(WebAssembly, 'compile', realCompile)
    runtime?.dispose()
  }
})

test('failed preparation surfaces without a runtime or a session', async () => {
  const net = new ZoneLoopback(2, { seed: 6, rttMs: 0, jitterMs: 0, loss: 0 })
  const broken = { ...config(), scriptBytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }
  let state: 'loading' | 'ready' | 'failed' = 'loading'
  const preparing = createEngineOnlineShow(broken, network(0, net.transport(0)))
    .then(value => { state = 'ready'; return value }, error => { state = 'failed'; throw error })
  assert.equal(state, 'loading')
  await assert.rejects(preparing, error => error instanceof EgeError)
  assert.equal(state, 'failed')
})

test('a missing course sidecar refuses the round without fabricating physics', async () => {
  const net = new ZoneLoopback(2, { seed: 4, rttMs: 0, jitterMs: 0, loss: 0 })
  const runtime = await createEngineOnlineShow(config({ zones: new Map() }), network(0, net.transport(0)))
  try {
    let failure: unknown
    for (let frame = 0; frame < 600 && failure === undefined; frame++) {
      net.advance(1000 / 60)
      try { runtime.frame(1 / 60, () => NEUTRAL) } catch (error) { failure = error }
    }
    assert.ok(failure instanceof RefusalError)
  } finally {
    runtime.dispose()
  }
})
