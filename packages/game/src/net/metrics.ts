// Network measuring tools for the proofs: confirmed hash logs (QB1), displayed jump meter (QB3) and cost stats (QB9).
// View side only: reads the session and the sim view API, never writes either.
import type { CorrectionSmoother, RollbackSession } from '@gamesaloon/rollback'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'

/** A displayed move longer than this in one rendered frame is a visible snap (m). */
export const SNAP_THRESHOLD_M = 0.5

// The session's confirmed hash ring (HASH_RING in rollback core).
const HASH_RING = 128

export class ConfirmedHashLog {
  private hashes = new Float64Array(1024)
  private present = new Uint8Array(1024)
  private lastRecorded = -1
  private stored = 0

  /** Number of stored hashes. */
  get count(): number {
    return this.stored
  }

  /** Highest tick walked so far (-1 before any confirmed tick). */
  get lastTick(): number {
    return this.lastRecorded
  }

  /** Stores the hash of every tick confirmed since the previous call. Call at least every 100 ticks. */
  record(session: RollbackSession<PlayerInput>): void {
    const confirmed = session.stats.confirmedTick
    const fresh = confirmed - this.lastRecorded
    if (fresh <= 0) return
    if (fresh > HASH_RING) {
      refuse('net', 'ConfirmedHashLog.record',
        `${fresh} ticks confirmed since the last call (> ${HASH_RING} hash ring); call record at least every 100 ticks`)
    }
    this.grow(confirmed + 1)
    for (let t = this.lastRecorded + 1; t <= confirmed; t++) {
      const h = session.confirmedHash(t)
      // Within the ring, undefined means the session never hashed that tick: kept as missing.
      if (h === undefined) continue
      this.hashes[t] = h
      this.present[t] = 1
      this.stored++
    }
    this.lastRecorded = confirmed
  }

  get(tick: number): number | undefined {
    if (!(tick >= 0 && tick <= this.lastRecorded) || this.present[tick] === 0) return undefined
    return this.hashes[tick]
  }

  private grow(size: number): void {
    if (size <= this.hashes.length) return
    let cap = this.hashes.length
    while (cap < size) cap *= 2
    const h = new Float64Array(cap)
    h.set(this.hashes)
    const p = new Uint8Array(cap)
    p.set(this.present)
    this.hashes = h
    this.present = p
  }
}

/** Compares every tick present in all logs. */
export function compareHashLogs(logs: readonly ConfirmedHashLog[]): { ticksCompared: number; mismatches: number; firstMismatch: number } {
  if (logs.length < 2) refuse('net', 'compareHashLogs', `${logs.length} log(s) given; pass at least 2 logs`)
  let last = logs[0].lastTick
  for (let i = 1; i < logs.length; i++) last = Math.min(last, logs[i].lastTick)
  let ticksCompared = 0
  let mismatches = 0
  let firstMismatch = -1
  for (let t = 0; t <= last; t++) {
    const h0 = logs[0].get(t)
    if (h0 === undefined) continue
    let common = true
    let same = true
    for (let i = 1; i < logs.length; i++) {
      const h = logs[i].get(t)
      if (h === undefined) {
        common = false
        break
      }
      if (h !== h0) same = false
    }
    if (!common) continue
    ticksCompared++
    if (!same) {
      mismatches++
      if (firstMismatch < 0) firstMismatch = t
    }
  }
  return { ticksCompared, mismatches, firstMismatch }
}

/** Per-frame displayed (smoothed) position jumps, excluding parked players and fresh teleports. */
export class DisplayJumpMeter {
  /** The largest jump seen, with its player and sim tick (for proof notes). */
  readonly worst = { player: -1, tick: -1, jump: 0 }
  private readonly players: number
  private readonly prev: Float64Array
  private readonly valid: Uint8Array
  private readonly shown = new Float64Array(3)
  private readonly view: CharacterView = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    facing: { x: 0, z: 1 },
    mode: 0,
    status: 0,
    parked: false,
    teleportTick: -1,
  }
  private max = 0
  private snaps = 0

  constructor(players: number) {
    if (!(Number.isInteger(players) && players >= 1)) {
      refuse('net', 'DisplayJumpMeter', `players = ${players}; pass an integer >= 1`)
    }
    this.players = players
    this.prev = new Float64Array(players * 3)
    this.valid = new Uint8Array(players)
  }

  get maxJump(): number {
    return this.max
  }

  get visibleSnaps(): number {
    return this.snaps
  }

  /** Call once per rendered frame, after the session frame. */
  sample(sim: MatchSim, smoother: CorrectionSmoother | null): void {
    const c = this.view
    const d = this.shown
    const tick = sim.tick
    for (let p = 0; p < this.players; p++) {
      sim.character(p, c)
      if (c.parked || c.teleportTick >= tick - 2) {
        this.valid[p] = 0
        continue
      }
      d[0] = c.pos.x
      d[1] = c.pos.y
      d[2] = c.pos.z
      if (smoother !== null) smoother.applyEntity(p, d)
      const b = p * 3
      if (this.valid[p] === 1) {
        const dx = d[0] - this.prev[b]
        const dy = d[1] - this.prev[b + 1]
        const dz = d[2] - this.prev[b + 2]
        const jump = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (jump > this.max) {
          this.max = jump
          this.worst.player = p
          this.worst.tick = tick
          this.worst.jump = jump
        }
        if (jump > SNAP_THRESHOLD_M) this.snaps++
      }
      this.prev[b] = d[0]
      this.prev[b + 1] = d[1]
      this.prev[b + 2] = d[2]
      this.valid[p] = 1
    }
  }
}

/** Cost samples in ms; percentiles use nearest rank, like proofkit.percentile. */
export class CostStats {
  private readonly samples: number[] = []

  get n(): number {
    return this.samples.length
  }

  add(ms: number): void {
    this.samples.push(ms)
  }

  mean(): number {
    this.need('mean')
    let s = 0
    for (let i = 0; i < this.samples.length; i++) s += this.samples[i]
    return s / this.samples.length
  }

  p50(): number {
    return this.percentile(50, 'p50')
  }

  p99(): number {
    return this.percentile(99, 'p99')
  }

  max(): number {
    this.need('max')
    let m = this.samples[0]
    for (let i = 1; i < this.samples.length; i++) if (this.samples[i] > m) m = this.samples[i]
    return m
  }

  private percentile(p: number, name: string): number {
    this.need(name)
    const sorted = this.samples.slice().sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[idx]
  }

  private need(name: string): void {
    if (this.samples.length === 0) refuse('net', `CostStats.${name}`, 'no samples; call add() at least once first')
  }
}
