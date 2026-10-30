import { Rng } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { RoundTransport } from './roundTransport.ts'
import { createZoneMatch } from './zoneMatch.ts'
import type { ZoneMatch, ZoneMatchConfig } from './zoneMatch.ts'
import {
  decodeRoundResult, encodeRoundResult, nextAlive, planZoneRound, roundResultOf, roundRoster, sameRoundResult,
} from './zoneRounds.ts'
import type { ZoneRoundPlan, ZoneRoundResult } from './zoneRounds.ts'

export interface ZoneFullMatchConfig {
  readonly localPeer: number
  readonly roster: Roster
  readonly seed: number
  readonly courses: readonly ResolvedCourse[]
  readonly zones: ReadonlyMap<string, ZonesFile>
  readonly measurements: ZoneMatchConfig['measurements']
  readonly farSink?: ZoneMatchConfig['farSink']
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
  /** Null when the local peer has no remaining seats. */
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
  const rng = new Rng(cfg.seed)
  const recipients = cfg.roster.peers.filter(p => p.peer !== cfg.localPeer).map(p => p.peer)
  const roomPeers = new Set(recipients)
  const scratch: Parameters<GroupTransport['drain']>[0] = []
  const report: ZoneFullMatchReport = {
    rounds: [], champion: null, desyncs: 0, malformed: 0, resultMismatches: 0,
  }
  // Result frames bypass the transport's round queue, so retain early results here too.
  const results = new Map<number, Map<number, ZoneRoundResult>>()
  let alive = Array.from({ length: cfg.roster.seatCount }, (_, seat) => seat)
  let lastCourse = -1
  let r = 0
  let plan: ZoneRoundPlan
  let peers: readonly number[] = []
  let round: ZoneFullRound | null = null
  let own: ZoneRoundResult | null = null
  let settledAt: number | null = null
  let done = false
  let disposed = false
  let transportMalformed = 0

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
    report.champion = alive.length === 1 ? alive[0] : null
  }

  function start(): void {
    rt.setRound(r)
    plan = planZoneRound(cfg.courses, r, alive, lastCourse, rng)
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
      localPeer: cfg.localPeer, roster, course, zones, profile: PROFILES.sprint,
      kind: plan.kind, measurements: cfg.measurements, farSink: cfg.farSink,
    }, rt)
    round = { plan, match, roster, seatOf, localSeats: local.seats }
  }

  function settle(): void {
    if (settledAt !== null || done || (round !== null && own === null)) return
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
    alive = nextAlive(result)
    lastCourse = plan.courseIndex
    settledAt = rt.now()
    if (plan.final || alive.length <= 1) finish()
  }

  if (alive.length <= 1) finish()
  else start()

  function neutral(out: PlayerInput[]): void {
    for (const input of out) decodeInput(NEUTRAL_CODE, input)
  }

  return {
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
      scratch.length = 0
    },
  }
}
