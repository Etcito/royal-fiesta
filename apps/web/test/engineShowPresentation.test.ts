import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUND_KINDS } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type {
  EnginePresentationWorld, EngineRoundResult, EngineShowObservation, EngineShowPresentation, EngineShowSnapshot,
} from '@royal-fiesta/game/ege/showTypes'
import {
  confirmedPodium, EngineScreenTracker, EngineSeatPresenter, engineEffectSinks, farPenguinBridge,
} from '../src/engineShow/presentation.ts'
import type { EnginePresentationReaders } from '../src/engineShow/presentation.ts'

const ALL = Array.from({ length: 60 }, (_, seat) => seat)

function snap(over: Partial<EngineShowSnapshot> = {}): EngineShowSnapshot {
  return { tick: 0, round: 0, screen: 'playing', seatOf: ALL, alive: ALL, candidates: [], results: [], champion: null, faults: 0, ...over }
}

function result(over: Partial<EngineRoundResult> = {}): EngineRoundResult {
  return {
    index: 0, map: 'm0', course: 'c0', kind: 'race', final: false, playoff: false, endTick: 10, reason: 'target',
    ranking: [5, 3, 9, 1], qualified: [5, 3], eliminated: [9, 1], points: [4, 3, 0, 0], teamScores: [], champion: -1, ...over,
  }
}

function farBytes(seats: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(2 + seats.length * 60)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, seats.length, true)
  seats.forEach((seat, i) => {
    const at = 2 + i * 60
    view.setUint32(at, seat + 1, true)
    view.setFloat64(at + 4, seat, true)
    view.setFloat64(at + 52, 1, true)
  })
  return bytes
}

function world(domain: number, incarnation: number, seats: readonly number[], humans = 1): EnginePresentationWorld {
  return {
    ref: { domain, kind: 'seat', world: domain },
    incarnation,
    seats: seats.map((roomSeat, roundSeat) => ({ roomSeat, roundSeat, inputSlot: roomSeat < humans ? roomSeat : -1, entity: 100 + roomSeat })),
    farSnapshot: () => farBytes(seats),
  } as unknown as EnginePresentationWorld
}

function observation(kind: EngineShowObservation['kind'], worlds: EnginePresentationWorld[], snapshot = snap()): EngineShowObservation {
  const presentation = { showId: 's', tick: snapshot.tick, round: 0, map: 'm0', course: null, worlds } as EngineShowPresentation
  return { kind, tick: snapshot.tick, snapshot, presentation }
}

function readers(parked: Set<number> = new Set()): EnginePresentationReaders {
  return { tick: () => 1, parked: (_world, entities) => new Set(entities.filter(entity => parked.has(entity - 100))) }
}

const near8 = new Set(ALL.slice(0, 8))

test('sixty active seats submit eight near and fifty-two far, never both', () => {
  const presenter = new EngineSeatPresenter(readers())
  presenter.observe(observation('post-tick', [world(1, 1, ALL)]), near8)
  const { near, far, view } = presenter.submission()
  assert.equal(near.size, 8)
  assert.equal(far.size, 52)
  assert.equal(view.count, 52)
  assert.deepEqual([...near].filter(seat => far.has(seat)), [])
})

test('parked and eliminated seats are absent and a returning seat appears once', () => {
  const presenter = new EngineSeatPresenter(readers(new Set([20])))
  const roster = ALL.filter(seat => seat !== 30)
  presenter.observe(observation('post-tick', [world(1, 1, ALL)], snap({ seatOf: roster })), near8)
  let far = presenter.submission().far
  assert.equal(far.has(20), false)
  assert.equal(far.has(30), false)
  const back = new EngineSeatPresenter(readers())
  back.observe(observation('post-tick', [world(1, 1, ALL)], snap({ tick: 2 })), near8)
  far = back.submission().far
  assert.equal(far.has(20), true)
  assert.equal(far.size, 52)
})

test('a reused domain handle with a new incarnation clears departed seats; release repopulates before drawing', () => {
  const presenter = new EngineSeatPresenter(readers())
  presenter.observe(observation('post-tick', [world(1, 1, ALL)]), near8)
  presenter.observe(observation('before-release', [world(1, 1, ALL)]), new Set())
  const survivors = ALL.slice(0, 12)
  presenter.refill(observation('post-tick', [world(1, 1, ALL), world(1, 2, survivors)]).presentation, snap({ seatOf: survivors }), near8)
  const { near, far } = presenter.submission()
  assert.deepEqual([...far].sort((a, b) => a - b), [8, 9, 10, 11])
  assert.equal(near.size, 8)
})

