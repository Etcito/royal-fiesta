import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerEngineOnlineStats } from '@royal-fiesta/game/ege/onlineState'
import type { EngineShowRuntime, EngineShowSnapshot } from '@royal-fiesta/game/ege/showTypes'
import { EngineShellProbe, installEngineProbe } from '../src/game/engineProbe.ts'
import type { EngineProbeFrame, EngineShellHandle } from '../src/game/engineProbe.ts'

interface FakeShow {
  runtime: EngineShowRuntime
  snap: EngineShowSnapshot
}

function fakeShow(over: Partial<EngineShowSnapshot> = {}): FakeShow {
  const snap: EngineShowSnapshot = {
    tick: 0, round: 1, screen: 'intro', seatOf: [], alive: [], candidates: [], results: [], champion: null,
    faults: 0, ...over,
  }
  const runtime = { snapshot: () => ({ ...snap, results: [...snap.results] }) } as unknown as EngineShowRuntime
  return { runtime, snap }
}

function frame(over: Partial<EngineProbeFrame> = {}): EngineProbeFrame {
  return {
    screen: 'start', flow: 'start', ready: false, error: null, moduleKey: 'module-a', seats: 60, humans: 2,
    hubPresented: false, hubFaults: 0, show: null, lobbyId: null, lobbyMembers: 0, visibility: 'visible',
    online: false, ...over,
  }
}

function result(index: number): EngineShowSnapshot['results'][number] {
  return {
    index, map: 'm', course: 'c', kind: 'race', final: false, playoff: false, endTick: index, reason: 'target',
    ranking: [], qualified: [], eliminated: [], points: [], teamScores: [], champion: -1,
  } as unknown as EngineShowSnapshot['results'][number]
}

test('signals appear once each, in order, across a full sequence', () => {
  const probe = new EngineShellProbe()
  const show = fakeShow()
  probe.observe(frame({ ready: true, screen: 'hub', flow: 'hub', hubPresented: true }))
  probe.observe(frame({ flow: 'queued', lobbyId: 'L1', lobbyMembers: 2, online: true }))
  probe.observe(frame({ flow: 'queued', lobbyId: 'L1', lobbyMembers: 2, online: true }))
  show.snap.screen = 'playing'
  probe.observe(frame({ flow: 'match', show: show.runtime, online: true }))
  show.snap.screen = 'results'
  show.snap.results = [result(0)]
  probe.observe(frame({ flow: 'match', show: show.runtime, online: true }))
  show.snap.screen = 'podium'
  show.snap.results = [result(0), result(1)]
  probe.observe(frame({ flow: 'match', show: show.runtime, online: true }))
  probe.observe(frame({ flow: 'match', show: show.runtime, online: true }))
  probe.observe(frame({ flow: 'hub', hubPresented: true, online: true }))
  probe.observe(frame({ flow: 'hub', hubPresented: true, online: true }))
  assert.deepEqual(probe.signals(), [
    'page-ready', 'hub-ready', 'lobby-ready', 'round-ready', 'round-ended', 'round-ended', 'podium-ready',
    'hub-returned',
  ])
})

test('desyncs and faults come from the stats and the snapshot and are kept after the show is gone', () => {
  const probe = new EngineShellProbe()
  const show = fakeShow({ faults: 2, results: [], screen: 'playing', tick: 9 })
  registerEngineOnlineStats(show.runtime, () => ({ desyncs: 4, confirmedTick: 9, peers: 2, livePeers: 2, spectator: false }))
  probe.observe(frame({ flow: 'match', show: show.runtime, hubFaults: 1, online: true }))
  let state = probe.state()
  assert.equal(state.faults, 3)
  assert.equal(state.desyncs, 4)
  assert.equal(state.tick, 9)
  probe.observe(frame({ flow: 'hub', hubFaults: 1, online: true }))
  state = probe.state()
  assert.equal(state.faults, 3)
  assert.equal(state.desyncs, 4)
  assert.equal(state.tick, 9)
})

test('bots are seats minus humans', () => {
  const probe = new EngineShellProbe()
  probe.observe(frame({ seats: 60, humans: 2 }))
  assert.equal(probe.state().bots, 58)
})

test('a failed frame reports ready false and its error', () => {
  const probe = new EngineShellProbe()
  probe.observe(frame({ screen: 'failed', flow: 'failed', ready: false, error: 'boom' }))
  const state = probe.state()
  assert.equal(state.ready, false)
  assert.equal(state.error, 'boom')
  assert.equal(state.backend, 'engine')
  assert.deepEqual(probe.signals(), [])
})

test('installEngineProbe sets target.rfEngine and uninstall removes only its own handle', () => {
  const probe = new EngineShellProbe()
  const first: EngineShellHandle = { state: () => probe.state(), signals: () => probe.signals(), play: () => true }
  const second: EngineShellHandle = { ...first }
  const target: { rfEngine?: EngineShellHandle } = {}
  const uninstallFirst = installEngineProbe(target, first)
  assert.equal(target.rfEngine, first)
  const uninstallSecond = installEngineProbe(target, second)
  uninstallFirst()
  assert.equal(target.rfEngine, second)
  uninstallSecond()
  assert.equal('rfEngine' in target, false)
})

test('state() and signals() return copies', () => {
  const probe = new EngineShellProbe()
  probe.observe(frame({ ready: true, screen: 'hub', flow: 'hub', hubPresented: true }))
  const state = probe.state()
  state.screen = 'changed'
  assert.equal(probe.state().screen, 'hub')
  const signals = probe.signals() as string[]
  signals.push('extra')
  assert.deepEqual(probe.signals(), ['page-ready', 'hub-ready'])
})
