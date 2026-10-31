// Full-match round bookkeeping for zone rooms: the pure plan, roster and result codec helpers.
// No I/O and no Rapier; the caller owns the room roster, the course set and the ledger.
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { Rng } from '@gamesaloon/rollback'
import type { Roster } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { levelOf } from '@royal-fiesta/sim/course'
import { ROUND_KINDS } from '@royal-fiesta/sim/season/kinds'
import type { RoundKind, FinalRule } from '@royal-fiesta/sim/season/kinds'
import { DEFAULT_PLAN, newCursor, nextSlot } from '@royal-fiesta/sim/season/plan'
import type { RoundSlot, ShowCursor } from '@royal-fiesta/sim/season/plan'
import { candidates, commitMap, newSchedule, resolveVote } from '@royal-fiesta/sim/season/scheduler'
import type { SchedMap, ShowSchedule } from '@royal-fiesta/sim/season/scheduler'
import { schedMaps } from '../season.ts'
import type { SeasonData } from '../season.ts'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { LedgerReason, LedgerResult } from '@royal-fiesta/sim/zones/ledger'

const KINDS = ROUND_KINDS
const REASONS: readonly LedgerReason[] = ['target', 'timeCap', 'lastStanding', 'allFell', 'overtime', 'teamWin', 'score', 'crown', 'playoff']
const utf8 = new TextEncoder()
const decodeUtf8 = new TextDecoder()

export interface ZoneRoundPlan {
  readonly slot: RoundSlot
  readonly map: string
  readonly finalRule: FinalRule | null
  readonly playoff: boolean
  readonly teams: Uint8Array | null
  readonly index: number
  readonly kind: RoundKind
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
  readonly map: string
  readonly course: string
  readonly kind: RoundKind
  readonly final: boolean
  readonly playoff: boolean
  readonly endTick: number
  readonly reason: LedgerReason
  readonly ranking: number[]
  readonly qualified: number[]
  readonly eliminated: number[]
  readonly points: number[]
  readonly teamScores: number[]
  readonly champion: number
}

export interface ShowState {
  cursor: ShowCursor
  schedule: ShowSchedule
  rounds: ZoneRoundResult[]
  openingRanks: Uint16Array
}

// Keep immutable construction inputs alongside the public, mutable show state.
const showInputs = new WeakMap<ShowState, { season: readonly SchedMap[]; seed: number }>()

export function newShow(season: readonly SchedMap[], seatCount: number, seed: number, plan: readonly number[] = DEFAULT_PLAN): ShowState {
  const show: ShowState = {
    cursor: newCursor(plan, seatCount), schedule: newSchedule(season, new Rng(seed)),
    rounds: [], openingRanks: new Uint16Array(seatCount),
  }
  showInputs.set(show, { season, seed })
  return show
}

function inputsOf(show: ShowState): { season: readonly SchedMap[]; seed: number } {
  const inputs = showInputs.get(show)
  if (!inputs) refuse('zones', 'show', 'missing season inputs; construct the show with newShow')
  return inputs
}

export function showMaps(courses: readonly ResolvedCourse[], season?: SeasonData | null): SchedMap[] {
  if (season) return schedMaps(season, courses).map(map => ({
    id: map.id, course: courses.findIndex(course => course.id === map.course),
    kind: map.kind, finalRule: map.finalRule, stages: map.stages,
    team: map.teams !== null, cut: season.rules.cutMaps.includes(map.id),
  }))
  return courses.map((course, index) => {
    const level = levelOf(course)
    return { id: course.id, course: index, kind: level.kind, finalRule: level.finalRule,
      stages: level.stages, team: level.teams !== null, cut: level.kind === 'race' }
  })
}

export function roundCandidates(show: ShowState, rng: Rng): string[] {
  const slot = nextSlot(show.cursor)
  if (!slot) return []
  return candidates(inputsOf(show).season, slot, show.schedule, rng,
    slot.final || slot.stage === 'cut' || slot.playoff ? 1 : 3)
}

