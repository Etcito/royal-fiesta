import { Rng } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { levelOf } from '@royal-fiesta/sim/course'
import { advanceCursor, nextSlot } from '@royal-fiesta/sim/season/plan'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { RoundTransport } from './roundTransport.ts'
import { createZoneMatch } from './zoneMatch.ts'
import type { ZoneMatch, ZoneMatchConfig } from './zoneMatch.ts'
import {
  decodeRoundResult, encodeRoundResult, nextAlive, newShow, planZoneRound, roundCandidates, roundResultOf, roundRoster, sameRoundResult,
} from './zoneRounds.ts'
import type { ShowState, ZoneRoundPlan, ZoneRoundResult } from './zoneRounds.ts'

export interface ZoneFullMatchConfig {
  readonly localPeer: number
  readonly roster: Roster
  readonly seed: number
  readonly courses: readonly ResolvedCourse[]
  readonly season: readonly SchedMap[]
  readonly plan?: readonly number[]
  readonly zones: ReadonlyMap<string, ZonesFile>
  readonly measurements: ZoneMatchConfig['measurements']
  readonly farSink?: ZoneMatchConfig['farSink']
  readonly profile?: ProfileName
  readonly voteMs?: number
  readonly onVote?: (round: number, candidates: string[]) => void
  readonly intermissionMs?: number
}

export interface ZoneFullRound {
  readonly plan: ZoneRoundPlan
  readonly match: ZoneMatch
  readonly roster: Roster
  /** Room seat indexed by round seat. */
  readonly seatOf: readonly number[]
  /** Round seats in the same order as the sample callback's inputs. */
  readonly localSeats: readonly number[]
}

export interface ZoneFullMatchReport {
  readonly rounds: ZoneRoundResult[]
  champion: number | null
  desyncs: number
  malformed: number
  resultMismatches: number
}

export interface ZoneFullMatch {
  readonly show: ShowState
  readonly candidates: readonly string[] | null
  vote(choice: number): void
  /** Null while voting or when the local peer has no seats in this round. */
  readonly round: ZoneFullRound | null
  readonly alive: readonly number[]
  readonly done: boolean
  readonly champion: number | null
  readonly report: ZoneFullMatchReport
  frame(dtS: number, sample: (round: ZoneFullRound, out: PlayerInput[]) => void): number
  dispose(): void
}

