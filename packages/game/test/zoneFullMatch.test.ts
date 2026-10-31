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

for (const voteMs of [0, 300]) test(`zoneFullMatch: every peer reports the same show (voteMs ${voteMs})`, async () => {
  const entries = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
  const season = showMaps(courses)
  if (voteMs > 0) {
    const race = season.find(map => map.kind === 'race')!
    season.push({ ...race, id: 'race-choice-2' }, { ...race, id: 'race-choice-3' })
  }
  const offered: string[][] = []
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
        localPeer: p, roster, seed: 7, courses, season, voteMs,
        onVote: (index, candidates) => { if (index === 0) offered[p] = candidates }, plan: [4, 2, 1], zones, measurements,
      }, net.transport(p)))
    }
    for (let frame = 0; frame < 9000 && matches.some(match => !match.done); frame++) {
      net.advance(1000 / 60)
      for (let p = 0; p < matches.length; p++) {
        if (matches[p].candidates && matches[p].candidates!.length > 1) matches[p].vote(1)
        matches[p].frame(1 / 60, (round, out) => {
          if (roundIndices[p] !== round.plan.index) {
            roundIndices[p] = round.plan.index
            sampleTicks[p] = 0
            for (const seat of roster.peers[p].seats) memories[seat] = newMemory()
          }
          for (let i = 0; i < out.length; i++) {
            const seat = round.localSeats[i]
            if (round.plan.final) {
              decodeInput(NEUTRAL_CODE, out[i])
              // Keep one finalist on the platform; the other walks off to settle lastStanding.
              // The voting case first reaches the cap, exercising a same-map playoff.
              if (seat !== 0 && (voteMs === 0 || round.plan.playoff)) out[i].moveZ = 1
              continue
            }
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
    assert.equal(rounds.length, voteMs === 0 ? 2 : 3, 'race, final, and an optional playoff')
    if (voteMs > 0) {
      assert.equal(rounds[1].reason, 'playoff')
      assert.equal(rounds[2].playoff, true)
      assert.equal(rounds[2].map, rounds[1].map)
    }
    assert.deepStrictEqual(offered[0], offered[1])
    assert.equal(rounds[0].map, offered[0][voteMs > 0 ? 1 : 0])
    assert.deepStrictEqual(Array.from(matches[0].show.openingRanks), Array.from(matches[1].show.openingRanks))
    rounds[0].ranking.forEach((seat, rank) => assert.equal(matches[0].show.openingRanks[seat], rank + 1))
    assert.equal(rounds[0].kind, 'race')
    assert.equal(rounds[0].course, 'race-sprint')
    const final = rounds[rounds.length - 1]
    assert.equal(final.final, true)
    assert.equal(final.kind, 'final')
    assert.equal(final.course, 'survival-sprint')
    assert.equal(champion, final.champion)
    assert.ok(champion !== null && final.qualified.includes(champion))
  } finally {
    for (const match of matches) match.dispose()
  }
})
