import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureSpec } from '../course.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { numParam, objOf, vec3Of } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'

const TICKS_PER_SECOND = 60
const WARN_S = 3
const BOT_REACH_M = 15
const BOT_REACH2 = BOT_REACH_M * BOT_REACH_M

/** y(t) = startY + riseMps * (max(0, t - startS) + overtimeS), clamped at endY. */
export function killHeight(
  startY: number, endY: number, startS: number, riseMps: number, roundTick: number, overtimeTicks: number,
): number {
  const riseS = Math.max(0, roundTick / TICKS_PER_SECOND - startS) + overtimeTicks / TICKS_PER_SECOND
  const y = startY + riseMps * riseS
  return y < endY ? y : endY
}

interface TierClock {
  y: number
  leftS: number
  fraction: number
  ended: boolean
  rising: boolean
}

/** Tiers are the rise start, every whole metre of kill height, and endY. */
function tierClock(
  startY: number, endY: number, startS: number, riseMps: number, roundTick: number, overtimeTicks: number,
): TierClock {
  const nowS = roundTick / TICKS_PER_SECOND
  const totalS = (endY - startY) / riseMps
  const riseS = Math.max(0, nowS - startS) + overtimeTicks / TICKS_PER_SECOND
  if (riseS >= totalS) return { y: endY, leftS: 0, fraction: 0, ended: true, rising: false }
  if (nowS < startS && overtimeTicks === 0) {
    return { y: startY, leftS: startS - nowS, fraction: 1, ended: false, rising: false }
  }
  const y = startY + riseMps * riseS
  const prevY = Math.max(startY, Math.floor(y + 1e-9))
  let nextY = Math.floor(y + 1e-9) + 1
  if (nextY > endY) nextY = endY
  const span = nextY - prevY
  const fraction = span > 1e-12 ? (nextY - y) / span : 0
  return {
    y,
    leftS: (nextY - y) / riseMps,
    fraction: fraction < 0 ? 0 : fraction > 1 ? 1 : fraction,
    ended: false,
    rising: true,
  }
}

/** Seconds left until the next tier, so the view can print the clock. */
export function nextTierS(
  startY: number, endY: number, startS: number, riseMps: number, roundTick: number, overtimeTicks: number,
): number {
  return tierClock(startY, endY, startS, riseMps, roundTick, overtimeTicks).leftS
}

class RisingKill implements CourseFeature {
  readonly id: string
  readonly kind = 'risingKill'
  readonly #startY: number
  readonly #endY: number
  readonly #startS: number
  readonly #riseMps: number
  readonly #clock: Vec3
  readonly #halfM: number
  readonly #seatPos: Vec3 = v3(0, 0, 0)
  readonly #soundPos: Vec3 = v3(0, 0, 0)
  #overtimeTicks = 0
  #killY: number
  #leftS = 0
  #fraction = 1
  #rising = false
  #path: readonly Vec3[] = []

  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    this.#startY = numParam(spec, path, 'startY', -Infinity, Infinity)
    this.#endY = numParam(spec, path, 'endY', -Infinity, Infinity)
    if (!(this.#endY > this.#startY)) {
      refuse('feature', `${path}/endY`, `expected endY > startY (${this.#startY}); raise endY above the start height`)
    }
    this.#startS = numParam(spec, path, 'startS', 0, Infinity)
    this.#riseMps = numParam(spec, path, 'riseMps', 0.01, 5)
    const clock = objOf(spec.params.clock, `${path}/clock`)
    this.#clock = vec3Of(clock.t, `${path}/clock/t`)
    this.#halfM = numParam(spec, path, 'halfM', 0.1, Infinity, 30)
    this.#killY = killHeight(this.#startY, this.#endY, this.#startS, this.#riseMps, 0, 0)
    this.#update(0)
  }

  #readCourse(ctx: FeatureCtx): void {
    this.#path = ctx.course.path.map(node => node.p)
  }

  #update(roundTick: number): void {
    const tier = tierClock(this.#startY, this.#endY, this.#startS, this.#riseMps, roundTick, this.#overtimeTicks)
    this.#killY = tier.y
    this.#leftS = tier.leftS
    this.#fraction = tier.fraction
    this.#rising = tier.rising
  }

  init(ctx: FeatureCtx): void {
    this.#readCourse(ctx)
    this.#update(ctx.roundTick)
  }

  preStep(ctx: FeatureCtx): void {
    this.#update(ctx.roundTick)
  }

  postStep(ctx: FeatureCtx): void {
    if (ctx.overtime) this.#overtimeTicks = Math.min(0xffffffff, this.#overtimeTicks + 1)
    this.#update(ctx.roundTick)
    if (this.#rising) {
      this.#soundPos.x = this.#clock.x
      this.#soundPos.y = this.#killY
      this.#soundPos.z = this.#clock.z
      ctx.sound('mech.slime', this.#soundPos, 1)
    }
    const killY = this.#killY
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      if (ctx.seats.protectedNow(i)) continue
      if (ctx.seats.pos(i, this.#seatPos).y < killY) ctx.seats.kill(i)
    }
  }

  snapshot(w: SnapWriter): void {
    w.u32(this.#overtimeTicks)
  }

  restore(r: SnapReader, ctx: FeatureCtx): void {
    this.#overtimeTicks = r.u32()
    this.#readCourse(ctx)
    this.#update(ctx.roundTick)
  }

  draw(out: FeatureDraw[]): void {
    out.push({
      asset: 'candy.floor-tile',
      t: v3(this.#clock.x, this.#killY, this.#clock.z),
      r: quatIdentity(),
      s: v3(this.#halfM, 1, this.#halfM),
      visible: true,
      tint: 1,
    })
    out.push({
      asset: 'candy.floor-disc',
      t: { x: this.#clock.x, y: this.#clock.y, z: this.#clock.z },
      r: quatIdentity(),
      s: v3(this.#fraction, 0.1, this.#fraction),
      visible: true,
      tint: this.#leftS > 0 && this.#leftS <= WARN_S ? 1 : 0,
    })
  }

  botTarget(_seat: number, pos: Vec3, out: Vec3): boolean {
    const path = this.#path
    if (path.length === 0) return false
    const safeY = this.#killY + 1
    let best: Vec3 | null = null
    for (const p of path) {
      const dx = p.x - pos.x
      const dz = p.z - pos.z
      if (dx * dx + dz * dz > BOT_REACH2) continue
      if (!(p.y > safeY)) continue
      if (best === null || p.y > best.y) best = p
    }
    if (best === null) {
      for (const p of path) {
        if (best === null || p.y > best.y) best = p
      }
    }
    if (best === null) return false
    out.x = best.x
    out.y = best.y
    out.z = best.z
    return true
  }
}

export const risingKillFeature: FeatureFactory = (spec, path) => new RisingKill(spec, path)
