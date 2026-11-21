/**
 * Pure online helpers shared by the engine online runtime, the engine show page and the game switch.
 * no handoff: Engine online share 1/5: module admission and queue payload identity takes nothing from this card.
 */
import type { Roster } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { EngineShowRuntime } from './showTypes.ts'

const AREA = 'ege-online'

/** Cumulative online counters of one show runtime: never decreasing desyncs, the confirmed rules tick and peer state. */
export interface EngineOnlineStats {
  readonly desyncs: number
  readonly confirmedTick: number
  readonly peers: number
  readonly livePeers: number
  readonly spectator: boolean
}

/** Room-seat maps of one round roster: human input slots, owning peers and the local peer's seats. */
export interface EngineOnlineSeatMap {
  readonly inputSlotOf: readonly number[]
  readonly peerOfSeat: readonly number[]
  readonly localSeats: readonly number[]
  readonly localHumanSeats: readonly number[]
}

const readings = new WeakMap<EngineShowRuntime, () => EngineOnlineStats>()

/**
 * Stores one online runtime's stats reader in a module WeakMap and refuses a second registration of it.
 * Handoff: Engine online share 3/5: online runtime preparation and confirmed rules stepping attaches
 * registerEngineOnlineStats(runtime, read) once per runtime before returning that runtime and reads the entry
 * through engineOnlineStats; the same runtime constructs EngineVoteBarrier with its roster peer ids and uses
 * onlineSeatMap for each round. State passed: the WeakMap from each runtime to its read closure and the
 * barrier's per-round choices keyed by peer.
 */
export function registerEngineOnlineStats(runtime: EngineShowRuntime, read: () => EngineOnlineStats): void {
  if (readings.has(runtime)) {
    refuse(AREA, 'registerEngineOnlineStats', 'runtime already registered; register each online runtime once')
  }
  readings.set(runtime, read)
}

/** A fresh copy of a registered runtime's counters; null for a local runtime. Never throws. */
export function engineOnlineStats(runtime: EngineShowRuntime): EngineOnlineStats | null {
  const read = readings.get(runtime)
  return read ? { ...read() } : null
}

/**
 * Maps room seats to human input slots (0..7 in ascending room-seat order, -1 for bots) and roster peers, and
 * lists the local peer's seats.
 * Handoff: Engine online share 4/5: per-round zone sessions and one confirmed online round calls onlineSeatMap
 * (inputSlotOf, localSeats, localHumanSeats) and onlineMeasurements(roster) to map room seats to engine input
 * slots for each round session and adds each session's desyncs to the stats read through registerEngineOnlineStats.
 * State passed: the cumulative desync counter of that runtime.
 */
export function onlineSeatMap(humans: readonly boolean[], roster: Roster, localPeer: number): EngineOnlineSeatMap {
  if (humans.length !== roster.seatCount) {
    refuse(AREA, 'network.roster.seatCount',
      `humans has ${humans.length} entries but the roster has ${roster.seatCount} seats; pass one flag per room seat`)
  }
  const humanCount = humans.filter(human => human).length
  if (humanCount > 8) refuse(AREA, 'config.humans', `${humanCount} humans; the engine show has at most 8 input slots`)
  const inputSlotOf = new Array<number>(roster.seatCount).fill(-1)
  let slot = 0
  for (let seat = 0; seat < roster.seatCount; seat++) if (humans[seat]) inputSlotOf[seat] = slot++
  const peerOfSeat = new Array<number>(roster.seatCount).fill(-1)
  for (const entry of roster.peers) {
    for (const seat of entry.seats) {
      if (!Number.isInteger(seat) || seat < 0 || seat >= roster.seatCount) {
        refuse(AREA, `network.roster.peers/${entry.peer}`, `owns room seat ${seat} outside 0..${roster.seatCount - 1}`)
      }
      const owner = peerOfSeat[seat]
      if (owner !== -1 && owner !== entry.peer) {
        refuse(AREA, `network.roster.peers/${entry.peer}`, `also owns room seat ${seat}, already owned by peer ${owner}`)
      }
      peerOfSeat[seat] = entry.peer
    }
  }
  const unowned = peerOfSeat.indexOf(-1)
  if (unowned !== -1) refuse(AREA, 'network.roster.peers/-1', `room seat ${unowned} has no owning peer`)
  if (!roster.peers.some(entry => entry.peer === localPeer)) {
    refuse(AREA, 'network.localPeer', `local peer ${localPeer} is not in the roster; join the lobby roster first`)
  }
  const localSeats = peerOfSeat.flatMap((peer, seat) => (peer === localPeer ? [seat] : []))
  const localHumanSeats = localSeats.filter(seat => humans[seat])
  return { inputSlotOf, peerOfSeat, localSeats, localHumanSeats }
}

/** The deterministic per-peer zone measurements every round session receives. */
export function onlineMeasurements(
  roster: Roster,
): Readonly<Record<number, { cpuMs: number; bandwidthKbps: number; latencyMs: number; spareSlots: number }>> {
  return Object.fromEntries(roster.peers.map(entry =>
    [entry.peer, { cpuMs: 2, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }]))
}

/** Per-round vote agreement over the roster peers; a dropped peer votes -1 for every later round. */
export class EngineVoteBarrier {
  private readonly order: number[]
  private readonly dropped = new Set<number>()
  private readonly rounds = new Map<number, Map<number, number>>()

  constructor(peers: readonly number[]) {
    this.order = [...new Set(peers)].sort((a, b) => a - b)
  }

  /** Records a peer's first choice (integer >= -1) for a round; a repeat is ignored. */
  offer(round: number, peer: number, choice: number): void {
    if (!this.order.includes(peer)) refuse(AREA, 'vote.peer', `peer ${peer} is not in this round roster`)
    if (!Number.isInteger(choice) || choice < -1) {
      refuse(AREA, 'vote.choice', `choice ${choice} is not an integer >= -1; pass -1 for no vote`)
    }
    let byPeer = this.rounds.get(round)
    if (!byPeer) {
      byPeer = new Map()
      this.rounds.set(round, byPeer)
    }
    if (!byPeer.has(peer)) byPeer.set(peer, choice)
  }

  /** Marks the peer absent for the current and every later round. */
  drop(peer: number): void {
    this.dropped.add(peer)
  }

  /** True once every non-dropped peer has offered for the round. */
  complete(round: number): boolean {
    const byPeer = this.rounds.get(round)
    return this.order.every(peer => this.dropped.has(peer) || byPeer?.has(peer) === true)
  }

  /** Every peer's choice, ordered by ascending peer id; refuses while the round is incomplete. */
  choices(round: number): readonly { peer: number; choice: number }[] {
    if (!this.complete(round)) refuse(AREA, 'vote.round', `round ${round} is incomplete; wait until every peer has offered`)
    const byPeer = this.rounds.get(round)
    return this.order.map(peer => ({ peer, choice: this.dropped.has(peer) ? -1 : byPeer?.get(peer) ?? -1 }))
  }
}
