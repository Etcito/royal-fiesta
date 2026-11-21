import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requirementProblems } from '../../../tools/engineCaptureJob.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'
import { readFileSync } from 'node:fs'
import { Rng } from '@gamesaloon/rollback'
import { parseSeason, playableMaps, schedMaps } from '../../../packages/game/src/season.ts'
import { advanceCursor, newCursor, nextSlot, type RoundSlot } from '../../../packages/sim/src/season/plan.ts'
import { candidates, newSchedule, type SchedMap } from '../../../packages/sim/src/season/scheduler.ts'

/** The seed whose seeded reserved final is map Q (Crown Confection); seeds 7..9 reserve I. */
const PODIUM_SEED = 10

function playableSeason() {
  const season = parseSeason(JSON.parse(readFileSync(new URL('../../../courses/season.json', import.meta.url), 'utf8')), 'courses/season.json')
  const built = playableMaps(season)
  // The same SchedMap fields showMaps (packages/game/src/net/zoneRounds.ts:88-93) gives the page.
  const catalog: SchedMap[] = schedMaps(season, built.map(map => ({ id: map.course }))).map(map => ({
    id: map.id, course: built.findIndex(other => other.course === map.course),
    kind: map.kind, finalRule: map.finalRule, stages: map.stages,
    team: map.teams !== null, cut: season.rules.cutMaps.includes(map.id),
  }))
  return { season, built, catalog }
}

/** Walks the reference cursor: a non-final slot qualifies its target, the final qualifies one seat. */
function slotSequence(plan: readonly number[], alive: number) {
  const slots: { stage: string, final: boolean, target: number }[] = []
  let cursor = newCursor(plan, alive)
  let slot: RoundSlot | null = nextSlot(cursor)
  while (slot !== null) {
    slots.push({ stage: slot.stage, final: slot.final, target: slot.target })
    cursor = advanceCursor(cursor, slot, slot.final ? 1 : slot.target, false)
    slot = nextSlot(cursor)
  }
  return slots
}

/** The facts a completed online scenario reports for row 1: two clients, one round, no desync. */
function roundFacts(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    membership: { checks: 1, duplicateSeatIds: [] },
    online: { clients: 2, humans: 2, bots: 58, sameRound: true, lateStartFrames: 30, backgroundFrames: 0, desyncs: 0, peerFaults: 0, ...overrides },
  }
}

/** The facts a completed online scenario reports for row 2: the background client, then the confirmed podium. */
function podiumFacts(progress: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    online: { clients: 2, humans: 2, bots: 58, sameRound: true, lateStartFrames: 0, backgroundFrames: 120, desyncs: 0, peerFaults: 0 },
    progress: { podiumConfirmed: true, confirmedWinner: 0, ...progress },
    effects: { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 },
  }
}

test('the online inventory holds the two capture rows in order through the shared validator', () => {
  const rows = showRows('online')
  assert.deepEqual(rows.map(row => row.id), ['engine-online-late-client-round', 'engine-online-background-client-podium'])
  assert.deepEqual(rows.map(row => row.filename), ['engine-online-late-client-round.png', 'engine-online-background-client-podium.png'])
  assert.deepEqual(rows[0].args, { scenario: 'engine-online-late-client-round', testMode: true, seed: 7, humans: 2 })
  assert.deepEqual(rows[1].args, { scenario: 'engine-online-background-client-podium', testMode: true, seed: PODIUM_SEED, humans: 2, plan: [60, 1] })
  assert.equal(rows[0].stage, 'online')
  assert.equal(rows[1].stage, 'online')
})

test('requirementProblems accepts a passing online fact object and names each failed online requirement', () => {
  const [round, podium] = showRows('online')
  assert.deepEqual(requirementProblems(roundFacts(), round.require), [])
  assert.deepEqual(requirementProblems(podiumFacts(), podium.require), [])
  const desynced = requirementProblems(roundFacts({ desyncs: 1 }), round.require)
  assert.ok(desynced.some(problem => problem.startsWith('online.desyncs eq 0')))
  const humans = requirementProblems(roundFacts({ humans: 1 }), round.require)
  assert.ok(humans.some(problem => problem.startsWith('online.humans eq 2')))
  const unconfirmed = requirementProblems(podiumFacts({ podiumConfirmed: false }), podium.require)
  assert.ok(unconfirmed.some(problem => problem.startsWith('progress.podiumConfirmed eq true')))
})

test('plan [60, 1] schedules a 60-seat cut to twelve, then a twelve-seat final, then nothing', () => {
  const slots = slotSequence([60, 1], 60)
  assert.deepEqual(slots, [
    { stage: 'cut', final: false, target: 12 },
    { stage: 'final', final: true, target: 1 },
  ])
  const cut = nextSlot(newCursor([60, 1], 60))
  assert.equal(cut?.stage, 'cut')
  const afterCut = advanceCursor(newCursor([60, 1], 60), cut!, 12, false)
  assert.equal(afterCut.alive, 12)
  assert.equal(nextSlot(afterCut)?.final, true)
  assert.equal(nextSlot(advanceCursor(afterCut, nextSlot(afterCut)!, 1, false)), null)
})

test('the only cut-eligible playable map is E, and its course caps at 60 seconds', () => {
  const { season, built, catalog } = playableSeason()
  const cutIds = season.rules.cutMaps.filter(id => built.some(map => map.id === id))
  assert.deepEqual(cutIds, ['E'])
  const cutSlot: RoundSlot = { stage: 'cut', final: false, target: 12, teamAllowed: false, playoff: false }
  const offered = candidates(catalog, cutSlot, newSchedule(catalog, new Rng(PODIUM_SEED)), new Rng(PODIUM_SEED))
  assert.deepEqual(offered, ['E'])
  assert.equal(built.find(map => map.id === 'E')?.timeCapS, 60)
})

test('seed 10 reserves the Crown Confection final (Q) for the background-client podium', () => {
  const { catalog } = playableSeason()
  assert.equal(newSchedule(catalog, new Rng(PODIUM_SEED)).finalMap, 'Q')
})

test('plans [60, 12, 1] and [60, 12] produce the same slot sequence', () => {
  assert.deepEqual(slotSequence([60, 12, 1], 60), slotSequence([60, 12], 60))
  assert.deepEqual(slotSequence([60, 12, 1], 60), [
    { stage: 'R1', final: false, target: 12 },
    { stage: 'final', final: true, target: 1 },
  ])
})