export function planZoneRound(
  courses: readonly ResolvedCourse[], show: ShowState, alive: readonly number[],
  vote: { candidates: string[]; votes: readonly number[] } | null, rng: Rng,
): ZoneRoundPlan {
  const slot = nextSlot(show.cursor)
  if (!slot) refuse('zones', 'planZoneRound', 'show is complete; start a new show before planning')
  const { season, seed } = inputsOf(show)
  const id = vote ? resolveVote(vote.candidates, vote.votes, seed, show.cursor.roundIndex) : roundCandidates(show, rng)[0]
  const map = season.find(map => map.id === id)
  if (!map || !Number.isInteger(map.course) || !courses[map.course]) {
    refuse('zones', 'planZoneRound.courses', `missing course index for map ${id}; load its course before planning`)
  }
  const teams = map.team ? new Uint8Array(alive.length) : null
  if (teams) {
    // Teams are indexed by dense round seat, matching roundRoster's ascending room seats.
    const roomSeats = [...alive].sort((a, b) => a - b)
    const ranked = roomSeats.map((seat, index) => ({ seat, index }))
      .sort((a, b) => show.openingRanks[a.seat] - show.openingRanks[b.seat] || a.seat - b.seat)
    for (let rank = 0; rank < ranked.length; rank++) teams[ranked[rank].index] = Math.floor((rank + 1) / 2) % 2
  }
  show.schedule = commitMap(show.schedule, map)
  return { index: show.cursor.roundIndex, slot, kind: slot.final ? 'final' : map.kind,
    final: slot.final, finalRule: map.finalRule, target: slot.target, playoff: slot.playoff,
    map: map.id, courseIndex: map.course, course: courses[map.course], teams }
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
    map: plan.map,
    course: plan.course.id,
    kind: plan.kind,
    final: plan.final,
    playoff: plan.playoff,
    endTick: result.endTick,
    reason: result.reason,
    ranking: mapSeats(result.ranking, seatOf),
    qualified: mapSeats(result.qualified, seatOf),
    eliminated: mapSeats(result.eliminated, seatOf),
    points: [...result.points],
    teamScores: [...result.teamScores],
    champion: result.champion < 0 ? -1 : seatOf[result.champion],
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
  const w = new SnapWriter()
  w.u8(result.index)
  writeString(w, result.map, 'map')
  writeString(w, result.course, 'course')
  w.u8(KINDS.indexOf(result.kind))
  w.bool(result.final)
  w.bool(result.playoff)
  w.i32(result.endTick)
  w.u8(REASONS.indexOf(result.reason))
  writeSeats(w, result.ranking)
  writeSeats(w, result.qualified)
  writeSeats(w, result.eliminated)
  writeI32List(w, result.points, 'points')
  writeI32List(w, result.teamScores, 'teamScores')
  w.i32(result.champion)
  return w.bytes()
}

/** Returns null on truncation or an unknown kind/reason; never throws. */
export function decodeRoundResult(bytes: Uint8Array): ZoneRoundResult | null {
  try {
    const r = new SnapReader(bytes)
    const index = r.u8()
    const map = readString(r)
    if (map === null) return null
    const course = readString(r)
    if (course === null) return null
    const kind = r.u8()
    if (kind >= KINDS.length) return null
    const final = r.bool()
    const playoff = r.bool()
    const endTick = r.i32()
    const reason = r.u8()
    if (reason >= REASONS.length) return null
    const ranking = readSeats(r)
    if (ranking === null) return null
    const qualified = readSeats(r)
    if (qualified === null) return null
    const eliminated = readSeats(r)
    if (eliminated === null) return null
    const points = readI32List(r)
    if (points === null) return null
    const teamScores = readI32List(r)
    if (teamScores === null) return null
    const champion = r.i32()
    return {
      index, map, course, kind: KINDS[kind], final, playoff, endTick, reason: REASONS[reason],
      ranking, qualified, eliminated, points, teamScores, champion,
    }
  } catch {
    return null
  }
}

export function sameRoundResult(a: ZoneRoundResult, b: ZoneRoundResult): boolean {
  return a.index === b.index && a.map === b.map && a.course === b.course && a.kind === b.kind &&
    a.final === b.final && a.playoff === b.playoff && a.endTick === b.endTick && a.reason === b.reason &&
    sameI32(a.ranking, b.ranking) && sameI32(a.qualified, b.qualified) && sameI32(a.eliminated, b.eliminated) &&
    sameI32(a.points, b.points) && sameI32(a.teamScores, b.teamScores) && a.champion === b.champion
}

function mapSeats(seats: readonly number[], seatOf: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < seats.length; i++) out.push(seatOf[seats[i]])
  return out
}

function writeString(w: SnapWriter, value: string, field: string): void {
  const bytes = utf8.encode(value)
  if (bytes.length > 0xff) {
    refuse('zones', `encodeRoundResult.${field}`, `${field} longer than 255 UTF-8 bytes; use a short id`)
  }
  w.u8(bytes.length)
  for (let i = 0; i < bytes.length; i++) w.u8(bytes[i])
}

function readString(r: SnapReader): string | null {
  if (r.remaining < 1) return null
  const length = r.u8()
  if (r.remaining < length) return null
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = r.u8()
  return decodeUtf8.decode(bytes)
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

function writeI32List(w: SnapWriter, values: readonly number[], field: string): void {
  if (values.length > 0xffff) {
    refuse('zones', `encodeRoundResult.${field}`, `${field} longer than 65535 entries; shorten the round`)
  }
  w.u16(values.length)
  for (let i = 0; i < values.length; i++) w.i32(values[i])
}

function readI32List(r: SnapReader): number[] | null {
  if (r.remaining < 2) return null
  const count = r.u16()
  if (r.remaining < count * 4) return null
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(r.i32())
  return values
}

function sameI32(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
