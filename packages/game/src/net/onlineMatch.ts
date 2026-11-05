import { fnv1a32, hex8 } from '@gamesaloon/rollback'
import type { NetStats } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { MatchLog } from '@royal-fiesta/sim/match/log'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES, setupHash } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { DomainSceneSim } from '../render/domainSceneSim.ts'
import { FarFeed } from './farFeed.ts'
import type { NetMatch, NetMatchConfig } from './netMatch.ts'
import { RELAY_MAX_PLAYERS } from './relayProtocol.ts'
import { NET_PLAYERS } from './tuning.ts'
import { createZoneFullMatch } from './zoneFullMatch.ts'
import type { ZoneFullMatch, ZoneFullRound } from './zoneFullMatch.ts'
import type { ZoneMatch } from './zoneMatch.ts'
import { encodeRoundResult, showMaps } from './zoneRounds.ts'

export interface OnlineMatch extends NetMatch {
  readonly full: ZoneFullMatch
  readonly feed: FarFeed
  /** Current round, or the last round during voting / after elimination; null during the opening vote. */
  readonly zones: ZoneMatch | null
}

/** Humans keep their lobby seat numbers; deterministic bots fill the room to 60. */
export function onlineRoster(humans: number): Roster {
  if (!Number.isInteger(humans) || humans < 1 || humans > RELAY_MAX_PLAYERS) {
    refuse('net', 'onlineRoster.humans', `supply 1..${RELAY_MAX_PLAYERS} relay humans`)
  }
  const peers = Array.from({ length: humans }, (_, peer) => ({ peer, seats: [peer] }))
  for (let seat = humans; seat < NET_PLAYERS; seat++) peers[(seat - humans) % humans].seats.push(seat)
  return { seatCount: NET_PLAYERS, peers, live: peers.map(() => true) }
}

/** The existing zone show coordinator owns rounds, votes, elimination and result agreement over the direct group transport. */
export function createOnlineMatch(R: RapierModule, cfg: NetMatchConfig, sidecars: ReadonlyMap<string, ZonesFile>, net: GroupTransport,
  opts: { rtt?: Record<number, number>; cpuMs?: () => number; season?: readonly SchedMap[]; voteMs?: number; intermissionMs?: number } = {}): OnlineMatch {
  const { setup, humanPeers, localPeer } = cfg
  const roster = onlineRoster(humanPeers)
  if (!Number.isInteger(localPeer) || localPeer < 0 || localPeer >= humanPeers || setup.playerCount !== NET_PLAYERS ||
      setup.humans.length !== NET_PLAYERS || setup.humans.some((human, seat) => human !== (seat < humanPeers))) {
    refuse('net', 'createOnlineMatch.setup', 'supply a 60-seat setup with relay humans first and a local human peer')
  }
  const profile = { ...PROFILES[setup.profile], introTicks: 180 }
  const feed = new FarFeed()
  const measurements = Object.fromEntries(roster.peers.map(p => [p.peer,
    // Shared deterministic capacity: eight seats per physics domain, independent of local frame timing.
    { cpuMs: 2, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }]))
  // Timed lobbies have at most four humans. Replicate their bounded domains on every lobby peer so changing
  // packs rebuild from local confirmed states, without a cycle of cross-peer-only snapshot dependencies.
  const zones = new Map([...sidecars].map(([id, sidecar]) => [id, { ...sidecar,
    tuning: { ...sidecar.tuning, replicas: humanPeers, untouchedReplicas: humanPeers } }]))
  const full = createZoneFullMatch(R, { localPeer, roster, humans: setup.humans, seed: setup.seed,
    courses: setup.courses, zones, season: opts.season ?? showMaps(setup.courses), profile: setup.profile,
    measurements, farSink: feed, introTicks: profile.introTicks, voteMs: opts.voteMs, intermissionMs: opts.intermissionMs,
    onVote: () => feed.clear() }, net)
  // Null while the opening map is voted (a browser show offers three maps first; a one-map playlist plays at once).
  let round = full.round
  let lastZones: ZoneMatch | null = round?.match ?? null
  let view = new OnlineRoundView(round, full, setup)
  if (round) view.refresh(round.match.domains, round.match.stats.tick, feed)
  const stats: NetStats = { tick: 0, delay: 0, rollbacks: 0, maxRollback: 0, resimTicks: 0, stallFrames: 0, frames: 0,
    desyncs: 0, malformed: 0, lostPeers: [], ...round?.match.stats, confirmedTick: -1, rtt: opts.rtt ?? {}, lastFrameSimMs: 0 }
  const cpuMs = opts.cpuMs ?? (() => performance.now())
  const totals = { rollbacks: 0, resimTicks: 0, stallFrames: 0, desyncs: 0, frames: 0 }
  let tickOffset = 0
  let recorded = -1
  const hashes = new Map<number, number>()
  let disposed = false
  let podiumTime = 0
  let saved: MatchLog | null = null

  function log(): MatchLog {
    if (saved !== null) return saved
    const results = full.report.rounds
    const last = results.at(-1)
    if (!full.done || !last) refuse('net', 'onlineMatch.log', 'wait for the confirmed show result')
    saved = { format: 'royal-fiesta.matchlog', version: 0, seed: setup.seed, profile: setup.profile,
      playerCount: NET_PLAYERS, humans: [...setup.humans], setupHash: hex8(setupHash(setup)),
      // MatchLog is the classic race/survival summary; full.report retains every season rule and score.
      rounds: results.map(result => ({ index: result.index, kind: result.kind === 'survival' ? 'survival' : 'race',
        final: result.final, course: result.course, startTick: profile.introTicks, endTick: result.endTick,
        participants: [...result.ranking], target: result.qualified.length, qualified: [...result.qualified],
        eliminated: [...result.eliminated], reason: result.reason === 'target' || result.reason === 'allFell' ||
          result.reason === 'lastStanding' ? result.reason : 'timeCap' })),
      winner: full.champion ?? last.ranking[0] ?? -1, podium: last.ranking.slice(0, 3), finalTick: results.reduce((ticks, result) => ticks + result.endTick + 1, 0),
      finalHash: hex8(fnv1a32(encodeRoundResult(last))) }
    return saved
  }
  return {
    full, feed,
    get zones() { return full.round?.match ?? lastZones },
    // Display and legacy HUD/sound adapter; physics is exclusively in the existing Rapier domains.
    get sim() { return view as unknown as MatchSim },
    session: { stats, smoother: null, confirmedHash: tick => hashes.get(tick) },
    frame(dtS, sample) {
      if (disposed) return 0
      const before = cpuMs()
      const alpha = full.frame(dtS, (current, out) => {
        for (const input of out) decodeInput(NEUTRAL_CODE, input)
        const seat = current.seatOf.indexOf(localPeer)
        const index = current.localSeats.indexOf(seat)
        if (index >= 0) sample([out[index]])
      })
      const current = full.round
      if (current !== round) {
        if (round) {
          for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += round.match.stats[key]
        }
        tickOffset = full.report.rounds.reduce((ticks, result) => ticks + result.endTick + 2, 0)
        round = current
        recorded = -1
        if (current) {
          lastZones = current.match
          view = new OnlineRoundView(current, full, setup)
        }
      }
      if (current) {
        const s = current.match.stats
        const end = current.match.currentLedger?.result?.endTick
        const lastTick = end === undefined ? Infinity : end + 1
        const confirmed = Math.min(s.confirmedTick[0] ?? -1, lastTick)
        for (let tick = Math.max(recorded + 1, confirmed - 127); tick <= confirmed; tick++) {
          const hash = current.match.confirmedHash(0, tick)
          if (hash !== undefined) hashes.set(tickOffset + tick, hash)
        }
        recorded = confirmed
        Object.assign(stats, s, { tick: tickOffset + Math.min(s.tick, lastTick), confirmedTick: tickOffset + confirmed })
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) stats[key] += totals[key]
        view.refresh(current.match.domains, s.tick, feed)
      } else view.refresh([], 0)
      for (const tick of hashes.keys()) if (tick < stats.confirmedTick - 127) hashes.delete(tick)
      if (full.done) {
        podiumTime += Math.max(0, dtS)
        log()
      }
      stats.lastFrameSimMs = cpuMs() - before
      return alpha
    },
    get done() { return saved !== null && podiumTime >= profile.podiumTicks / 60 },
    log,
    dispose() { if (!disposed) { disposed = true; full.dispose() } },
  }
}