test('all-human near selection is honoured and conflicting live mappings refuse', () => {
  const presenter = new EngineSeatPresenter(readers())
  const humans = new Set([0, 1, 2, 3, 4, 5, 6, 7])
  presenter.observe(observation('post-tick', [world(1, 1, ALL, 8)]), humans)
  assert.deepEqual([...presenter.submission().near], [...humans])
  assert.throws(() => presenter.observe(observation('post-tick', [world(1, 3, [4]), world(2, 4, [4])]), humans), /two live worlds|conflicting owners/)
})

test('HUD model reads round, timer and qualification from authoritative state', () => {
  const season: SchedMap[] = ROUND_KINDS.map((kind, i) => ({
    id: `m${i}`, course: i, kind, finalRule: kind === 'final' ? 'crown' : null, stages: [], team: kind === 'team', cut: false,
  }))
  const tracker = new EngineScreenTracker()
  const course = { timeLimitS: 90 } as EngineShowPresentation['course']
  tracker.update(snap({ tick: 100 }), { map: 'm0', course }, season, 0)
  let model = tracker.update(snap({ tick: 160 }), { map: 'm0', course }, season, 0)
  assert.equal(model.screen, 'round')
  assert.equal(model.timer, '1:29')
  assert.equal(model.hud[0], 'Round 1: race - m0')
  assert.equal(model.hud[2], 'Alive 60')
  model = tracker.update(snap({ screen: 'overtime', tick: 9000 }), { map: 'm1', course }, season, 0)
  assert.equal(model.timer, 'OVERTIME')
  model = tracker.update(snap({ screen: 'results', results: [result()] }), { map: null, course: null }, season, 0)
  assert.equal(model.screen, 'result')
  assert.deepEqual([model.qualified, model.eliminated], [2, 2])
  model = tracker.update(snap({ round: 5, alive: [3] }), { map: 'm6', course }, season, 0)
  assert.equal(model.screen, 'spectate')
  assert.equal(model.hud[0], 'Round 6: final (crown) - m6')
  for (const [screen, expected] of [['vote', 'vote'], ['loading', 'countdown'], ['intro', 'countdown'], ['done', 'endScreen']] as const) {
    assert.equal(tracker.update(snap({ screen }), { map: null, course: null }, season, 0).screen, expected)
  }
})

test('the podium shows only a confirmed champion, on the highest place', () => {
  assert.equal(confirmedPodium(snap({ screen: 'podium', results: [result()] })), null)
  assert.equal(confirmedPodium(snap({ screen: 'podium', champion: 9, results: [result()] })), null)
  const confirmed = snap({ screen: 'podium', champion: 9, results: [result({ final: true, champion: 9 })] })
  assert.deepEqual(confirmedPodium(confirmed), [9, 5, 3])
  const model = new EngineScreenTracker().update(confirmed, { map: null, course: null }, [], 0)
  assert.equal(model.champion, 9)
  assert.equal(model.screen, 'podium')
})

test('effect sinks play mapped cues and record grants without duplicates', () => {
  const played: string[] = []
  const grants = new Map<string, EngineRoundResult>()
  const sinks = engineEffectSinks(() => ({ play: (id: string) => played.push(id) }), grants)
  sinks.sound('finish', {})
  sinks.sound('unknown', {})
  sinks.grant('r1', result())
  sinks.grant('r1', result())
  assert.deepEqual(played, ['flow.qualify'])
  assert.equal(grants.size, 1)
  const silent = engineEffectSinks(() => null, grants)
  assert.doesNotThrow(() => silent.sound('finish', {}))
})

test('the far penguin bridge instances the far mesh per submitted seat and releases them', () => {
  const live = new Set<number>()
  let next = 0
  const port = {
    registerAsset: () => 7,
    createInstance: (asset: number) => { assert.equal(asset, 7); live.add(++next); return next },
    setTransform: () => {},
    setVisible: () => {},
    destroyInstance: (instance: number) => { live.delete(instance) },
  }
  const bridge = farPenguinBridge(port as never, { id: 'zone.far-bean' } as never)
  const presenter = new EngineSeatPresenter(readers())
  presenter.observe(observation('post-tick', [world(1, 1, ALL)]), near8)
  bridge.sync(presenter.submission().view)
  assert.equal(live.size, 52)
  bridge.dispose()
  assert.equal(live.size, 0)
})
