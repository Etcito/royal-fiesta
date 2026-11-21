import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { EgeError } from '@etcito/game-engine/abi'
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
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const
const roster: Roster = onlineRoster(2, 60)
const NEUTRAL = 32639

function config(plan: readonly number[]): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: script.slice(), seed: 7,
    identity: { backend: 'engine', schemaKey, moduleKey: 'publication' },
    courses: [course], assets: loaded.assets, zones, season,
    humans: Array.from({ length: 60 }, (_, seat) => seat < 2), plan, testMode: true,
  }
}

type Runtime = Awaited<ReturnType<typeof createEngineOnlineShow>>

function open(net: ZoneLoopback, peer: number, plan: readonly number[]): Promise<Runtime> {
  const network = { localPeer: peer, roster, transport: net.transport(peer), measurements: onlineMeasurements(roster) }
  return createEngineOnlineShow(config(plan), network)
}

/**
 * Votes the client's own seat once per vote screen, like the engine-show online scenario must: a human seat that
 * round 0 eliminated is off the active roster, so it has no vote and the runtime refuses one (the guard stays).
 */
function voteOwn(runtime: Runtime, seat: number): void {
  const state = runtime.snapshot()
  if (state.screen !== 'vote' || state.candidates.length === 0) return
  if (state.seatOf.includes(seat)) {
    runtime.vote(seat, 0)
    return
  }
  assert.throws(() => runtime.vote(seat, 0), /vote\.roomSeat: room seat \d is not on the active roster/)
}

for (const plan of [[60, 12, 1]]) {
  test(`two human seats (one joining late) and bots play plan ${plan.join('/')} to the end screen`, async () => {
    const net = new ZoneLoopback(2, { seed: 5, rttMs: 20, jitterMs: 0, loss: 0 })
    const runtimes: (Runtime | undefined)[] = [await open(net, 0, plan)]
    const screens = new Set<string>()
    const playing: number[] = []
    try {
      for (let frame = 0; frame < 60000; frame++) {
        net.advance(1000 / 60)
        if (runtimes[1] === undefined && net.now() >= 2000) runtimes[1] = await open(net, 1, plan)
        for (let peer = 0; peer < 2; peer++) {
          const runtime = runtimes[peer]
          if (runtime === undefined) continue
          voteOwn(runtime, peer)
          runtime.frame(1 / 60, () => NEUTRAL)
          const state = runtime.snapshot()
          screens.add(state.screen)
          if (peer === 0 && state.screen === 'playing') playing.push(state.results.length)
        }
        if (runtimes.every(runtime => runtime?.snapshot().screen === 'done')) break
      }
      const states = runtimes.map(runtime => runtime!.snapshot())
      for (const state of states) {
        assert.equal(state.screen, 'done')
        assert.equal(state.faults, 0)
        assert.ok(state.results.length >= 1)
        assert.ok(state.champion !== null && state.champion >= 0)
      }
      assert.deepEqual(states[0]!.results, states[1]!.results)
      assert.ok(screens.has('vote') && screens.has('playing') && screens.has('podium'))
      for (const runtime of runtimes) assert.equal(engineOnlineStats(runtime!)!.desyncs, 0)
    } finally {
      for (const runtime of runtimes) runtime?.dispose()
    }
  })
}