class OnlineRoundView extends DomainSceneSim {
  // null: the opening vote, before any round (the view then shows the playlist's first course, every seat waiting).
  private readonly round: ZoneFullRound | null
  private readonly full: ZoneFullMatch
  private readonly config: NetMatchConfig['setup']
  constructor(round: ZoneFullRound | null, full: ZoneFullMatch, setup: NetMatchConfig['setup']) {
    super(round?.plan.course ?? setup.courses[0], round?.seatOf.length ?? NET_PLAYERS)
    this.round = round; this.full = full; this.config = setup
    Object.assign(this.setup, setup)
  }

  override character(roomSeat: number, out: CharacterView): CharacterView {
    const seat = this.round ? this.round.seatOf.indexOf(roomSeat) : roomSeat
    super.character(seat, out)
    if (seat < 0) out.status = PlayerStatus.eliminated
    return out
  }

  override phase(out: MatchViewState): MatchViewState {
    const profile = { ...PROFILES[this.config.profile], introTicks: 180 }
    const current = this.full.round
    const ledger = current?.match.currentLedger
    const plan = current?.plan ?? this.round?.plan ?? null
    let alive = 0, qualified = 0
    for (let seat = 0; seat < (current?.seatOf.length ?? 0); seat++) {
      if (ledger?.status(seat) === PlayerStatus.alive) alive++
      if (ledger?.status(seat) === PlayerStatus.qualified) qualified++
    }
    return Object.assign(out, { tick: this.tick, phase: this.full.done ? Phase.podium : this.full.candidates ? Phase.intermission :
      ledger?.over ? Phase.roundEnd : this.tick < profile.introTicks ? Phase.intro : Phase.playing,
      courseIndex: plan?.courseIndex ?? 0, phaseTicksLeft: Math.max(0, profile.introTicks - this.tick), roundIndex: plan?.index ?? 0,
      roundKind: plan?.kind === 'survival' ? 'survival' : 'race', final: plan?.final ?? false,
      roundTicksLeft: plan ? Math.max(0, profile.introTicks + roundTicks(plan.course, profile) - this.tick) : 0,
      alive, qualifiedCount: qualified, target: plan?.target ?? 0, winner: this.full.champion ?? -1,
      podium: this.full.done ? this.full.report.rounds.at(-1)?.ranking.slice(0, 3) ?? [] : [] })
  }
}
