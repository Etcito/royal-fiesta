import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { Roster } from '@gamesaloon/rollback/zones'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { modeBotInput, newModeBotMemory } from '../src/net/modeBots.ts'
import type { ModeBotMemory } from '../src/net/modeBots.ts'
import { createZoneFullMatch } from '../src/net/zoneFullMatch.ts'
import type { ZoneFullMatch } from '../src/net/zoneFullMatch.ts'
import { sameRoundResult, showMaps } from '../src/net/zoneRounds.ts'
import type { ZoneRoundResult } from '../src/net/zoneRounds.ts'
import { ZoneLoopback } from '../src/net/zoneLoopback.ts'

const ROOT = new URL('../../../', import.meta.url)
const READ = (rel: string) => readFile(new URL(
  rel.startsWith('courses/') ? rel.replace('courses/', 'fixtures/test-courses/') : rel, ROOT), 'utf8')
const R = await initRapier()
const PEERS = 2
const SEATS = 2
const SEED = 3
const PLAN = [4, 2, 1] as const
const INTERMISSION_MS = 1500

function assertQualified(round: ZoneRoundResult, target: number): void {
  assert.ok(Number.isInteger(target) && target > 0, `round ${round.index} has its planned target`)
  const entrants = round.ranking.length
  if (round.final) {
    assert.equal(round.qualified.length, Math.min(target, entrants),
      `final ${round.index} crowns its one survivor (target ${target})`)
    assert.ok(round.qualified.includes(round.champion), `final ${round.index} champion qualified`)
    return
  }
  if (round.kind === 'race') {
    assert.equal(round.qualified.length, Math.min(target, entrants),
      `race ${round.index} qualifies its target (${target})`)
    return
  }
  if (round.kind === 'survival') {
    const alive = entrants - round.eliminated.length
    assert.ok(round.qualified.length <= target || round.qualified.length === alive,
      `survival ${round.index} qualifies at most ${target}, or every survivor after overtime`)
    return
  }
  assert.ok(round.qualified.length > 0 && round.qualified.length <= Math.max(1, target),
    `${round.kind} ${round.index} qualifies its target (${target})`)
}

test('zoneSeasonLoopback: two peers and their bots play a show to a champion', { timeout: 120_000 }, async () => {
  const entries = []
  for (const id of ['test-flat-race', 'test-flat-survival']) {
    const path = `courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await READ(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(READ), 'sprint')
  const season = showMaps(courses)
  const zones = new Map<string, ZonesFile>()
  for (const course of courses) zones.set(course.id, await loadZonesFile(course.id, course, READ))

  const roster: Roster = {
    seatCount: PEERS * SEATS,
    peers: [
      { peer: 0, seats: [0, 1] },
      { peer: 1, seats: [2, 3] },
    ],
    live: [true, true],
  }
  const measurements = {
    0: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
    1: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
  }
  const net = new ZoneLoopback(PEERS, { seed: SEED, rttMs: 40, jitterMs: 5, loss: 0 })
  const matches: ZoneFullMatch[] = []
  const memories: ModeBotMemory[] = Array.from({ length: roster.seatCount }, () => newModeBotMemory())
  const sampleTicks = [0, 0]
  const targets: number[] = []
  try {
    for (let p = 0; p < PEERS; p++) {
      matches.push(createZoneFullMatch(R, {
        localPeer: p, roster, seed: SEED, courses, season, voteMs: 0, profile: 'sprint',
        plan: PLAN, zones, measurements, intermissionMs: INTERMISSION_MS,
      }, net.transport(p)))
    }

    const capTicks = Math.max(...courses.map(course => roundTicks(course, PROFILES.sprint)))
    const introTicks = PROFILES.sprint.introTicks
    const intermissionTicks = Math.ceil((INTERMISSION_MS / 1000) * 60)
    const maxFrames = (PLAN.length - 1) * (capTicks + introTicks + intermissionTicks) * 2
    for (let frame = 0; frame < maxFrames && matches.some(match => !match.done); frame++) {
      net.advance(1000 / 60)
      for (let p = 0; p < PEERS; p++) {
        const match = matches[p]
        const current = match.round
        if (current) targets[current.plan.index] = current.plan.target
        match.frame(1 / 60, (round, out) => {
          const survivor = round.plan.final && round.plan.finalRule === 'lastStanding'
            ? Math.min(...match.alive) : -1
          for (let i = 0; i < out.length; i++) {
            const roundSeat = round.localSeats[i]
            const domain = round.match.domains.find(candidate => candidate.seats.includes(roundSeat))
            if (domain === undefined) {
              decodeInput(NEUTRAL_CODE, out[i])
              continue
            }
            modeBotInput(domain, memories[round.seatOf[roundSeat]], roundSeat, sampleTicks[p], out[i])
            // The flat survival fixture has no hazard: one bot walks off so lastStanding can crown.
            if (survivor >= 0 && round.seatOf[roundSeat] !== survivor) {
              decodeInput(NEUTRAL_CODE, out[i])
              const pos = domain.state(roundSeat).pos
              out[i].moveX = pos.x >= 0 ? 1 : -1
              out[i].moveZ = pos.z >= 0 ? 1 : -1
            }
          }
        })
        sampleTicks[p]++
      }
    }

    for (let p = 0; p < PEERS; p++) {
      assert.equal(matches[p].done, true, `peer ${p} completed the show within ${maxFrames} frames`)
      assert.equal(matches[p].report.resultMismatches, 0, `peer ${p} result mismatches`)
      assert.equal(matches[p].report.desyncs, 0, `peer ${p} desyncs`)
      const champion = matches[p].champion
      assert.ok(champion !== null && champion >= 0, `peer ${p} has a champion`)
    }
    assert.equal(matches[0].champion, matches[1].champion, 'both peers report the same champion')

    const first = matches[0].report.rounds
    const second = matches[1].report.rounds
    assert.equal(first.length, second.length, 'both peers report the same round count')
    for (let i = 0; i < first.length; i++) {
      assert.ok(sameRoundResult(first[i], second[i]), `round ${i} matches on both peers`)
      assertQualified(first[i], targets[first[i].index])
    }
    const last = first[first.length - 1]
    assert.equal(last.final, true, 'the last round is final')
    assert.equal(last.kind, 'final', 'the last round uses the final kind')
    assert.equal(last.champion, matches[0].champion, 'the final crowns the reported champion')
  } finally {
    for (const match of matches) match.dispose()
  }
})