test('a human seat off the active roster is refused at the vote, a rostered one is accepted', async () => {
  const net = new ZoneLoopback(2, { seed: 6, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes = [await open(net, 0, [60, 12, 1]), await open(net, 1, [60, 12, 1])]
  try {
    for (let frame = 0; frame < 600 && runtimes[0]!.snapshot().screen !== 'vote'; frame++) {
      net.advance(1000 / 60)
      for (const runtime of runtimes) runtime.frame(1 / 60, () => NEUTRAL)
    }
    for (let peer = 0; peer < 2; peer++) {
      const state = runtimes[peer]!.snapshot()
      assert.equal(state.screen, 'vote')
      assert.ok(state.candidates.length > 0)
      assert.ok(state.seatOf.includes(0) && state.seatOf.includes(1), 'both human seats are on the roster')
      runtimes[peer]!.vote(peer, 0)
    }
  } finally {
    for (const runtime of runtimes) runtime.dispose()
  }
})

test('seat 1 (joining late) eliminated before the podium vote casts no vote and the round reaches the end screen', async () => {
  const net = new ZoneLoopback(2, { seed: 5, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes: (Runtime | undefined)[] = [await open(net, 0, [60, 12, 1])]
  const voted: number[] = []
  let offRosterVotes = 0
  const refusals: unknown[] = []
  // Mirrors the engine-show online scenario's voteHeadless (apps/web/src/engineShow/scenarios/online.ts): that module
  // imports the browser page and cannot load in this headless test, so the same guard is applied here on the public
  // runtime.snapshot()/runtime.vote() pair.
  const guardedVote = (runtime: Runtime, seat: number): void => {
    const snapshot = runtime.snapshot()
    if (snapshot.screen !== 'vote' || snapshot.candidates.length === 0) return
    if (!snapshot.seatOf.includes(seat)) { if (seat === 1) offRosterVotes++; return }
    try {
      runtime.vote(seat, Math.min(0, snapshot.candidates.length - 1))
      if (seat === 1) voted.push(snapshot.round)
    } catch (error) {
      refusals.push(error)
    }
  }
  try {
    for (let frame = 0; frame < 60000; frame++) {
      net.advance(1000 / 60)
      if (runtimes[1] === undefined && net.now() >= 2000) runtimes[1] = await open(net, 1, [60, 12, 1])
      for (let peer = 0; peer < 2; peer++) {
        const runtime = runtimes[peer]
        if (runtime === undefined) continue
        guardedVote(runtime, peer)
        runtime.frame(1 / 60, () => NEUTRAL)
      }
      if (runtimes.every(runtime => runtime?.snapshot().screen === 'done')) break
    }
    assert.deepEqual(refusals, [], 'no RefusalError (vote.roomSeat or vote.candidate) expected')
    const state = runtimes[1]!.snapshot()
    assert.equal(state.screen, 'done')
    assert.ok(!state.seatOf.includes(1), 'seat 1 ended off the active roster')
    assert.ok(offRosterVotes > 0, 'seat 1 met a vote screen while off the roster and skipped it')
    assert.ok(voted.every(round => round === 0), 'seat 1 voted only before it was eliminated')
  } finally {
    for (const runtime of runtimes) runtime?.dispose()
  }
})

test('plan [60,1] seed 10 on the built season catalog: cut, single-candidate final vote, final, podium', async () => {
  const { parseSeason, playableMaps } = await import('../src/season.ts')
  const { showMaps } = await import('../src/net/zoneRounds.ts')
  const { catalogCutField } = await import('../src/ege/showScene.ts')
  const seasonData = parseSeason(readRepoJson('courses/season.json'), 'courses/season.json')
  const ids = [...new Set(playableMaps(seasonData).map(map => map.course))]
  const clones = ids.map(id => ({ ...course, id, sim: { ...course.sim!, id } }) as CourseV1)
  const cloneZones = new Map<string, ZonesFile>(clones.map(clone => [clone.id, parseZonesFile({
    format: 'royal-fiesta.zones', version: 0, course: clone.id,
    grid: { origin: [-64, -64], cell: [2, 2], cols: 64, rows: 64 }, parts: {}, tuning: {},
  }, `courses/${clone.id}.zones.json`, { ...course.sim!, id: clone.id })]))
  const catalog = showMaps(clones as never, seasonData)
  const at = (id: string): number => catalog.findIndex(map => map.id === id)
  assert.equal(catalogCutField(catalog, at('I')), 0)
  assert.equal(catalogCutField(catalog, at('G')) >>> 8, at('D') + 1)
  assert.equal(catalogCutField(catalog, at('E')), 1 | 0)
  const cfg = (): EngineShowConfig => ({
    ...config([60, 1]), seed: 10, courses: clones, zones: cloneZones, season: catalog,
  })
  const net = new ZoneLoopback(2, { seed: 5, rttMs: 20, jitterMs: 0, loss: 0 })
  const open2 = (peer: number): Promise<Runtime> => createEngineOnlineShow(cfg(), {
    localPeer: peer, roster, transport: net.transport(peer), measurements: onlineMeasurements(roster),
  })
  const runtimes = [await open2(0), await open2(1)]
  const voteCandidates: number[] = []
  try {
    for (let frame = 0; frame < 60000; frame++) {
      net.advance(1000 / 60)
      for (let peer = 0; peer < 2; peer++) {
        const state = runtimes[peer]!.snapshot()
        if (peer === 0 && state.screen === 'vote') voteCandidates.push(state.candidates.length)
        voteOwn(runtimes[peer]!, peer)
        runtimes[peer]!.frame(1 / 60, () => NEUTRAL)
      }
      if (runtimes.every(runtime => runtime.snapshot().screen === 'done')) break
    }
    for (const runtime of runtimes) {
      const state = runtime.snapshot()
      assert.equal(state.screen, 'done')
      assert.equal(state.faults, 0)
      assert.ok(state.results.length >= 2, 'a cut round and a final')
      assert.equal(state.results[0]!.map, 'E')
      assert.equal(state.results.at(-1)!.final, true)
    }
    assert.ok(voteCandidates.length > 0 && voteCandidates.every(count => count === 1), 'single-candidate votes')
  } finally {
    for (const runtime of runtimes) runtime.dispose()
  }
})
