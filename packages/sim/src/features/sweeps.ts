import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { CHAR, CharMode } from '../character/constants.ts'
import { levelOf } from '../course.ts'
import type { FeatureSpec } from '../course.ts'
import { dcos, dsin } from '../detmath.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { degToRad, quatAxisAngle, quatIdentity, v3 } from '../vec.ts'
import type { Pose, Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { enumParam, listParam, numParam, objOf, ticksParam, vec3Param } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'

const PATTERNS = ['laser', 'block', 'bars'] as const
type Pattern = typeof PATTERNS[number]
interface Phase {
  atTicks: number
  pattern: Pattern
  heightM: number
  gapM: number
  speedDegS: number
  speedMps: number
}
interface Part { body: number; pose: Pose; half: Vec3 }
const Y = v3(0, 1, 0)
const THICK = 0.1
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

class Sweep implements CourseFeature {
  readonly id: string
  readonly kind = 'sweep'
  readonly #center: Vec3
  readonly #length: number
  readonly #telegraph: number
  readonly #phases: Phase[]
  readonly #parts: Part[] = []
  readonly #seatPos = v3(0, 0, 0)
  #overtimeTicks = 0
  #active = 0
  #effective = 0
  #live = false
  #justLive = false
  #cos = 1
  #sin = 0
  #slide = 0

  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    this.#center = vec3Param(spec, path, 'center')
    this.#length = numParam(spec, path, 'lengthM', 0.01, 1000)
    this.#telegraph = ticksParam(spec, path, 'telegraphS', 0, 3600)
    enumParam(spec, path, 'pattern', PATTERNS)
    numParam(spec, path, 'heightM', 0.001, 1000)
    numParam(spec, path, 'gapM', 0, 1000)
    let previousS = -1
    let previousTicks = -1
    this.#phases = listParam(spec, path, 'phases', 1, 16).map((value, i) => {
      const ptr = `${path}/phases/${i}`
      const overrides = objOf(value, ptr)
      // Overrides are relative to the feature's plan values, not the preceding phase.
      const phaseSpec = { ...spec, params: { ...spec.params, ...overrides } }
      const atS = numParam({ ...spec, params: overrides }, ptr, 'atS', 0, 86400)
      const atTicks = atS === 0 ? 0 : Math.max(1, Math.round(atS * 60))
      if ((i === 0 && atS !== 0) || atS <= previousS || atTicks <= previousTicks) {
        refuse('feature', `${ptr}/atS`, 'expected phases starting at 0 s and strictly increasing at 60 Hz; separate phase times by at least one tick')
      }
      previousS = atS
      previousTicks = atTicks
      const pattern = enumParam(phaseSpec, ptr, 'pattern', PATTERNS)
      const heightM = numParam(phaseSpec, ptr, 'heightM', 0.001, 1000)
      const gapM = numParam(phaseSpec, ptr, 'gapM', 0, 1000)
      if (pattern !== 'block' && heightM > 0.775) {
        refuse('feature', `${ptr}/heightM`, 'expected low bar top <= 0.775 m; lower heightM to keep a jump window')
      }
      if (pattern === 'bars' && heightM + gapM < 2.275) {
        refuse('feature', `${ptr}/gapM`, 'expected heightM + gapM >= 2.275 m; raise gapM to keep the high bar clear')
      }
      if (pattern === 'block' && (gapM < 1.5 || gapM >= this.#length)) {
        refuse('feature', `${ptr}/gapM`, 'expected a walk-through gap >= 1.5 m and smaller than lengthM; widen the wall or adjust gapM')
      }
      const speedDegS = numParam(phaseSpec, ptr, 'speedDegS', -3600, 3600, pattern === 'block' ? 0 : undefined)
      const speedMps = numParam(phaseSpec, ptr, 'speedMps', 0, 100, pattern === 'block' ? undefined : 0)
      return { atTicks, pattern, heightM, gapM, speedDegS, speedMps }
    })
  }

  #poseAt(): void {
    const phase = this.#phases[this.#active]
    const elapsed = this.#effective - phase.atTicks
    this.#live = elapsed >= this.#telegraph
    const seconds = Math.max(0, elapsed - this.#telegraph) / 60
    const angle = phase.pattern === 'block' ? 0 : degToRad(phase.speedDegS * seconds)
    this.#cos = dcos(angle)
    this.#sin = dsin(angle)
    // Triangular travel starts at the centre and covers lengthM between endpoints.
    const travel = (seconds * phase.speedMps + this.#length / 2) % (2 * this.#length)
    this.#slide = this.#length - Math.abs(travel - this.#length) - this.#length / 2
    for (let i = 0; i < this.#parts.length; i++) {
      const { pose, half } = this.#parts[i]
      let x = this.#length / 2
      let y = phase.heightM - Math.min(THICK, phase.heightM) / 2
      half.x = this.#length / 2
      half.y = Math.min(THICK, phase.heightM) / 2
      half.z = THICK / 2
      if (phase.pattern === 'block') {
        half.x = (this.#length - phase.gapM) / 4
        half.y = phase.heightM / 2
        x = this.#slide + (i === 0 ? -1 : 1) * (phase.gapM / 2 + half.x)
        y = half.y
      } else if (i === 1) {
        y = phase.heightM + phase.gapM + half.y
      }
      pose.t.x = this.#center.x + x * this.#cos
      pose.t.y = this.#center.y + y
      pose.t.z = this.#center.z - x * this.#sin
      quatAxisAngle(Y, angle, pose.r)
    }
  }

  #apply(ctx: FeatureCtx, immediate: boolean): void {
    this.#poseAt()
    for (let i = 0; i < this.#parts.length; i++) {
      const part = this.#parts[i]
      const body = ctx.physics.body(part.body)
      const collider = body.collider(0)
      collider.setHalfExtents(part.half)
      collider.setEnabled(this.#live && (i === 0 || this.#phases[this.#active].pattern !== 'laser'))
      if (immediate) {
        body.setTranslation(part.pose.t, false)
        body.setRotation(part.pose.r, false)
      }
      body.setNextKinematicTranslation(part.pose.t)
      body.setNextKinematicRotation(part.pose.r)
    }
  }

  init(ctx: FeatureCtx): void {
    const count = this.#phases.some(p => p.pattern !== 'laser') ? 2 : 1
    for (let i = 0; i < count; i++) {
      const body = ctx.physics.createBody(ctx.R.RigidBodyDesc.kinematicPositionBased(), [
        ctx.R.ColliderDesc.cuboid(1, 1, 1).setCollisionGroups(groups(G.MOVING, G.CHAR | G.PROBE | G.DEBRIS)),
      ])
      this.#parts.push({ body, pose: { t: v3(0, 0, 0), r: quatIdentity() }, half: v3(1, 1, 1) })
    }
    this.#effective = ctx.roundTick
    this.#selectPhase()
    this.#apply(ctx, true)
  }

  #selectPhase(): void {
    this.#active = 0
    while (this.#active + 1 < this.#phases.length && this.#phases[this.#active + 1].atTicks <= this.#effective) this.#active++
  }

  preStep(ctx: FeatureCtx): void {
    const wasLive = this.#live
    const previousPhase = this.#active
    if (ctx.overtime) this.#overtimeTicks = (this.#overtimeTicks + 1) >>> 0
    this.#effective = ctx.roundTick + this.#overtimeTicks / 2
    this.#selectPhase()
    this.#apply(ctx, false)
    this.#justLive = this.#live && (!wasLive || previousPhase !== this.#active)
  }

  postStep(ctx: FeatureCtx): void {
    if (!this.#live) return
    const phase = this.#phases[this.#active]
    const level = levelOf(ctx.course)
    const lethal = phase.pattern === 'laser' && (level.kind === 'survival' || level.finalRule === 'lastStanding')
    if (phase.pattern === 'laser') {
      const baseSpeed = Math.abs(phase.speedDegS) || 1
      const speed = baseSpeed * (ctx.overtime ? 1.5 : 1)
      const beamCentre = this.#parts[0].pose.t
      ctx.soundLoop(`${this.id}:laser`, 'mech.laser', beamCentre, 1, speed / baseSpeed)
    } else if (this.#justLive) {
      ctx.sound('mech.hammer', this.#parts[0].pose.t, 1)
    }
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive || ctx.seats.protectedNow(i)) continue
      if (!lethal && ctx.seats.mode(i) === CharMode.stunned) continue
      const p = ctx.seats.pos(i, this.#seatPos)
      for (let j = 0; j < this.#parts.length; j++) {
        if (j === 1 && phase.pattern === 'laser') continue
        const { pose, half } = this.#parts[j]
        const dx = p.x - pose.t.x, dz = p.z - pose.t.z
        const x = dx * this.#cos - dz * this.#sin
        const z = dx * this.#sin + dz * this.#cos
        const nx = x - clamp(x, -half.x, half.x)
        const nz = z - clamp(z, -half.z, half.z)
        // Distance from the character's vertical capsule segment to the cuboid.
        const ny = Math.max(0, Math.abs(p.y - pose.t.y) - CHAR.halfHeight - half.y)
        const reach = CHAR.radius + 0.05
        if (nx * nx + ny * ny + nz * nz > reach * reach) continue
        if (lethal) ctx.seats.kill(i)
        else {
          const d = Math.sqrt(nx * nx + nz * nz)
          const ux = d > 1e-9 ? nx / d : 0
          const uz = d > 1e-9 ? nz / d : (z < 0 ? -1 : 1)
          ctx.seats.knock(i, v3(8 * (ux * this.#cos + uz * this.#sin), 4, 8 * (-ux * this.#sin + uz * this.#cos)))
        }
        break
      }
    }
  }

  snapshot(w: SnapWriter): void {
    w.u32(this.#overtimeTicks)
    w.u8(this.#active)
    w.f64(this.#effective)
  }

  restore(r: SnapReader, ctx: FeatureCtx): void {
    this.#overtimeTicks = r.u32()
    this.#active = r.u8()
    this.#effective = r.f64()
    this.#apply(ctx, true)
    this.#justLive = false
  }

  draw(out: FeatureDraw[]): void {
    for (let i = 0; i < this.#parts.length; i++) {
      const { pose, half } = this.#parts[i]
      out.push({
        asset: 'candy.sweeper-bar', t: { ...pose.t }, r: { ...pose.r },
        s: v3(half.x * 2, half.y * 2, half.z * 2),
        visible: i === 0 || this.#phases[this.#active].pattern !== 'laser',
        tint: this.#live ? 0 : 1,
      })
    }
  }

  botTarget(_seat: number, pos: Vec3, out: Vec3): boolean {
    const dx = pos.x - this.#center.x, dz = pos.z - this.#center.z
    const radius = Math.sqrt(dx * dx + dz * dz)
    if (radius > this.#length + 2) return false
    const block = this.#phases[this.#active].pattern === 'block'
    out.x = this.#center.x + (block ? this.#slide : -radius * this.#cos)
    out.y = this.#center.y
    out.z = this.#center.z + (block ? 0 : radius * this.#sin)
    return true
  }
}

export const sweepFeature: FeatureFactory = (spec, path) => new Sweep(spec, path)
