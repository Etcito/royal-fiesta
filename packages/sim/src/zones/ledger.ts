import { fnv1a32, SnapWriter } from '@gamesaloon/rollback'
import type { SnapReader } from '@gamesaloon/rollback'
import type { DomainSim, DomainSpec, ShadowView, SleepEvent } from '@gamesaloon/rollback/zones'
import type { PlayerInput } from '../input.ts'
import { ROUND_KINDS } from '../season/kinds.ts'
import type { RoundKind } from '../season/kinds.ts'
import { resolveRound } from '../season/qualify.ts'
import type { SeatRecord } from '../season/qualify.ts'
import { roundPoints } from '../season/points.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'

export type LedgerReason = 'target' | 'timeCap' | 'lastStanding' | 'allFell' | 'overtime' | 'teamWin' | 'score' | 'crown' | 'playoff'
export type FiestaEventKind = 'finish' | 'fall' | 'eliminate' | 'gate' | 'progress' | 'score' | 'teamScore' | 'possess' | 'match' | 'crown'

export interface FiestaEvent {
  kind: FiestaEventKind
  seat: number
  tick: number
  a: number
  b: number
}

const eventKinds = ['finish', 'fall', 'eliminate', 'gate', 'progress', 'score', 'teamScore', 'possess', 'match', 'crown'] as const
const reasons: readonly LedgerReason[] = ['target', 'timeCap', 'lastStanding', 'allFell', 'overtime', 'teamWin', 'score', 'crown', 'playoff']

// The implicit event link preserves emission order; it is not sorted by seat or tick.
export function encodeFiestaEvents(w: SnapWriter, events: readonly FiestaEvent[]): void {
  w.u16(events.length)
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    w.u8(eventKinds.indexOf(event.kind))
    w.u16(event.seat)
    w.i32(event.tick)
    w.i32(event.a)
    w.i32(event.b)
  }
}

/** Reads one entry after the u16 count, into caller-owned storage. */
export function decodeFiestaEvent(r: SnapReader, out: FiestaEvent): boolean {
  if (r.remaining < 15) return false
  const kind = r.u8()
  out.seat = r.u16()
  out.tick = r.i32()
  out.a = r.i32()
  out.b = r.i32()
  if (kind >= eventKinds.length) return false
  out.kind = eventKinds[kind]
  return true
}

/** The visitor must consume scratch immediately; it is reused for every entry. */
export function decodeFiestaEvents(r: SnapReader, scratch: FiestaEvent, visit: (event: FiestaEvent) => void): boolean {
  if (r.remaining === 0) return true
  if (r.remaining < 2) return false
  const count = r.u16()
  for (let i = 0; i < count; i++) {
    if (!decodeFiestaEvent(r, scratch)) return false
    visit(scratch)
  }
  return true
}

export interface MatchLedgerConfig {
  readonly seatCount: number
  readonly kind: RoundKind
  readonly final: boolean
  readonly finalRule: 'crown' | 'lastStanding' | null
  readonly target: number
  readonly playoff: boolean
  readonly introTicks: number
  readonly roundTicks: number
  readonly overtimeTicks: number
  readonly seed: number
  readonly roundIndex: number
  readonly teams: Uint8Array | null
  readonly openingRanks: Uint16Array | null
}

export interface LedgerResult {
  readonly endTick: number
  readonly reason: LedgerReason
  readonly ranking: readonly number[]
  readonly qualified: readonly number[]
  readonly eliminated: readonly number[]
  readonly points: readonly number[]
  readonly teamScores: readonly number[]
  readonly playoff: readonly number[] | null
  readonly champion: number
}

type LedgerScalars = Omit<MatchLedgerConfig, 'teams' | 'openingRanks'>

