import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { FeatureSpec, ResolvedCourse } from '../course.ts'
import type { Vec3 } from '../vec.ts'
import { refuse } from '../refusal.ts'
import { annulusFeature } from './annulus.ts'
import { boostLaneFeature } from './boostLane.ts'
import { CARRY_KIND, carryItemFeature } from './carry.ts'
import { doorBankFeature } from './doorBank.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { hexFieldFeature } from './hexField.ts'
import { catchVolumeFeature, launchPadFeature } from './launch.ts'
import { memoryTilesFeature } from './memoryTiles.ts'
import { risingKillFeature } from './risingKill.ts'
import { rollingLogFeature } from './rollingLog.ts'
import { swimVolumeFeature } from './swim.ts'
import { sweepFeature } from './sweeps.ts'
import { tileFieldFeature } from './tiles.ts'

const MAX_FEATURES = 32

const markerFactory: FeatureFactory = (spec: FeatureSpec, path: string): CourseFeature => {
  const t = markerPosition(spec, path)
  const radiusM = markerRadius(spec, path)
  return new MarkerFeature(spec.id, t, radiusM)
}

class MarkerFeature implements CourseFeature {
  readonly id: string
  readonly kind = 'marker'
  readonly #t: Vec3
  readonly #radiusM: number
  readonly #scratch: Vec3 = { x: 0, y: 0, z: 0 }
  #touches = 0
  #lastTouchTick = -1
  #touched = false

  constructor(id: string, t: Vec3, radiusM: number) {
    this.id = id
    this.#t = t
    this.#radiusM = radiusM
  }

  init(_ctx: FeatureCtx): void {}

  preStep(_ctx: FeatureCtx): void {}

  postStep(ctx: FeatureCtx): void {
    const t = this.#t
    const radius2 = this.#radiusM * this.#radiusM
    let touches = 0
    for (let i = 0; i < ctx.seats.count; i++) {
      const p = ctx.seats.pos(i, this.#scratch)
      const dx = p.x - t.x
      const dy = p.y - t.y
      const dz = p.z - t.z
      if (dx * dx + dy * dy + dz * dz <= radius2) touches++
    }
    this.#touches = touches
    this.#touched = touches > 0
    if (this.#touched) {
      this.#lastTouchTick = ctx.tick
      ctx.sound('obj.pickup', t, 1)
    }
  }

  snapshot(w: SnapWriter): void {
    w.u32(this.#touches)
    w.i32(this.#lastTouchTick)
  }

  restore(r: SnapReader, _ctx: FeatureCtx): void {
    this.#touches = r.u32()
    this.#lastTouchTick = r.i32()
    this.#touched = false
  }

  draw(out: FeatureDraw[]): void {
    out.push({
      asset: 'candy.floor-disc',
      t: { x: this.#t.x, y: this.#t.y, z: this.#t.z },
      r: { x: 0, y: 0, z: 0, w: 1 },
      s: { x: this.#radiusM, y: 0.1, z: this.#radiusM },
      visible: true,
      tint: this.#touched ? 4 : 0,
    })
  }

  botTarget(_seat: number, _pos: Vec3, out: Vec3): boolean {
    out.x = this.#t.x
    out.y = this.#t.y
    out.z = this.#t.z
    return true
  }
}

function markerPosition(spec: FeatureSpec, path: string): Vec3 {
  const value = spec.params.t
  if (!Array.isArray(value) || value.length !== 3) {
    refuse('feature', `${path}/t`, 'expected t as [x,y,z] in metres; write a three-number position')
  }
  const x = value[0]
  const y = value[1]
  const z = value[2]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    refuse('feature', `${path}/t`, 'expected finite t numbers; replace NaN or Infinity with metre coordinates')
  }
  return { x, y, z }
}

function markerRadius(spec: FeatureSpec, path: string): number {
  const value = spec.params.radiusM ?? 1
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 10) {
    refuse('feature', `${path}/radiusM`, 'expected radiusM in 0.1..10 m; omit it for 1 or write a number in that range')
  }
  return value
}

/** Registration file: M3 holds the test kind, M4 kinds are registered, and M5 kinds are registered; M6 appends theirs here. */
export const FEATURE_KINDS: Readonly<Record<string, FeatureFactory>> = {
  marker: markerFactory,
  boostLane: boostLaneFeature,
  launchPad: launchPadFeature,
  catchVolume: catchVolumeFeature,
  rollingLog: rollingLogFeature,
  doorBank: doorBankFeature,
  swimVolume: swimVolumeFeature,
  [CARRY_KIND]: carryItemFeature,
  tileField: tileFieldFeature,
  hexField: hexFieldFeature,
  memoryTiles: memoryTilesFeature,
  annulus: annulusFeature,
  sweep: sweepFeature,
  risingKill: risingKillFeature,
}

export function createFeatures(course: ResolvedCourse, path: string): CourseFeature[] {
  const specs = course.features ?? []
  if (specs.length > MAX_FEATURES) {
    refuse('feature', `${path}#/features`, `too many features (${specs.length}); keep at most ${MAX_FEATURES}`)
  }
  const known = Object.keys(FEATURE_KINDS)
  const ids = new Set<string>()
  const features: CourseFeature[] = []
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const featurePath = `${path}#/features/${i}`
    const factory = FEATURE_KINDS[spec.kind]
    if (factory === undefined) {
      refuse('feature', `${featurePath}/kind`,
        `unknown feature kind '${spec.kind}'; known kinds: ${known.length === 0 ? '(none)' : known.join(', ')}`)
    }
    if (ids.has(spec.id)) {
      refuse('feature', `${featurePath}/id`, `duplicate feature id '${spec.id}'; give every feature a unique id`)
    }
    ids.add(spec.id)
    features.push(factory(spec, featurePath))
  }
  return features
}
