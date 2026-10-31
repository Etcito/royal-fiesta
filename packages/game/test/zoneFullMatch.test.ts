import { showMaps } from '../src/net/zoneRounds.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { Roster } from '@gamesaloon/rollback/zones'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { takeoverInput } from '../src/net/takeoverBot.ts'
import { createZoneFullMatch } from '../src/net/zoneFullMatch.ts'
import type { ZoneFullMatch } from '../src/net/zoneFullMatch.ts'
import { ZoneLoopback } from '../src/net/zoneLoopback.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string) => readFile(new URL(rel, ROOT), 'utf8')
const R = await initRapier()

test('zoneFullMatch: every peer reports the same race and survival final', async () => {
  const entries = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
  const zones = new Map<string, ZonesFile>()
  for (const course of courses) zones.set(course.id, await loadZonesFile(course.id, course, read))

  const roster: Roster = {
    seatCount: 4,
    peers: [{ peer: 0, seats: [0, 1] }, { peer: 1, seats: [2, 3] }],
    live: [true, true],
  }
  const measurements = {
    0: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
    1: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
  }
  const net = new ZoneLoopback(2, { seed: 1, rttMs: 40, jitterMs: 5, loss: 0 })
  const matches: ZoneFullMatch[] = []
  // Index memories by room seat; round seats are renumbered after elimination.
  const memories = Array.from({ length: roster.seatCount }, () => newMemory())
  const roundIndices = [-1, -1]
  const sampleTicks = [0, 0]
  try {
    for (let p = 0; p < 2; p++) {
      matches.push(createZoneFullMatch(R, {
        localPeer: p, roster, seed: 7, courses, season: showMaps(courses), plan: [4, 2, 1], zones, measurements,
      }, net.transport(p)))
    }
    for (let frame = 0; frame < 9000 && matches.some(match => !match.done); frame++) {
      net.advance(1000 / 60)
      for (let p = 0; p < matches.length; p++) {
        matches[p].frame(1 / 60, (round, out) => {
          if (roundIndices[p] !== round.plan.index) {
            roundIndices[p] = round.plan.index
            sampleTicks[p] = 0
            for (const seat of roster.peers[p].seats) memories[seat] = newMemory()
          }
          for (let i = 0; i < out.length; i++) {
            const seat = round.localSeats[i]
            const domain = round.match.domains.find(candidate => candidate.seats.includes(seat))
            if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
            else takeoverInput(round.plan.course, memories[round.seatOf[seat]],
              domain.state(seat), sampleTicks[p], out[i])
          }
        })
        sampleTicks[p]++
      }
    }

    for (let p = 0; p < matches.length; p++) {
      assert.equal(matches[p].done, true, `peer ${p} completed the match`)
      assert.equal(matches[p].report.desyncs, 0, `peer ${p} desyncs`)
      assert.equal(matches[p].report.resultMismatches, 0, `peer ${p} result mismatches`)
    }
    assert.deepStrictEqual(matches[0].report, matches[1].report)
    const { rounds, champion } = matches[0].report
    assert.equal(rounds.length, 2, 'four seats play a race then the final')
    assert.equal(rounds[0].kind, 'race')
    assert.equal(rounds[0].course, 'race-sprint')
    const final = rounds[rounds.length - 1]
    assert.equal(final.final, true)
    assert.equal(final.kind, 'final')
    assert.equal(final.course, 'survival-sprint')
    assert.ok(champion === null || final.qualified.includes(champion))
  } finally {
    for (const match of matches) match.dispose()
  }
})