export class MatchLedger implements DomainSim<PlayerInput> {
  tick: number
  #config: LedgerScalars
  #records: SeatRecord[]
  #teamScores: number[]
  #hosts: Int16Array
  #bots: Uint8Array
  readonly #event: FiestaEvent = { kind: 'fall', seat: 0, tick: 0, a: 0, b: 0 }
  readonly #visit = (event: FiestaEvent): void => { this.#apply(event) }
  readonly #writer = new SnapWriter()
  #result: LedgerResult | null = null
  #over = false
  #overtime = false
  #crownThisStep = false

  constructor(spec: DomainSpec, tick: number, config: MatchLedgerConfig) {
    if (spec.kind !== 'global') refuse('ledger', 'spec.kind', 'expected global; create a ledger only for the global domain')
    if (!Number.isInteger(config.seatCount) || config.seatCount < 0 || config.seatCount > 0xffff) {
      refuse('ledger', 'seatCount', 'expected a u16 count; pass the roster seat count')
    }
    if (!Number.isInteger(config.introTicks) || config.introTicks < 0 ||
        !Number.isInteger(config.roundTicks) || config.roundTicks < 1 ||
        !Number.isInteger(config.overtimeTicks) || config.overtimeTicks < 0 ||
        config.introTicks + config.roundTicks + config.overtimeTicks >= 0x7fffffff) {
      refuse('ledger', 'schedule', 'invalid tick schedule; pass nonnegative intro and overtime and positive round ticks within i32 ticks')
    }
    this.tick = tick
    const { teams, openingRanks, ...scalars } = config
    this.#config = scalars
    this.#records = Array.from({ length: config.seatCount }, (_, seat) => ({
      seat, status: PlayerStatus.alive, finishTick: -1, finishSub: 0, lap: 0, stage: 0,
      routeMm: 0, falls: 0, score: 0, lastScoreTick: -1, holdTicks: 0, possessing: false,
      lastAcquireTick: -1, matches: 0, crossTicks: 0, outTick: -1, outSub: 0,
      team: teams?.[seat] ?? -1, openingRank: openingRanks?.[seat] ?? 0,
    }))
    this.#teamScores = config.kind === 'team' ? Array(new Set(this.#records.map(r => r.team)).size).fill(0) : []
    this.#hosts = new Int16Array(config.seatCount).fill(-1)
    this.#bots = new Uint8Array(config.seatCount)
  }

  get over(): boolean { return this.#over }
  get result(): LedgerResult | null { return this.#result }
  get overtime(): boolean { return this.#overtime }
  status(seat: number): number { return this.#records[seat].status }
  falls(seat: number): number { return this.#records[seat].falls }
  record(seat: number, out: SeatRecord): SeatRecord { return Object.assign(out, this.#records[seat]) }

  step(_inputs: readonly PlayerInput[], shadows: ShadowView): void {
    this.#crownThisStep = false
    // ShadowView guarantees ascending source domain order. Resolve exits and grabs
    // after the whole batch, so simultaneous events keep their sub-tick ordering.
    for (let i = 0; i < shadows.count; i++) {
      decodeFiestaEvents(shadows.reader(i), this.#event, this.#visit)
    }
    if (!this.#over && this.tick >= this.#config.introTicks) {
      for (const record of this.#records) if (record.possessing) record.holdTicks++
      this.#checkClose()
    }
    this.tick++
  }

  #apply(event: FiestaEvent): void {
    if (this.#over || event.tick < this.#config.introTicks || event.tick > this.tick) return
    if (event.kind === 'teamScore') {
      if (this.#teamScores[event.seat] === undefined) return
      this.#teamScores[event.seat] += event.a
      if (this.#overtime && event.a !== 0) this.#close('teamWin')
      return
    }
    const record = this.#records[event.seat]
    if (record === undefined) return
    switch (event.kind) {
      case 'finish':
        record.status = PlayerStatus.qualified
        record.finishTick = event.tick
        record.finishSub = event.a
        record.lap = event.b
        break
      case 'fall': record.falls++; break
      case 'eliminate':
        record.status = PlayerStatus.eliminated
        record.outTick = event.tick
        record.outSub = event.a
        break
      case 'gate': record.stage = event.a; record.lap = event.b; break
      case 'progress': record.routeMm = event.a; break
      case 'score': record.score += event.a; record.lastScoreTick = event.tick; break
      case 'possess':
        record.possessing = event.a === 1
        if (record.possessing) record.lastAcquireTick = event.tick
        break
      case 'match': record.matches += event.a; record.crossTicks += event.b; break
      case 'crown':
        this.#crownThisStep = true
        record.finishTick = event.tick
        record.finishSub = event.a
        record.status = PlayerStatus.qualified
        break
    }
  }

  #roundKind(): RoundKind {
    return this.#config.final && this.#config.finalRule !== null ? 'final' : this.#config.kind
  }

  #checkClose(): void {
    const config = this.#config
    const capTick = config.introTicks + config.roundTicks
    const atCap = this.tick >= capTick
    const overtimeEnd = this.tick >= capTick + config.overtimeTicks
    const alive = this.#records.filter(r => r.status === PlayerStatus.alive).length
    const finished = this.#records.filter(r => r.finishTick >= 0).length
    switch (this.#roundKind()) {
      case 'race':
        if (finished >= config.target) this.#close('target')
        else if (atCap) this.#close('timeCap')
        break
      case 'survival':
        if (alive <= config.target) this.#close(alive === 0 ? 'allFell' : 'target')
        else if (atCap) {
          this.#overtime = true
          if (overtimeEnd) this.#close('overtime')
        }
        break
      case 'team':
        if (atCap) {
          if (!this.#overtime && this.#teamScores.some(s => s !== this.#teamScores[0])) this.#close('teamWin')
          else {
            this.#overtime = true
            if (overtimeEnd) this.#close('overtime')
          }
        }
        break
      case 'collection': case 'hunt': case 'logic':
        if (atCap) this.#close('score')
        break
      case 'final':
        if (config.finalRule === 'crown' && this.#crownThisStep) this.#close('crown')
        else if (config.finalRule === 'lastStanding' && alive <= 1) this.#close('lastStanding')
        else if (atCap) {
          this.#overtime = true
          if (overtimeEnd) this.#close('overtime')
        }
        break
    }
  }

  #close(reason: LedgerReason): void {
    if (this.#over) return
    const config = this.#config
    const outcome = resolveRound(this.#roundKind(), config.finalRule, config.target,
      this.#records, this.#teamScores, config.seed, config.roundIndex, config.playoff)
    const qualified = new Set(outcome.qualified)
    const points = outcome.ranking.map((seat, index) => roundPoints(
      config.kind === 'team' && this.#records[seat].team === outcome.teamWinner ? 1 : index + 1,
      config.seatCount, qualified.has(seat),
    ))
    this.#result = {
      endTick: this.tick,
      reason: outcome.playoff === null ? reason : 'playoff',
      ranking: outcome.ranking, qualified: outcome.qualified, eliminated: outcome.eliminated,
      points, teamScores: this.#teamScores.slice(), playoff: outcome.playoff,
      champion: config.final && outcome.playoff === null && outcome.qualified.length === 1
        ? outcome.qualified[0] : outcome.champion,
    }
    this.#over = true
  }

  snapshot(w: SnapWriter): void {
    const config = this.#config
    w.u16(config.seatCount)
    w.u8(ROUND_KINDS.indexOf(config.kind))
    w.bool(config.final)
    w.u8(config.finalRule === null ? 0 : config.finalRule === 'crown' ? 1 : 2)
    w.u16(config.target)
    w.bool(config.playoff)
    w.i32(config.introTicks)
    w.i32(config.roundTicks)
    w.i32(config.overtimeTicks)
    w.u32(config.seed)
    w.u32(config.roundIndex)
    for (const record of this.#records) {
      for (const field of recordNumbers) w.i32(record[field])
      w.bool(record.possessing)
    }
    writeNumbers(w, this.#teamScores)
    w.bool(this.#overtime)
    for (let seat = 0; seat < config.seatCount; seat++) {
      w.i16(this.#hosts[seat])
      w.bool(this.#bots[seat] !== 0)
    }
    w.bool(this.#over)
    w.bool(this.#result !== null)
    if (this.#result !== null) {
      const result = this.#result
      w.i32(result.endTick)
      w.u8(reasons.indexOf(result.reason))
      writeNumbers(w, result.ranking)
      writeNumbers(w, result.qualified)
      writeNumbers(w, result.eliminated)
      writeNumbers(w, result.points)
      writeNumbers(w, result.teamScores)
      w.bool(result.playoff !== null)
      if (result.playoff !== null) writeNumbers(w, result.playoff)
      w.i32(result.champion)
    }
    w.i32(this.tick)
  }

  restore(r: SnapReader): void {
    const seatCount = r.u16()
    const kind = ROUND_KINDS[r.u8()]
    const final = r.bool()
    const rule = r.u8()
    this.#config = {
      seatCount, kind, final, finalRule: rule === 0 ? null : rule === 1 ? 'crown' : 'lastStanding',
      target: r.u16(), playoff: r.bool(), introTicks: r.i32(), roundTicks: r.i32(),
      overtimeTicks: r.i32(), seed: r.u32(), roundIndex: r.u32(),
    }
    this.#records = Array.from({ length: seatCount }, () => {
      const record = {} as SeatRecord
      for (const field of recordNumbers) record[field] = r.i32()
      record.possessing = r.bool()
      return record
    })
    this.#teamScores = readNumbers(r)
    this.#overtime = r.bool()
    this.#hosts = new Int16Array(seatCount)
    this.#bots = new Uint8Array(seatCount)
    for (let seat = 0; seat < seatCount; seat++) {
      this.#hosts[seat] = r.i16()
      this.#bots[seat] = r.bool() ? 1 : 0
    }
    this.#over = r.bool()
    this.#result = r.bool() ? {
      endTick: r.i32(), reason: reasons[r.u8()], ranking: readNumbers(r),
      qualified: readNumbers(r), eliminated: readNumbers(r), points: readNumbers(r),
      teamScores: readNumbers(r), playoff: r.bool() ? readNumbers(r) : null, champion: r.i32(),
    } : null
    this.tick = r.i32()
  }

  hash(): number {
    this.#writer.reset()
    this.exportEntities(this.#writer)
    // There are no sleeping entities: the empty FNV digest is the offset basis.
    this.#writer.u32(0x811c9dc5)
    return fnv1a32(this.#writer.bytes())
  }

  exportEntities(w: SnapWriter): void { this.snapshot(w) }
  shadowOut(w: SnapWriter, _to: number): void { w.u16(0) }
  events(_w: SnapWriter): void {}
  far(w: SnapWriter, _stride: number): void { w.u16(0) }

  seatHost(seat: number, peer: number, bot: boolean): void {
    this.#hosts[seat] = peer
    this.#bots[seat] = bot ? 1 : 0
  }

  sleepEvents(out: SleepEvent[]): void { out.length = 0 }
  sleepPose(_id: number, _w: SnapWriter): boolean { return false }
}

const recordNumbers = [
  'seat', 'status', 'finishTick', 'finishSub', 'lap', 'stage', 'routeMm', 'falls',
  'score', 'lastScoreTick', 'holdTicks', 'lastAcquireTick', 'matches', 'crossTicks',
  'outTick', 'outSub', 'team', 'openingRank',
] as const satisfies readonly (keyof SeatRecord)[]

function writeNumbers(w: SnapWriter, values: readonly number[]): void {
  w.u16(values.length)
  for (const value of values) w.i32(value)
}

function readNumbers(r: SnapReader): number[] {
  const count = r.u16()
  return Array.from({ length: count }, () => r.i32())
}
