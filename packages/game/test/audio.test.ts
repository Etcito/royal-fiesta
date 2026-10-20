import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createOfflineAudio, getBed, getFamily, getMix } from '@etcito/haa'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { neutralInput } from '@royal-fiesta/sim/input'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { createMatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import { CROWD_BED_ID, FIESTA_MIX_ID, FIESTA_SOUNDS } from '../src/audio/ids.ts'
import { BED_EXCITEMENT, BED_FADE_S, bedState, copySample, diffSamples, sampleMatch, type MatchSample, type PlayerSample } from '../src/audio/events.ts'
import { GameAudio, type BedPort, type SoundPort } from '../src/audio/gameAudio.ts'
import { registerRoyalFiesta, ROYAL_FIESTA_FAMILIES } from '../src/audio/pack/index.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8')

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return { mode: CharMode.ground, status: PlayerStatus.alive, vy: 0, pos: { x: 1, y: 0, z: 2 }, ...over }
}

function frame(players: PlayerSample[], over: Partial<Omit<MatchSample, 'players'>> = {}): MatchSample {
  return { phase: Phase.playing, roundKind: 'race', final: false, players, ...over }
}

function recordingPort(): SoundPort & { played: string[]; beds: { started: number; params: [string, number][]; stops: number[] } } {
  const beds = { started: 0, params: [] as [string, number][], stops: [] as number[] }
  const bed: BedPort = {
    setParam: (name, value) => { beds.params.push([name, value]) },
    stop: (fade) => { beds.stops.push(fade ?? 0) },
  }
  const played: string[] = []
  return {
    played,
    beds,
    play: (id) => { played.push(id) },
    startBed: (id) => { assert.equal(id, CROWD_BED_ID); beds.started++; return bed },
  }
}

test('every sound id the game plays is a registered family of the pack', () => {
  registerRoyalFiesta()
  registerRoyalFiesta()   // idempotent
  const packIds = new Set(ROYAL_FIESTA_FAMILIES.map((f) => f.id))
  for (const id of Object.values(FIESTA_SOUNDS)) {
    assert.ok(packIds.has(id), `${id} is not a family of the Royal Fiesta pack`)
    const family = getFamily(id)
    assert.ok(family, `family ${id} is not in the HAA registry after registerRoyalFiesta()`)
    assert.equal(family.id, id)
  }
  assert.ok(getBed(CROWD_BED_ID), `bed ${CROWD_BED_ID} is not in the HAA registry`)
  assert.ok(getMix(FIESTA_MIX_ID), `mix ${FIESTA_MIX_ID} is not in the HAA registry`)
})

test('a jump is grounded -> air with an upward velocity; a fall off a ledge is not a jump', () => {
  const ground = frame([player()])
  const jump = frame([player({ mode: CharMode.air, vy: 7.5 })])
  const fall = frame([player({ mode: CharMode.air, vy: -2 })])
  assert.deepEqual(diffSamples(ground, jump), [{ id: 'fiesta.jump', player: 0, pos: { x: 1, y: 0, z: 2 } }])
  assert.deepEqual(diffSamples(ground, fall), [])
})

test('dive, grab, wobble and eliminate fire on entering the state, once', () => {
  const base = frame([player()])
  const cases: [PlayerSample, string][] = [
    [player({ mode: CharMode.dive }), 'fiesta.dive'],
    [player({ mode: CharMode.grabbing }), 'fiesta.grab'],
    [player({ mode: CharMode.stunned }), 'fiesta.wobble'],
    [player({ status: PlayerStatus.eliminated }), 'fiesta.eliminate'],
  ]
  for (const [next, id] of cases) {
    const events = diffSamples(base, frame([next]))
    assert.deepEqual(events.map((e) => e.id), [id])
    assert.deepEqual(diffSamples(frame([next]), frame([next])), [], `${id} repeats while the state holds`)
  }
})

test('the first frame of a match plays nothing, so a late join does not burst', () => {
  assert.deepEqual(diffSamples(null, frame([player({ mode: CharMode.dive })])), [])
})