/** Plays successive zone sessions over one room, retaining the room's peer and seat identities. */
export function createZoneFullMatch(R: RapierModule, cfg: ZoneFullMatchConfig, net: GroupTransport): ZoneFullMatch {
  const rt = new RoundTransport(net)
  const show = newShow(cfg.season, cfg.roster.seatCount, cfg.seed, cfg.plan)
  const rng = new Rng(show.schedule.rngState)
  const recipients = cfg.roster.peers.filter(p => p.peer !== cfg.localPeer).map(p => p.peer)
  const roomPeers = new Set(recipients)
  const scratch: Parameters<GroupTransport['drain']>[0] = []
  const report: ZoneFullMatchReport = {
    rounds: show.rounds, champion: null, desyncs: 0, malformed: 0, resultMismatches: 0,
  }
  // Result frames bypass the transport's round queue, so retain early results here too.
  const results = new Map<number, Map<number, ZoneRoundResult>>()
  let alive = Array.from({ length: cfg.roster.seatCount }, (_, seat) => seat)
  let r = 0
  let plan: ZoneRoundPlan
  let peers: readonly number[] = []
  let round: ZoneFullRound | null = null
  let own: ZoneRoundResult | null = null
  let settledAt: number | null = null
  let done = false
  let disposed = false
  let transportMalformed = 0
  const votes = new Map<number, Map<number, number>>()
  let candidates: string[] | null = null
  let votingAt: number | null = null
  let playoffPlan: ZoneRoundPlan | null = null
  let qualifiedBeforePlayoff: number[] = []
  let openingRecorded = false

  rt.onVote((peer, tag, choice) => {
    if (disposed || !roomPeers.has(peer)) return
    const delta = (tag - (r & 0xff)) & 0xff
    if (delta >= 128 || (delta === 0 && votingAt === null)) return
    let received = votes.get(r + delta)
    if (!received) votes.set(r + delta, received = new Map())
    received.set(peer, choice === 255 ? -1 : choice)
  })

  function vote(choice: number): void {
    if (disposed || votingAt === null || !candidates ||
        !Number.isInteger(choice) || choice < -1 || choice >= candidates.length) return
    let received = votes.get(r)
    if (!received) votes.set(r, received = new Map())
    received.set(cfg.localPeer, choice)
    rt.sendVote(recipients, choice)
  }

  function remember(index: number, peer: number, result: ZoneRoundResult): void {
    let received = results.get(index)
    if (!received) results.set(index, received = new Map())
    // Count a conflicting result once, even when it disagrees with several senders.
    for (const other of received.values()) {
      if (!sameRoundResult(result, other)) {
        report.resultMismatches++
        break
      }
    }
    // A sender cannot replace its first result after peers have already settled it.
    if (!received.has(peer)) received.set(peer, result)
  }

  rt.onResult((peer, tag, payload) => {
    if (disposed || !roomPeers.has(peer)) return
    const result = decodeRoundResult(payload)
    if (!result || result.index !== tag) {
      report.malformed++
      return
    }
    const delta = (tag - (r & 0xff)) & 0xff
    if (delta >= 128 || (delta === 0 && !peers.includes(peer))) return
    remember(result.index, peer, result)
  })

  function finish(): void {
    done = true
    report.champion = [...report.rounds].reverse().find(result => result.final && result.champion >= 0)?.champion ??
      (alive.length === 1 ? alive[0] : null)
  }

  function start(): void {
    rt.setRound(r)
    candidates = playoffPlan ? [playoffPlan.map] : roundCandidates(show, rng)
    votingAt = rt.now()
    peers = roundRoster(cfg.roster, alive).roster.peers.map(p => p.peer)
    own = null
    settledAt = null
    cfg.onVote?.(r, [...candidates])
    if ((cfg.voteMs ?? 5000) === 0 || candidates.length === 1) play(true)
  }

  function play(headless = false): void {
    const choices: number[] = []
    for (const peer of cfg.roster.peers) {
      if (!cfg.roster.live[peer.peer] || rt.closed(peer.peer)) continue
      for (const seat of peer.seats) if (alive.includes(seat)) choices.push(votes.get(r)?.get(peer.peer) ?? -1)
    }
    const offered = candidates!
    plan = playoffPlan ?? planZoneRound(cfg.courses, show, alive,
      { candidates: headless || !choices.some(choice => choice >= 0 && choice < offered.length) ? [offered[0]] : offered,
        votes: choices }, rng)
    playoffPlan = null
    candidates = null
    votingAt = null
    votes.delete(r)
    const { roster, seatOf } = roundRoster(cfg.roster, alive)
    peers = roster.peers.map(p => p.peer)
    const received = results.get(r)
    if (received) for (const peer of received.keys()) if (!peers.includes(peer)) received.delete(peer)
    own = null
    settledAt = null
    const local = roster.peers.find(p => p.peer === cfg.localPeer)
    if (!local) {
      round = null
      return
    }
    const course = cfg.courses[plan.courseIndex]
    const zones = cfg.zones.get(course.id)
    if (!zones) refuse('zones', 'createZoneFullMatch.zones', `missing sidecar for ${course.id}; load zones for every course`)
    const match = createZoneMatch(R, {
      localPeer: cfg.localPeer, roster, course, zones, profile: PROFILES[cfg.profile ?? 'sprint'],
      kind: plan.kind,
      slot: { kind: plan.kind, final: plan.final, finalRule: plan.finalRule, target: plan.target,
        playoff: plan.playoff, roundIndex: plan.index, seed: cfg.seed, teams: plan.teams,
        overtimeTicks: levelOf(course).overtimeTicks,
        openingRanks: Uint16Array.from(seatOf, seat => show.openingRanks[seat]) },
      measurements: cfg.measurements, farSink: cfg.farSink,
    }, rt)
    round = { plan, match, roster, seatOf, localSeats: local.seats }
  }

  function settle(): void {
    if (votingAt !== null || settledAt !== null || done || (round !== null && own === null)) return
    const received = results.get(r)
    for (const peer of peers) {
      if (peer !== cfg.localPeer && !rt.closed(peer) && !received?.has(peer)) return
    }
    // Prefer the local confirmed ledger; spectators choose in roster order.
    const result = own ?? peers.map(peer => received?.get(peer)).find(value => value !== undefined)
    if (!result) return
    report.rounds.push(result)
    if (round) {
      report.desyncs += round.match.stats.desyncs
      report.malformed += round.match.stats.malformed
    }
    if (!openingRecorded && plan.kind === 'race') {
      result.ranking.forEach((seat, rank) => { show.openingRanks[seat] = rank + 1 })
      openingRecorded = true
    }
    if (result.reason === 'playoff') {
      qualifiedBeforePlayoff.push(...result.qualified)
      // The wire omits the internal playoff list: disputed seats are neither qualified nor eliminated.
      alive = result.ranking.filter(seat => !result.qualified.includes(seat) && !result.eliminated.includes(seat))
      const target = plan.target - result.qualified.length
      const slot = { ...plan.slot, playoff: true, target, teamAllowed: false }
      show.cursor = advanceCursor(show.cursor, slot, alive.length, false)
      playoffPlan = { ...plan, index: show.cursor.roundIndex, slot, playoff: true, target, teams: null }
    } else {
      alive = nextAlive({ qualified: [...qualifiedBeforePlayoff, ...result.qualified] })
      qualifiedBeforePlayoff = []
      show.cursor = advanceCursor(show.cursor, plan.slot, alive.length, plan.teams !== null)
    }
    settledAt = rt.now()
    if (!playoffPlan && nextSlot(show.cursor) === null) finish()
  }

  if (alive.length <= 1) finish()
  else start()

  function neutral(out: PlayerInput[]): void {
    for (const input of out) decodeInput(NEUTRAL_CODE, input)
  }

  return {
    show,
    vote,
    get candidates() { return candidates },
    get round() { return round },
    get alive() { return alive },
    get done() { return done },
    get champion() { return report.champion },
    report,
    frame(dtS, sample) {
      if (disposed) return 0
      let ticks = 0
      const current = round
      if (current) {
        // Keep the old session acknowledging traffic throughout settlement and intermission.
        ticks = current.match.frame(dtS, own ? neutral : out => sample(current, out))
        // A rejoining local peer holds no ledger until its next boundary; the result waits for it.
        const ledger = current.match.currentLedger
        const result = ledger?.result
        if (!own && ledger !== null && ledger.over && result && current.match.stats.confirmedTick[0] >= result.endTick) {
          own = roundResultOf(plan, result, current.seatOf)
          remember(r, cfg.localPeer, own)
          rt.sendResult(recipients, encodeRoundResult(own))
        } else if (!own && ledger === null) {
          // A peer that replicates no global domain holds no ledger, so it adopts (and passes on) the result of the
          // first peer that has one; every peer settles on results from all open peers, so it must send one too.
          const received = results.get(r)
          const adopted = received === undefined ? undefined : peers.map(peer => received.get(peer)).find(value => value !== undefined)
          if (adopted !== undefined) {
            own = adopted
            remember(r, cfg.localPeer, own)
            rt.sendResult(recipients, encodeRoundResult(own))
          }
        }
      } else {
        rt.drain(scratch)
      }
      report.malformed += rt.malformed - transportMalformed
      transportMalformed = rt.malformed
      if (votingAt !== null && rt.now() - votingAt >= (cfg.voteMs ?? 5000)) play()
      settle()
      if (!done && settledAt !== null && rt.now() - settledAt >= (cfg.intermissionMs ?? 1500)) {
        current?.match.dispose()
        round = null
        results.delete(r)
        r++
        start()
      }
      return ticks
    },
    dispose() {
      if (disposed) return
      disposed = true
      round?.match.dispose()
      results.clear()
      votes.clear()
      scratch.length = 0
    },
  }
}
