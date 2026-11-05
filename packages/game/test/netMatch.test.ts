import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadCourse } from '../src/course.ts'
import { botsLine } from '../src/hub/lobby.ts'
import { PlayFlow } from '../src/hub/flow.ts'
import { LoopbackRelay } from '../src/net/loopbackRelay.ts'
import { createOnlineMatch, onlineRoster } from '../src/net/onlineMatch.ts'
import type { OnlineMatch } from '../src/net/onlineMatch.ts'
import { globalWsFactory } from '../src/net/ws.ts'
import { RELAY_MAX_PLAYERS } from '../src/net/relayProtocol.ts'
import { NET_PLAYERS, netSetup } from '../src/net/tuning.ts'
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
import { FIESTA_TUNING, CLASSIC_NET_PLAYERS, classicNetSetup } from '../src/net/tuning.ts'

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
  return Array.from({ length: CLASSIC_NET_PLAYERS }, () => neutralInput())
}

// Steps with neutral inputs until the first round is playing.
function stepToPlaying(sim: MatchSim): void {
  const v = viewState()
  const inputs = neutralInputs()
  for (let i = 0; i < 10000 && sim.phase(v).phase !== Phase.playing; i++) sim.step(inputs)
  assert.equal(v.phase, Phase.playing)
}

test('classic FIESTA_TUNING holds the contract values and CLASSIC_NET_PLAYERS is 8', () => {
  assert.deepEqual({ ...FIESTA_TUNING }, {
    tickRate: 60, maxSubsteps: 8, maxPrediction: 16, snapshotRing: 40, minDelay: 2, maxDelay: 2,
    delayHiddenTicks: 6, lostAfterMs: 3000, dropWaitMs: 1500,
  })
  assert.ok(Object.isFrozen(FIESTA_TUNING))
  assert.equal(CLASSIC_NET_PLAYERS, 8)
})

test('classicNetSetup gives 8 players with humans first and refuses bad humanPeers', () => {
  const s = classicNetSetup(11, 3, 'sprint', courses)
  assert.equal(s.playerCount, 8)
  assert.equal(s.seed, 11)
  assert.equal(s.profile, 'sprint')
  assert.deepEqual([...s.humans], [true, true, true, false, false, false, false, false])
  for (const bad of [0, 9, 1.5]) {
    assert.throws(() => classicNetSetup(11, bad, 'sprint', courses), isRefusal, `humanPeers ${bad}`)
  }
})

test('createNetMatch refuses a setup that does not match the peers', () => {
  const net = new NetSim(2, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const s = classicNetSetup(11, 2, 'sprint', courses)
  assert.throws(() => createNetMatch(R, { setup: { ...s, playerCount: 4, humans: s.humans.slice(0, 4) }, localPeer: 0, humanPeers: 2 },
    net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: 2, humanPeers: 2 }, net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: -1, humanPeers: 2 }, net.transport(0)), isRefusal)
  assert.throws(() => createNetMatch(R, { setup: s, localPeer: 0, humanPeers: 3 }, net.transport(0)), isRefusal)
})