test('the crowd bed follows the round: on during intro and playing, faded out after the round', () => {
  assert.equal(bedState(frame([player()], { roundKind: null })).on, false)
  assert.equal(bedState(frame([player()], { phase: Phase.intro })).on, true)
  assert.equal(bedState(frame([player()], { phase: Phase.roundEnd })).on, false)
  assert.equal(bedState(frame([player()], { phase: Phase.podium })).on, false)
  assert.equal(bedState(frame([player()], { final: true })).excitement, BED_EXCITEMENT.final)
  assert.equal(bedState(frame([player()], { roundKind: 'survival' })).excitement, BED_EXCITEMENT.survival)
})

test('GameAudio starts the bed once per round, sets excitement and fades it out', () => {
  const port = recordingPort()
  const audio = new GameAudio(port)
  audio.observe(frame([player()], { phase: Phase.intro }))
  audio.observe(frame([player()], { phase: Phase.playing, final: true }))
  audio.observe(frame([player({ mode: CharMode.air, vy: 7 })], { phase: Phase.playing, final: true }))
  audio.observe(frame([player()], { phase: Phase.roundEnd }))
  assert.equal(port.beds.started, 1)
  assert.deepEqual(port.beds.params.at(-1), ['excitement', BED_EXCITEMENT.final])
  assert.deepEqual(port.beds.stops, [BED_FADE_S])
  assert.deepEqual(port.played, ['fiesta.jump'])
})

test('copySample is independent of the source object', () => {
  const a = frame([player({ pos: { x: 1, y: 2, z: 3 } })])
  const b = copySample(a, null)
  a.players[0].pos.x = 9
  assert.equal(b.players[0].pos.x, 1)
})

test('the pack plays through the offline HAA engine', () => {
  registerRoyalFiesta()
  const audio = createOfflineAudio({ mix: FIESTA_MIX_ID, maxListeners: 1 })
  const game = new GameAudio({ play: (id, o) => audio.play(id, o), startBed: (id) => audio.startBed(id) })
  game.observe(frame([player(), player()], { phase: Phase.intro }))
  game.observe(frame([player({ mode: CharMode.dive }), player()], { phase: Phase.playing }))
  game.observe(frame([player({ mode: CharMode.dive }), player({ status: PlayerStatus.eliminated })], { phase: Phase.playing }))
  audio.advance(0.5)
  assert.equal(audio.stats.played, 2, `played ${audio.stats.played} sounds`)
  game.stop()
})

const R = await initRapier()

async function loadCourses(): Promise<ResolvedCourse[]> {
  const entries = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, fixtureResolver(read), 'sprint')
}

test('the hooks read a real match: a jump on the ground plays fiesta.jump', async () => {
  const courses = await loadCourses()
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  try {
    const neutral = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
    const view: MatchViewState = {
      tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: 0,
      roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
    }
    for (let i = 0; i < 10000 && sim.phase(view).phase !== Phase.playing; i++) sim.step(neutral)
    assert.equal(view.phase, Phase.playing)
    for (let i = 0; i < 120; i++) sim.step(neutral)   // let the bean settle on the ground

    const port = recordingPort()
    const game = new GameAudio(port)
    const sample = { phase: 0, roundKind: null, final: false, players: [] as PlayerSample[] }
    const scratch: CharacterView = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 }, mode: 0, status: 0, parked: false, teleportTick: 0 }
    game.observe(sampleMatch(sim, sample, scratch))
    assert.equal(sim.character(0, scratch).mode, CharMode.ground, 'player 0 must be grounded before the jump')

    const press: PlayerInput[] = neutral.map((input, p) => (p === 0 ? { ...input, jump: true } : input))
    sim.step(press)
    game.observe(sampleMatch(sim, sample, scratch))
    for (let i = 0; i < 4 && !port.played.includes(FIESTA_SOUNDS.jump); i++) {
      sim.step(neutral)
      game.observe(sampleMatch(sim, sample, scratch))
    }
    assert.ok(port.played.includes(FIESTA_SOUNDS.jump), `no jump sound; played ${port.played.join(',') || 'nothing'}`)
    assert.equal(port.beds.started, 1, 'the crowd bed starts with the round')
  } finally {
    sim.free()
  }
})
