import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { NetSim } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, encodeInput, neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { createMatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { createNetMatch } from '../src/net/netMatch.ts'
import type { NetMatch } from '../src/net/netMatch.ts'
import { Pilot } from '../src/net/pilot.ts'
import { FIESTA_TUNING, NET_PLAYERS, netSetup } from '../src/net/tuning.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string) => readFile(new URL(rel, ROOT), 'utf8')

const R: RapierModule = await initRapier()

async function loadCourses(): Promise<ResolvedCourse[]> {
  const entries = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, fixtureResolver(read), 'sprint')
}

const courses = await loadCourses()

function viewState(): MatchViewState {
  return {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: 0,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
}

function charView(): CharacterView {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
}

function neutralInputs(): PlayerInput[] {
  return Array.from({ length: NET_PLAYERS }, () => neutralInput())
}

// Steps with neutral inputs until the first round is playing.
function stepToPlaying(sim: MatchSim): void {
  const v = viewState()
  const inputs = neutralInputs()
  for (let i = 0; i < 10000 && sim.phase(v).phase !== Phase.playing; i++) sim.step(inputs)
  assert.equal(v.phase, Phase.playing)
}

test('FIESTA_TUNING holds the contract values and NET_PLAYERS is 8', () => {
  assert.deepEqual({ ...FIESTA_TUNING }, {
    tickRate: 60, maxSubsteps: 8, maxPrediction: 16, snapshotRing: 40, minDelay: 2, maxDelay: 2,
    delayHiddenTicks: 6, lostAfterMs: 3000, dropWaitMs: 1500,
  })
  assert.ok(Object.isFrozen(FIESTA_TUNING))
  assert.equal(NET_PLAYERS, 8)
})

test('netSetup gives 8 players with humans first and refuses bad humanPeers', () => {
  const s = netSetup(11, 3, 'sprint', courses)
  assert.equal(s.playerCount, 8)
  assert.equal(s.seed, 11)
  assert.equal(s.profile, 'sprint')
  assert.deepEqual([...s.humans], [true, true, true, false, false, false, false, false])
  for (const bad of [0, 9, 1.5]) {
    assert.throws(() => netSetup(11, bad, 'sprint', courses), isRefusal, `humanPeers ${bad}`)
  }
})

test('createNetMatch refuses a setup that does not match the peers', () => {
  const net = new NetSim(2, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const s = netSetup(11, 2, 'sprint', courses)
  assert.throws(() => createNetMatch(R, { setup: { ...s, playerCount: 4, humans: s.humans.slice(0, 4) }, localPeer: 0, humanPeers: 2 },
    net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: 2, humanPeers: 2 }, net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: -1, humanPeers: 2 }, net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: 0, humanPeers: 3 }, net.transport(0)), isRefusal)
})

test('two peers on NetSim agree on every confirmed hash with delay 2', () => {
  const PEERS = 2
  const netsim = new NetSim(PEERS, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const setup = netSetup(7, PEERS, 'sprint', courses)
  const matches: NetMatch[] = []
  const pilots: Pilot[] = []
  const hashes: Map<number, number>[] = []
  const recorded: number[] = []
  for (let p = 0; p < PEERS; p++) {
    matches.push(createNetMatch(R, { setup, localPeer: p, humanPeers: PEERS }, netsim.transport(p)))
    pilots.push(new Pilot(p, setup.seed))
    hashes.push(new Map())
    recorded.push(-1)
  }
  try {
    for (let i = 0; i < 600; i++) {
      netsim.advance(1000 / 60)
      for (let p = 0; p < PEERS; p++) {
        const m = matches[p]
        const pilot = pilots[p]
        m.frame(1 / 60, out => { pilot.sample(m.sim, out[0]) })
        const c = m.session.stats.confirmedTick
        for (let t = recorded[p] + 1; t <= c; t++) {
          const h = m.session.confirmedHash(t)
          if (h !== undefined) hashes[p].set(t, h)
        }
        if (c > recorded[p]) recorded[p] = c
      }
    }
    let compared = 0
    for (const [t, h] of hashes[0]) {
      const other = hashes[1].get(t)
      if (other === undefined) continue
      assert.equal(other, h, `confirmed hash at tick ${t}`)
      compared++
    }
    assert.ok(compared >= 500, `compared ${compared} ticks`)
    for (const m of matches) {
      const st = m.session.stats
      assert.ok(st.confirmedTick > 500, `confirmedTick ${st.confirmedTick}`)
      assert.equal(st.desyncs, 0)
      assert.ok(st.delay + 1 <= 3, `delay ${st.delay}`)
    }
  } finally {
    for (const m of matches) {
      m.dispose()
      m.dispose()
    }
  }
})

test('Pilot.sample never changes the sim state', () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  try {
    stepToPlaying(sim)
    const before = sim.stateHash()
    const pilot = new Pilot(0, 5)
    const out = neutralInput()
    for (let i = 0; i < 50; i++) pilot.sample(sim, out)
    assert.equal(sim.stateHash(), before)
  } finally {
    sim.free()
  }
})

test('two Pilots with the same player and seed give identical inputs', () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  try {
    stepToPlaying(sim)
    const a = new Pilot(0, 9)
    const b = new Pilot(0, 9)
    const ia = neutralInput()
    const ib = neutralInput()
    const inputs = neutralInputs()
    for (let i = 0; i < 60; i++) {
      assert.equal(encodeInput(a.sample(sim, ia)), encodeInput(b.sample(sim, ib)), `sample ${i}`)
      decodeInput(encodeInput(ia), inputs[0])
      sim.step(inputs)
    }
  } finally {
    sim.free()
  }
})

test('a Pilot moves its human forward along the race course', () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  try {
    stepToPlaying(sim)
    const v = viewState()
    assert.equal(sim.phase(v).roundKind, 'race')
    const c = charView()
    const startZ = sim.character(0, c).pos.z
    const pilot = new Pilot(0, 5)
    const inputs = neutralInputs()
    const sampled = neutralInput()
    for (let i = 0; i < 300 && sim.phase(v).phase === Phase.playing; i++) {
      decodeInput(encodeInput(pilot.sample(sim, sampled)), inputs[0])
      sim.step(inputs)
    }
    const endZ = sim.character(0, c).pos.z
    assert.ok(endZ > startZ, `z ${startZ} -> ${endZ}`)
  } finally {
    sim.free()
  }
})
