import { fnv1a32, SnapWriter } from '@gamesaloon/rollback'
import type { SnapReader } from '@gamesaloon/rollback'
import type { DomainSim, DomainSpec, ShadowView, SleepEvent } from '@gamesaloon/rollback/zones'
import type { PlayerInput } from '../input.ts'
import { planRound } from '../match/rules.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { PlayerStatusValue, RoundReason } from '../match/roundSystem.ts'
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
const reasons = ['target', 'timeCap', 'lastStanding', 'allFell'] as const

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
  readonly kind: 'race' | 'survival'
  /** Absolute round schedule, shared with FiestaDomain; not its mutable state. */
  readonly introTicks: number
  /** The value of roundTicks(course, profile). */
  readonly roundTicks: number
}

export interface LedgerResult {
  readonly endTick: number
  readonly qualified: readonly number[]
  readonly eliminated: readonly number[]
  readonly reason: RoundReason
}

export class MatchLedger implements DomainSim<PlayerInput> {
  tick: number
  readonly #kind: MatchLedgerConfig['kind']
  readonly #introTicks: number
  readonly #capTick: number
  readonly #target: number
  readonly #final: boolean
  readonly #status: Uint8Array
  readonly #falls: Uint32Array
  readonly #hosts: Int16Array
  readonly #bots: Uint8Array
  readonly #qualified: number[] = []
  readonly #eliminated: number[] = []
  readonly #event: FiestaEvent = { kind: 'fall', seat: 0, tick: 0, a: 0, b: 0 }
  readonly #visit = (event: FiestaEvent): void => { this.#apply(event) }
  readonly #writer = new SnapWriter()
  readonly #record: { endTick: number; qualified: number[]; eliminated: number[]; reason: RoundReason }
  #over = false
  #alive: number

  constructor(spec: DomainSpec, tick: number, config: MatchLedgerConfig) {
    if (spec.kind !== 'global') refuse('ledger', 'spec.kind', 'expected global; create a ledger only for the global domain')
    if (!Number.isInteger(config.seatCount) || config.seatCount < 0 || config.seatCount > 0xffff) {
      refuse('ledger', 'seatCount', 'expected a u16 count; pass the roster seat count')
    }
    if (!Number.isInteger(config.introTicks) || config.introTicks < 0 ||
        !Number.isInteger(config.roundTicks) || config.roundTicks < 1 ||
        config.introTicks + config.roundTicks >= 0x7fffffff) {
      refuse('ledger', 'schedule', 'invalid tick schedule; pass profile introTicks and roundTicks(course, profile) within i32 ticks')
    }
    this.tick = tick
    this.#kind = config.kind
    this.#introTicks = config.introTicks
    this.#capTick = config.introTicks + config.roundTicks
    const plan = planRound(0, config.seatCount)
    this.#target = plan.target
    this.#final = plan.final
    this.#alive = config.seatCount
    this.#status = new Uint8Array(config.seatCount).fill(PlayerStatus.alive)
    this.#falls = new Uint32Array(config.seatCount)
    this.#hosts = new Int16Array(config.seatCount).fill(-1)
    this.#bots = new Uint8Array(config.seatCount)
    this.#record = { endTick: -1, qualified: this.#qualified, eliminated: this.#eliminated, reason: 'target' }
  }

  get over(): boolean { return this.#over }
  get result(): LedgerResult | null { return this.#over ? this.#record : null }
  status(seat: number): PlayerStatusValue { return this.#status[seat] as PlayerStatusValue }
  falls(seat: number): number { return this.#falls[seat] }

  step(_inputs: readonly PlayerInput[], shadows: ShadowView): void {
    // ShadowView guarantees ascending source domain order.
    for (let i = 0; i < shadows.count; i++) {
      const r = shadows.reader(i)
      if (r.remaining === 0) continue
      decodeFiestaEvents(r, this.#event, this.#visit)
    }
    if (!this.#over && this.tick >= this.#introTicks) {
      if (this.#kind === 'race' && this.#qualified.length >= this.#target) this.#close('target')
      else if (this.#kind === 'survival' && this.#alive <= this.#target) {
        this.#close(this.#alive === 0 ? 'allFell' : this.#final ? 'lastStanding' : 'target')
      } else if (this.tick > this.#capTick) this.#close('timeCap')
    }
    this.tick++
  }

  #apply(event: FiestaEvent): void {
    const seat = event.seat
    if (this.#over || this.tick < this.#introTicks || event.tick < this.#introTicks ||
        event.tick > this.tick || event.tick > this.#capTick ||
        this.#status[seat] !== PlayerStatus.alive) return
    if (event.kind === 'fall') {
      this.#falls[seat]++
    } else if (event.kind === 'eliminate') {
      this.#status[seat] = PlayerStatus.eliminated
      this.#eliminated.push(seat)
      this.#alive--
    } else if (event.kind === 'finish') {
      this.#status[seat] = PlayerStatus.qualified
      this.#qualified.push(seat)
      this.#alive--
      // Stop at the target even if later entries in this payload also finish.
      if (this.#kind === 'race' && this.#qualified.length >= this.#target) this.#close('target')
    }
  }

  #close(reason: RoundReason): void {
    if (this.#over) return
    for (let seat = 0; seat < this.#status.length; seat++) {
      if (this.#status[seat] !== PlayerStatus.alive) continue
      if (this.#kind === 'survival') {
        this.#status[seat] = PlayerStatus.qualified
        this.#qualified.push(seat)
      } else {
        this.#status[seat] = PlayerStatus.eliminated
        this.#eliminated.push(seat)
      }
    }
    this.#alive = 0
    this.#record.endTick = this.tick
    this.#record.reason = reason
    this.#over = true
  }

  snapshot(w: SnapWriter): void {
    w.i32(this.tick)
    w.bool(this.#over)
    w.i32(this.#record.endTick)
    w.u8(reasons.indexOf(this.#record.reason))
    w.u16(this.#alive)
    for (let seat = 0; seat < this.#status.length; seat++) {
      w.u8(this.#status[seat])
      w.u32(this.#falls[seat])
      w.i16(this.#hosts[seat])
      w.bool(this.#bots[seat] !== 0)
    }
    writeSeats(w, this.#qualified)
    writeSeats(w, this.#eliminated)
  }

  restore(r: SnapReader): void {
    this.tick = r.i32()
    this.#over = r.bool()
    this.#record.endTick = r.i32()
    this.#record.reason = reasons[r.u8()]
    this.#alive = r.u16()
    for (let seat = 0; seat < this.#status.length; seat++) {
      this.#status[seat] = r.u8()
      this.#falls[seat] = r.u32()
      this.#hosts[seat] = r.i16()
      this.#bots[seat] = r.bool() ? 1 : 0
    }
    readSeats(r, this.#qualified)
    readSeats(r, this.#eliminated)
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

function writeSeats(w: SnapWriter, seats: readonly number[]): void {
  w.u16(seats.length)
  for (let i = 0; i < seats.length; i++) w.u16(seats[i])
}

function readSeats(r: SnapReader, seats: number[]): void {
  const count = r.u16()
  seats.length = 0
  for (let i = 0; i < count; i++) seats.push(r.u16())
}
