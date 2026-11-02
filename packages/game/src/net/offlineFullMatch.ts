import { Rng } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { levelOf } from '@royal-fiesta/sim/course'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { advanceCursor, nextSlot } from '@royal-fiesta/sim/season/plan'
import { refuse } from '@royal-fiesta/sim/refusal'
import { createOfflineMatch } from './offlineMatch.ts'
import { newShow, nextAlive, planZoneRound, roundCandidates, roundResultOf } from './zoneRounds.ts'
import type { ZoneRoundPlan } from './zoneRounds.ts'
import type { ZoneFullMatch, ZoneFullMatchConfig, ZoneFullRound } from './zoneFullMatch.ts'

export type OfflineFullMatchConfig = Pick<ZoneFullMatchConfig,
  'seed' | 'courses' | 'zones' | 'season' | 'plan' | 'profile' | 'voteMs' | 'intermissionMs' | 'onVote'> & { seats: number }

/** Offline show ledger and scheduler: all surviving seats belong to one authoritative world. */
export function createOfflineFullMatch(R: RapierModule, cfg: OfflineFullMatchConfig): ZoneFullMatch {
  const show = newShow(cfg.season, cfg.seats, cfg.seed, cfg.plan)
  const rng = new Rng(show.schedule.rngState)
  const report: ZoneFullMatch['report'] = { rounds: show.rounds, champion: null, desyncs: 0, malformed: 0, resultMismatches: 0 }
  let alive = Array.from({ length: cfg.seats }, (_, i) => i)
  let round: ZoneFullRound | null = null
  let candidates: string[] | null = null
  let choice = -1
  let elapsed = 0
  let settled = false
  let done = alive.length <= 1
  let disposed = false
  let openingRecorded = false
  let playoff: ZoneRoundPlan | null = null
  let qualifiedBeforePlayoff: number[] = []

  function start(): void {
    candidates = playoff ? [playoff.map] : roundCandidates(show, rng)
    elapsed = 0
    choice = -1
    settled = false
    cfg.onVote?.(show.cursor.roundIndex, [...candidates])
    if ((cfg.voteMs ?? 5000) === 0 || candidates.length === 1) play()
  }
  function play(): void {
    const offered = candidates!
    const plan = playoff ?? planZoneRound(cfg.courses, show, alive,
      { candidates: choice < 0 ? [offered[0]] : offered, votes: [choice] }, rng)
    playoff = null
    candidates = null
    elapsed = 0
    const seatOf = [...alive].sort((a, b) => a - b)
    const seats = seatOf.map((_, i) => i)
    const roster = { seatCount: seats.length, peers: [{ peer: 0, seats }], live: [true] }
    const course = cfg.courses[plan.courseIndex]
    const zones = cfg.zones.get(course.id)
    if (!zones) refuse('show', 'offlineFullMatch.zones', `missing sidecar for ${course.id}`)
    const match = createOfflineMatch(R, { course, zones, profile: PROFILES[cfg.profile ?? 'sprint'],
      kind: plan.kind, seatCount: seats.length,
      slot: { kind: plan.kind, final: plan.final, finalRule: plan.finalRule, target: plan.target,
        playoff: plan.playoff, roundIndex: plan.index, seed: cfg.seed, teams: plan.teams,
        overtimeTicks: levelOf(course).overtimeTicks,
        openingRanks: Uint16Array.from(seatOf, seat => show.openingRanks[seat]) } })
    round = { plan, match, roster, seatOf, localSeats: seats }
  }
  function settle(): void {
    const current = round!
    const result = roundResultOf(current.plan, current.match.ledger.result!, current.seatOf)
    report.rounds.push(result)
    if (!openingRecorded && current.plan.kind === 'race') {
      result.ranking.forEach((seat, rank) => { show.openingRanks[seat] = rank + 1 })
      openingRecorded = true
    }
    if (result.reason === 'playoff') {
      qualifiedBeforePlayoff.push(...result.qualified)
      alive = result.ranking.filter(seat => !result.qualified.includes(seat) && !result.eliminated.includes(seat))
      const target = current.plan.target - result.qualified.length
      const slot = { ...current.plan.slot, playoff: true, target, teamAllowed: false }
      show.cursor = advanceCursor(show.cursor, slot, alive.length, false)
      playoff = { ...current.plan, index: show.cursor.roundIndex, slot, playoff: true, target, teams: null }
    } else {
      alive = nextAlive({ qualified: [...qualifiedBeforePlayoff, ...result.qualified] })
      qualifiedBeforePlayoff = []
      show.cursor = advanceCursor(show.cursor, current.plan.slot, alive.length, current.plan.teams !== null)
    }
    settled = true
    elapsed = 0
    if (!playoff && nextSlot(show.cursor) === null) {
      done = true
      report.champion = [...report.rounds].reverse().find(r => r.final && r.champion >= 0)?.champion ?? (alive.length === 1 ? alive[0] : null)
    }
  }
  if (!done) start()
  return {
    show, report,
    get candidates() { return candidates }, get round() { return round }, get alive() { return alive },
    get done() { return done }, get champion() { return report.champion },
    vote(value) { if (candidates && Number.isInteger(value) && value >= -1 && value < candidates.length) choice = value },
    frame(dtS, sample) {
      if (disposed || done) return 0
      const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
      elapsed += dt * 1000
      if (candidates) { if (elapsed >= (cfg.voteMs ?? 5000)) play(); return 0 }
      if (settled) {
        if (elapsed >= (cfg.intermissionMs ?? 1500)) { round?.match.dispose(); round = null; start() }
        return 0
      }
      const current = round!
      const steps = current.match.frame(dt, out => sample(current, out))
      if (current.match.ledger.over) settle()
      return steps
    },
    dispose() { if (!disposed) { disposed = true; round?.match.dispose() } },
  }
}
