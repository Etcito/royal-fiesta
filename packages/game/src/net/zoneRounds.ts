// Full-match round bookkeeping for zone rooms: the pure plan, roster and result codec helpers.
// No I/O and no Rapier; the caller owns the room roster, the course set and the ledger.
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { Rng } from '@gamesaloon/rollback'
import type { Roster } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { coursePool, pickCourse, planRound } from '@royal-fiesta/sim/match/rules'
import type { RoundReason } from '@royal-fiesta/sim/match/roundSystem'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { LedgerResult } from '@royal-fiesta/sim/zones/ledger'

const KINDS = ['race', 'survival'] as const
const REASONS: readonly RoundReason[] = ['target', 'timeCap', 'lastStanding', 'allFell']
const utf8 = new TextEncoder()
const decodeUtf8 = new TextDecoder()

export interface ZoneRoundPlan {
  readonly index: number
  readonly kind: 'race' | 'survival'
  readonly final: boolean
  readonly target: number
  /** Index into the courses passed to planZoneRound. */
  readonly courseIndex: number
  readonly course: ResolvedCourse
}

/** The round roster plus the room seat of each round seat, indexed by round seat. */
export interface RoundRoster {
  readonly roster: Roster
  readonly seatOf: readonly number[]
}

export interface ZoneRoundResult {
  readonly index: number
  readonly course: string
  readonly kind: 'race' | 'survival'
  readonly final: boolean
  readonly endTick: number
  readonly reason: RoundReason
  readonly qualified: number[]
  readonly eliminated: number[]
}

/**
 * Plans one full-match round over the alive room seats. The first round is called with lastCourse -1; every later
 * round with the previous round's course index.
 */
export function planZoneRound(
  courses: readonly ResolvedCourse[],
  index: number,
  alive: readonly number[],
  lastCourse: number,
  rng: Rng,
): ZoneRoundPlan {
  const plan = planRound(index, alive.length)
  const pool = coursePool(courses, plan.kind, 'sprint')
  if (pool.length === 0) {
    refuse('zones', 'planZoneRound.courses', `no ${plan.kind} sprint course; add one to the playlist`)
  }
  const courseIndex = pickCourse(pool, lastCourse, rng)
  return {
    index: plan.index, kind: plan.kind, final: plan.final, target: plan.target,
    courseIndex, course: courses[courseIndex],
  }
}

/**
 * Densely renumbers the alive room seats into round seats 0..n-1. Each peer keeps its id and its round seats; a peer
 * with no alive seat is omitted and marked not live. seatOf maps round seat k back to its room seat.
 */
export function roundRoster(room: Roster, alive: readonly number[]): RoundRoster {
  const seatOf = [...alive].sort((a, b) => a - b)
  const roundSeat = new Map<number, number>()
  for (let k = 0; k < seatOf.length; k++) roundSeat.set(seatOf[k], k)
  const peers: { peer: number; seats: number[] }[] = []
  const live = room.live.slice()
  for (const p of room.peers) {
    const seats: number[] = []
    for (const seat of p.seats) {
      const k = roundSeat.get(seat)
      if (k !== undefined) seats.push(k)
    }
    if (seats.length === 0) {
      live[p.peer] = false
      continue
    }
    seats.sort((a, b) => a - b)
    peers.push({ peer: p.peer, seats })
  }
  return { roster: { seatCount: seatOf.length, peers, live }, seatOf }
}

/** Maps a ledger result from round seats to room seats, keeping the ledger's qualified and eliminated order. */
export function roundResultOf(plan: ZoneRoundPlan, result: LedgerResult, seatOf: readonly number[]): ZoneRoundResult {
  return {
    index: plan.index,
    course: plan.course.id,
    kind: plan.kind,
    final: plan.final,
    endTick: result.endTick,
    reason: result.reason,
    qualified: mapSeats(result.qualified, seatOf),
    eliminated: mapSeats(result.eliminated, seatOf),
  }
}

/** The room seats that play the next round, ascending. */
export function nextAlive(result: Pick<ZoneRoundResult, 'qualified'>): number[] {
  return [...result.qualified].sort((a, b) => a - b)
}

export function encodeRoundResult(result: ZoneRoundResult): Uint8Array {
  if (!Number.isInteger(result.index) || result.index < 0 || result.index > 0xff) {
    refuse('zones', 'encodeRoundResult.index', 'expected a u8 round index; pass the plan index')
  }
  const course = utf8.encode(result.course)
  if (course.length > 0xff) {
    refuse('zones', 'encodeRoundResult.course', 'course id longer than 255 UTF-8 bytes; use a short course id')
  }
  const w = new SnapWriter()
  w.u8(result.index)
  w.u8(course.length)
  for (let i = 0; i < course.length; i++) w.u8(course[i])
  w.u8(KINDS.indexOf(result.kind))
  w.bool(result.final)
  w.i32(result.endTick)
  w.u8(REASONS.indexOf(result.reason))
  writeSeats(w, result.qualified)
  writeSeats(w, result.eliminated)
  return w.bytes()
}

/** Returns null on truncation or an unknown kind/reason; never throws. */
export function decodeRoundResult(bytes: Uint8Array): ZoneRoundResult | null {
  try {
    const r = new SnapReader(bytes)
    const index = r.u8()
    const courseLength = r.u8()
    if (r.remaining < courseLength) return null
    const courseBytes = new Uint8Array(courseLength)
    for (let i = 0; i < courseLength; i++) courseBytes[i] = r.u8()
    const course = decodeUtf8.decode(courseBytes)
    const kind = r.u8()
    if (kind >= KINDS.length) return null
    const final = r.bool()
    const endTick = r.i32()
    const reason = r.u8()
    if (reason >= REASONS.length) return null
    const qualified = readSeats(r)
    if (qualified === null) return null
    const eliminated = readSeats(r)
    if (eliminated === null) return null
    return { index, course, kind: KINDS[kind], final, endTick, reason: REASONS[reason], qualified, eliminated }
  } catch {
    return null
  }
}

export function sameRoundResult(a: ZoneRoundResult, b: ZoneRoundResult): boolean {
  return a.index === b.index && a.course === b.course && a.kind === b.kind && a.final === b.final &&
    a.endTick === b.endTick && a.reason === b.reason &&
    sameSeats(a.qualified, b.qualified) && sameSeats(a.eliminated, b.eliminated)
}

function mapSeats(seats: readonly number[], seatOf: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < seats.length; i++) out.push(seatOf[seats[i]])
  return out
}

function writeSeats(w: SnapWriter, seats: readonly number[]): void {
  w.u16(seats.length)
  for (let i = 0; i < seats.length; i++) w.u16(seats[i])
}

function readSeats(r: SnapReader): number[] | null {
  if (r.remaining < 2) return null
  const count = r.u16()
  if (r.remaining < count * 2) return null
  const seats: number[] = []
  for (let i = 0; i < count; i++) seats.push(r.u16())
  return seats
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
