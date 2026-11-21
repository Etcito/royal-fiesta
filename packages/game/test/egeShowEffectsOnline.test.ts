import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'
import { createEngineOnlineShow } from '../src/ege/online.ts'
import { EngineShowEffects } from '../src/ege/showEffects.ts'
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
const multiSeason = ['A', 'B', 'C'].map(id => (
  { id, course: 0, kind: 'race', finalRule: null, stages: ['R1', 'R2', 'R3', 'R4'], team: false, cut: false }
)) as EngineShowConfig['season']
const roster: Roster = onlineRoster(2, 60)
const NEUTRAL = 32639
const LATE_FRAMES = 120
const HIDDEN = 0
const HIDDEN_FRAMES = 30
const FORWARD = 127 | (254 << 8)

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

/**
 * Two human peers, the second joining late and the first stepping like a hidden page (one long frame every half
 * second). At each round start the zone session rebuilds the seat domain into a scratch world and restores those bytes
 * into its running world (ZoneSession.epochStep), so the seat entities get new ids inside the same running world.
 * Every confirmed seat event, progress included, must still have a publisher, and the presented world must be the
 * running one: progress is delivered in both rounds, through the vote screen between them.
 */
test('two humans online: every confirmed event, including progress, has a publisher through the vote screen', async () => {
  const net = new ZoneLoopback(2, { seed: 1, rttMs: 60, jitterMs: 20, loss: 0.05 })
  const multi = config({ season: multiSeason, plan: [60, 24, 12] })
  const openPeer = (peer: number): Promise<Runtime> => createEngineOnlineShow(multi, network(peer, net.transport(peer)))
  const progress: number[][] = [[], []]
  const round = [0, 0]
  const attach = (runtime: Runtime, peer: number): EngineShowEffects => new EngineShowEffects(runtime, {
    sound: (name) => { if (name === 'progress') progress[peer]!.push(round[peer]!) },
    grant: () => {},
  })
  const runtimes: (Runtime | undefined)[] = [await openPeer(0), undefined]
  const effects: (EngineShowEffects | undefined)[] = [attach(runtimes[0]!, 0), undefined]
  const votedAfterRound0 = [false, false]
  // The last physics world presented in round 1 (after the round-start rebuild): its tick when first seen and now.
  const presented = [0, 1].map(() => ({ key: '', first: -1, last: -1 }))
  try {
    for (let frame = 0; frame < 12000; frame++) {
      net.advance(1000 / 60)
      if (frame === LATE_FRAMES) {
        runtimes[1] = await openPeer(1)
        effects[1] = attach(runtimes[1], 1)
      }
      for (let peer = 0; peer < 2; peer++) {
        const runtime = runtimes[peer]
        if (runtime === undefined) continue
        if (peer === HIDDEN && frame % HIDDEN_FRAMES !== 0) continue
        const state = runtime.snapshot()
        // Plan 60/24/12 makes the third slot a final this race-only season cannot fill: stop at two confirmed rounds.
        if (state.results.length >= 2) continue
        round[peer] = state.round
        if (state.screen === 'vote' && state.candidates.length > 0 && state.seatOf.includes(peer)) {
          if (state.results.length > 0) votedAfterRound0[peer] = true
          runtime.vote(peer, 0)
        }
        const dtS = peer === HIDDEN ? HIDDEN_FRAMES / 60 : 1 / 60
        runtime.frame(dtS, seat => seat === peer ? FORWARD : NEUTRAL)
        effects[peer]!.pump()
        const world = runtime.presentation().worlds[0]
        if (runtime.snapshot().round === 1 && world !== undefined) {
          const at = world.ref.timeline.module.engine.tick(world.ref.world)
          const seen = presented[peer]!
          const key = `${world.ref.world}:${world.incarnation}`
          if (seen.key !== key) Object.assign(seen, { key, first: at })
          seen.last = at
        }
      }
      if (runtimes.every(runtime => runtime !== undefined && runtime.snapshot().results.length >= 2)) break
    }
    for (let peer = 0; peer < 2; peer++) {
      const state = runtimes[peer]!.snapshot()
      assert.equal(state.faults, 0)
      assert.equal(state.results.length, 2, `peer ${peer} confirmed rounds 0 and 1`)
      assert.ok(votedAfterRound0[peer], `peer ${peer} passed the vote screen after round 0`)
      for (const index of [0, 1]) {
        assert.ok(progress[peer]!.includes(index), `peer ${peer} delivered a confirmed progress event in round ${index}`)
      }
      const ticks = presented[peer]!
      assert.ok(ticks.last > ticks.first, `peer ${peer} presents the running world in round 1, not an unstepped scratch (${ticks.first} -> ${ticks.last})`)
      assert.equal(effects[peer]!.deliveryStats().droppedRecords, 0)
      assert.equal(engineOnlineStats(runtimes[peer]!)!.desyncs, 0)
    }
  } finally {
    for (const effect of effects) effect?.dispose()
    disposeAll(runtimes)
  }
})