test('two peers on NetSim agree on every confirmed hash with delay 2', () => {
  const PEERS = 2
  const netsim = new NetSim(PEERS, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const setup = classicNetSetup(7, PEERS, 'sprint', courses)
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
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
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
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
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
  const sim = createMatchSim(R, classicNetSetup(5, 1, 'sprint', courses))
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

// The lobby uses zone rollback; the classic MatchSim tests above retain its explicit eight-seat diagnostic setup.
const onlineZones = new Map(await Promise.all(courses.map(async course =>
  [course.id, await loadZonesFile(course.id, course, read)] as const)))

test('online setup fills 60 seats after the relay humans, without increasing the relay cap', () => {
  assert.equal(NET_PLAYERS, 60)
  for (const humans of [1, 2, RELAY_MAX_PLAYERS]) {
    const setup = netSetup(7, humans, 'sprint', courses)
    assert.equal(setup.playerCount, 60)
    assert.deepEqual(setup.humans, Array.from({ length: 60 }, (_, seat) => seat < humans))
    const roster = onlineRoster(humans)
    assert.equal(roster.peers.length, humans)
    assert.deepEqual(roster.peers.flatMap(peer => peer.seats).sort((a, b) => a - b), Array.from({ length: 60 }, (_, seat) => seat))
  }
  for (const humans of [0, RELAY_MAX_PLAYERS + 1, 1.5]) assert.throws(() => netSetup(7, humans, 'sprint', courses), isRefusal)
  assert.equal(botsLine(1), '59 bots will fill the empty places')
  assert.equal(botsLine(2), '58 bots will fill the empty places')
})

test('online solo lobby fills 59 deterministic bots in bounded Rapier domains and completes the show', async () => {
  const realNow = performance.now.bind(performance)
  let clock = 0
  performance.now = () => clock
  const relay = new LoopbackRelay({ seed: 7, lobby: { waitMs: 100 } })
  const costs: number[] = []
  const failures: unknown[] = []
  const plazaPath = 'fixtures/courses/hub-plaza.course.json'
  const plaza = await loadCourse(JSON.parse(await read(plazaPath)), plazaPath, fixtureResolver(read))
  const flow = new PlayFlow({ R, relayUrl: 'loopback', ws: relay.factory(), hubCode: 'new', name: 'Human', colour: 0,
    courses, zones: onlineZones, plaza, partySize: 4, now: () => clock, pilot: false, matchmaking: 'lobby',
    log: ev => { if (ev.state === 'failed') failures.push(ev.detail) } })
  let match: OnlineMatch | null = null
  let moved = false
  let initial: number | null = null
  try {
    await flow.start()
    for (let frame = 0; frame < 18000; frame++) {
      clock += 1000 / 60
      const start = realNow()
      flow.frame(1 / 60, null, 0)
      if (flow.match) {
        match = flow.match
        costs.push(realNow() - start)
        assert.equal(match.sim.setup.playerCount, 60)
        const round = match.full.round
        if (round?.plan.index === 0) {
          const z = match.sim.character(59, charView()).pos.z
          if (initial === null) initial = z
          if (z > initial + 1) moved = true
        }
        assert.ok(match.zones.domains.every(domain => domain.seats.length <= 8))
        assert.ok(match.zones.worlds <= match.zones.heldStates)
        if (match.full.done) break
      }
      relay.pump()
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(failures, [])
    }
    assert.ok(match?.full.done, 'solo show completes')
    assert.ok(moved, 'bot 59 moves from its spawn')
    assert.equal(match.log().playerCount, 60)
    assert.equal(match.log().humans.filter(Boolean).length, 1)
    assert.ok(match.full.report.rounds.length > 1, 'elimination progresses to a final')
    assert.ok(match.full.report.rounds.at(-1)?.final)
    assert.equal(match.session.stats.desyncs, 0)
    costs.sort((a, b) => a - b)
    console.log(JSON.stringify({ online60solo: { humans: 1, bots: 59, rounds: match.full.report.rounds.length,
      frameSimMsMean: costs.reduce((a, b) => a + b, 0) / costs.length,
      frameSimMsP99: costs[Math.floor(costs.length * .99)], rollbacks: match.session.stats.rollbacks,
      desyncs: match.session.stats.desyncs } }))
  } finally {
    flow.close()
    relay.pump()
    performance.now = realNow
  }
})

test('two lobby clients finish the same 60-seat zone show over a relay with equal confirmed domain hashes', { timeout: 180000 }, async () => {
  const realNow = performance.now.bind(performance)
  let clock = 0
  performance.now = () => clock
  const relay = new LoopbackRelay({ seed: 7, lobby: { waitMs: 100 } })
  const flows: PlayFlow[] = []
  const hashes = [new Map<string, number>(), new Map<string, number>()]
  const costs: number[] = []
  const wallStart = realNow()
  const relayUrl = process.env.RF_ONLINE_RELAY
  if (relayUrl) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(relayUrl).hostname), 'runs use a local relay only')
  const realtime = process.env.RF_ONLINE_REALTIME === '1' || relayUrl !== undefined
  if (relayUrl) performance.now = realNow
  let finalLogs: string[] = []
  let counters: Record<string, number>[] = []
  let maxDomains = 0
  const failures: unknown[] = []
  let binaryFrames = 0
  const entries: Record<string, unknown>[] = []
  const factory = relayUrl ? globalWsFactory() : relay.factory()
  try {
    const plazaPath = 'fixtures/courses/hub-plaza.course.json'
    const plaza = await loadCourse(JSON.parse(await read(plazaPath)), plazaPath, fixtureResolver(read))
    for (let peer = 0; peer < 2; peer++) {
      flows.push(new PlayFlow({ R, relayUrl: relayUrl ?? 'loopback', ws: url => {
          const socket = factory(url)
          const send = socket.send.bind(socket)
          socket.send = data => {
            if (typeof data === 'string') {
              const frame = JSON.parse(data) as Record<string, unknown>
              assert.notEqual(frame.t, 'act', 'online traffic uses binary zones')
              if (frame.t === 'lobby_enter') entries.push(frame)
            } else binaryFrames++
            send(data)
          }
          return socket
        }, hubCode: 'new', name: `Human ${peer}`,
        colour: peer, courses, zones: onlineZones, plaza, partySize: 4, now: () => clock, pilot: true,
        matchmaking: 'lobby', log: ev => { if (ev.state === 'failed') failures.push(ev.detail) } }))
    }
    await Promise.all(flows.map(flow => flow.start()))
    for (let frame = 0; frame < 18000; frame++) {
      if (realtime) await new Promise(resolve => setTimeout(resolve, Math.max(0, wallStart + (frame + 1) * 1000 / 60 - realNow())))
      clock = relayUrl ? realNow() : clock + 1000 / 60
      relay.pump()
      for (let peer = 0; peer < flows.length; peer++) {
        const start = realNow()
        flows[peer].frame(1 / 60, null, 0)
        if (flows[peer].match) costs.push(realNow() - start)
        const match = flows[peer].match as OnlineMatch | null
        if (!match) continue
        assert.equal(match.sim.setup.playerCount, 60)
        assert.equal(match.sim.setup.humans.filter(Boolean).length, 2)
        maxDomains = Math.max(maxDomains, match.zones.domains.length)
        // Include all shared physics domains and the global ledger, across epoch handoffs.
        for (const id of [0, ...match.zones.domains.map(domain => domain.inner.spec.id)]) {
          const confirmed = match.zones.stats.confirmedTick[id] ?? -1
          for (let tick = Math.max(0, confirmed - 12); tick <= confirmed; tick++) {
            const hash = match.zones.confirmedHash(id, tick)
            if (hash !== undefined) hashes[peer].set(`${match.full.round?.plan.index ?? -1}:${id}:${tick}`, hash)
          }
        }
        if (match.full.done) {
          finalLogs[peer] = JSON.stringify(match.log())
          counters[peer] = { tick: match.session.stats.tick, rollbacks: match.session.stats.rollbacks,
            resimTicks: match.session.stats.resimTicks, desyncs: match.session.stats.desyncs, stalls: match.session.stats.stallFrames,
            rounds: match.full.report.rounds.length, malformed: match.full.report.malformed, resultMismatches: match.full.report.resultMismatches }
        }
      }
      relay.pump()
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(failures, [])
      if (finalLogs[0] && finalLogs[1]) break
    }
    assert.ok(finalLogs[0] && finalLogs[1], `both clients finished: ${JSON.stringify(flows.map(f => ({state:f.state, rounds:f.match?.full.report.rounds.length, stats:f.match?.zones.stats})))}`)
    assert.equal(finalLogs[0], finalLogs[1])
    assert.ok(binaryFrames > 0)
    assert.equal(entries.length, 2)
    assert.ok(entries.every(frame => frame.zones === true && frame.game === 'royal-fiesta' && frame.seats === 4))
    let compared = 0, physicsCompared = 0
    for (const [key, hash] of hashes[0]) {
      if (!hashes[1].has(key)) continue
      assert.equal(hashes[1].get(key), hash, `domain:tick ${key}`)
      compared++
      if (key.split(':')[1] !== '0') physicsCompared++
    }
    assert.ok(physicsCompared > 500, `compared ${physicsCompared} physics domain hashes`)
    assert.ok(maxDomains > 1)
    assert.ok(counters.every(stats => stats.desyncs === 0 && stats.resultMismatches === 0 && stats.rounds > 1))
    costs.sort((a, b) => a - b)
    console.log(JSON.stringify({ online60: { realtime, relay: relayUrl ?? 'LoopbackRelay', humans: 2, bots: 58, compared, physicsCompared, maxDomains, binaryFrames,
      frameSimMsMean: costs.reduce((a, b) => a + b, 0) / costs.length,
      frameSimMsP99: costs[Math.floor(costs.length * 0.99)], frameSimMsMax: costs.at(-1),
      wallMs: realNow() - wallStart, counters } }))
  } finally {
    for (const flow of flows) flow.close()
    relay.pump()
    performance.now = realNow
  }
})
