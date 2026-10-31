import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { Roster } from '@gamesaloon/rollback/zones'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { LedgerResult } from '@royal-fiesta/sim/zones/ledger'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { takeoverInput } from '../src/net/takeoverBot.ts'
import { createZoneMatch } from '../src/net/zoneMatch.ts'
import type { ZoneMatch } from '../src/net/zoneMatch.ts'
import { ZoneLoopback } from '../src/net/zoneLoopback.ts'
import { FIESTA_ZONE_TUNING } from '../src/net/zoneTuning.ts'

const PEERS = 8
// Alternating 1 and 2 local seats: 12 seats in the match.
const SEATS_PER_PEER = [1, 2, 1, 2, 1, 2, 1, 2]
const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string) => readFile(new URL(rel, ROOT), 'utf8')

const R: RapierModule = await initRapier()

async function loadRaceSprint(): Promise<{ course: ResolvedCourse; zones: ZonesFile }> {
  const entries = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
  const course = courses.find(c => c.id === 'race-sprint')
  assert.ok(course, 'race-sprint fixture is resolved')
  const zones = await loadZonesFile(course.id, course, read)
  return { course, zones }
}

function makeRoster(): { roster: Roster; seatsByPeer: number[][] } {
  const peers: { peer: number; seats: number[] }[] = []
  const seatsByPeer: number[][] = []
  let seat = 0
  for (let p = 0; p < PEERS; p++) {
    const seats: number[] = []
    for (let i = 0; i < SEATS_PER_PEER[p]; i++) seats.push(seat++)
    peers.push({ peer: p, seats })
    seatsByPeer.push(seats)
  }
  return {
    roster: { seatCount: seat, peers, live: Array.from({ length: PEERS }, () => true) },
    seatsByPeer,
  }
}

interface Measurement {
  cpuMs: number
  bandwidthKbps: number
  latencyMs: number
  spareSlots: number
}

// cpu class 1 caps capacity at 4, so 12 connected seats always split into several seat domains.
function measurementsOf(): Record<number, Measurement> {
  const out: Record<number, Measurement> = {}
  for (let p = 0; p < PEERS; p++) {
    out[p] = { cpuMs: 1, bandwidthKbps: 128, latencyMs: 20 + p * 5, spareSlots: 2 }
  }
  return out
}

function copyResult(result: LedgerResult): LedgerResult {
  return {
    endTick: result.endTick,
    qualified: [...result.qualified],
    eliminated: [...result.eliminated],
    reason: result.reason,
    ranking: [...result.ranking],
    points: [...result.points],
    teamScores: [...result.teamScores],
    playoff: result.playoff === null ? null : [...result.playoff],
    champion: result.champion,
  }
}

test('zoneMatch: 8 peers finish one round with zero desyncs and identical ledgers', { timeout: 60000 }, async () => {
  const { course, zones } = await loadRaceSprint()
  const { roster, seatsByPeer } = makeRoster()
  const profile = PROFILES.sprint
  const measurements = measurementsOf()
  // Same link as netMatch.test.ts.
  const net = new ZoneLoopback(PEERS, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const matches: ZoneMatch[] = []
  const results: (LedgerResult | null)[] = Array.from({ length: PEERS }, () => null)
  const memories = seatsByPeer.map(seats => seats.map(() => newMemory()))
  const sampleTicks = new Int32Array(PEERS)
  const seatDomainIds = new Set<number>()
  let maxEpoch = 0
  try {
    for (let p = 0; p < PEERS; p++) {
      matches.push(createZoneMatch(R, {
        localPeer: p,
        roster,
        course,
        zones,
        profile,
        kind: 'race',
        measurements,
      }, net.transport(p)))
    }
    const capTicks = profile.introTicks + roundTicks(course, profile)
    const maxFrames = capTicks * 2 + 600
    for (let frame = 0; frame < maxFrames && results.some(r => r === null); frame++) {
      net.advance(1000 / 60)
      for (let p = 0; p < PEERS; p++) {
        const match = matches[p]
        const seats = seatsByPeer[p]
        const tick = sampleTicks[p]
        match.frame(1 / 60, out => {
          for (let i = 0; i < out.length; i++) {
            const seat = seats[i]
            const domain = match.domains.find(candidate => candidate.seats.includes(seat))
            if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
            else takeoverInput(course, memories[p][i], domain.state(seat), tick, out[i])
          }
        })
        sampleTicks[p]++
        const result = match.ledger.result
        if (results[p] === null && result !== null) results[p] = copyResult(result)
        const epoch = Math.floor(match.stats.tick / FIESTA_ZONE_TUNING.epochTicks)
        if (epoch > maxEpoch) maxEpoch = epoch
        if (epoch > 0) {
          for (const domain of match.domains) {
            if (domain.inner.spec.kind === 'seat') seatDomainIds.add(domain.inner.spec.id)
          }
        }
      }
    }

    assert.ok(maxEpoch > 0, `assignment reached an epoch boundary (epoch ${maxEpoch})`)
    assert.ok(seatDomainIds.size > 1,
      `an epoch boundary ran with more than one seat domain (saw ${[...seatDomainIds].join(',')})`)
    for (let p = 0; p < PEERS; p++) {
      assert.equal(matches[p].stats.desyncs, 0, `peer ${p} desyncs`)
      assert.notEqual(results[p], null, `peer ${p} finished the round`)
    }
    const first = results[0]!
    for (let p = 1; p < PEERS; p++) {
      assert.deepEqual(results[p], first, `peer ${p} ledger result`)
    }
  } finally {
    for (const match of matches) match.dispose()
  }
})
