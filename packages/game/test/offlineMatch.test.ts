import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { MatchLedger } from '@royal-fiesta/sim/zones/ledger'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import { createOfflineFullMatch } from '../src/net/offlineFullMatch.ts'
import { newModeBotMemory, modeBotInput } from '../src/net/modeBots.ts'
import { showMaps } from '../src/net/zoneRounds.ts'
const read = (path: string) => readFile(new URL('../../../' + path, import.meta.url), 'utf8')
const R = await initRapier()
const entries = await Promise.all(['race-sprint', 'survival-sprint'].map(async id => {
  const path = `fixtures/courses/${id}.course.json`
  return { path, json: JSON.parse(await read(path)) }
}))
const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
const zones = new Map(await Promise.all(courses.map(async c => [c.id, await loadZonesFile(c.id, c, read)] as const)))

test('offline: 60 seats use one world without snapshots or restore; fixed inputs and seed repeat across frame sizes', () => {
  const original = [FiestaDomain.prototype.snapshot, FiestaDomain.prototype.restore, MatchLedger.prototype.snapshot, MatchLedger.prototype.restore] as const
  const forbidden = () => { throw new Error('Offline simulation must never snapshot or restore') }
  FiestaDomain.prototype.snapshot = forbidden
  FiestaDomain.prototype.restore = forbidden
  MatchLedger.prototype.snapshot = forbidden
  MatchLedger.prototype.restore = forbidden
  function run(batch: number) {
    const full = createOfflineFullMatch(R, { seats: 60, seed: 3, courses, zones, season: showMaps(courses), voteMs: 0 })
    const memories = Array.from({ length: 60 }, newModeBotMemory)
    let samples = 0
    try {
      for (let tick = 0; tick < 600; tick += batch) full.frame(batch / 60, (round, out) => {
        const domain = round.match.domains[0]
        assert.equal(round.match.worlds, 1)
        assert.equal(out.length, 60)
        for (let seat = 0; seat < out.length; seat++) {
          if (seat === 0) decodeInput(NEUTRAL_CODE, out[seat])
          else modeBotInput(domain, memories[seat], seat, domain.tick, out[seat])
        }
        samples++
      })
      const match = full.round!.match
      assert.equal(samples, 600)
      assert.equal(match.stats.tick, 600)
      assert.equal(match.stats.resimTicks, 0)
      assert.equal(match.stats.rollbacks, 0)
      return { physics: structuredClone(Array.from({ length: 60 }, (_, seat) => match.domains[0].state(seat))),
        result: match.ledger.result, statuses: Array.from({ length: 60 }, (_, seat) => match.ledger.status(seat)) }
    } finally { full.dispose() }
  }
  try { assert.deepEqual(run(1), run(3)) }
  finally {
    FiestaDomain.prototype.snapshot = original[0]
    FiestaDomain.prototype.restore = original[1]
    MatchLedger.prototype.snapshot = original[2]
    MatchLedger.prototype.restore = original[3]
  }
})

test('offline: the complete show repeats its rounds and champion for the same seed', () => {
  function run() {
    const full = createOfflineFullMatch(R, { seats: 12, seed: 3, courses, zones, season: showMaps(courses), voteMs: 0, intermissionMs: 0 })
    let memories = Array.from({ length: 12 }, newModeBotMemory)
    let index = -1
    try {
      for (let frame = 0; frame < 30000 && !full.done; frame++) full.frame(1 / 60, (round, out) => {
        if (round.plan.index !== index) {
          index = round.plan.index
          memories = Array.from({ length: 12 }, newModeBotMemory)
        }
        const domain = round.match.domains[0]
        for (let seat = 0; seat < out.length; seat++) {
          const roomSeat = round.seatOf[seat]
          if (roomSeat === 0) decodeInput(NEUTRAL_CODE, out[seat])
          else modeBotInput(domain, memories[roomSeat], seat, domain.tick, out[seat])
        }
      })
      assert.ok(full.done, 'show must reach its champion')
      assert.ok(full.report.rounds.length > 1)
      assert.notEqual(full.champion, null)
      return { rounds: full.report.rounds, champion: full.champion }
    } finally { full.dispose() }
  }
  assert.deepEqual(run(), run())
})
