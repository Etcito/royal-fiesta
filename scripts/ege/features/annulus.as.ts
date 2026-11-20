import { cos, getComponent, isNull, pose, readColumn, readResource, setComponent, setLinvel, setPose, sin, tick } from 'ege'
import { EgeBoxCollider, EgeRender, EgeTransform, Feature, FeatureAnnulus, FeatureAnnulusSegment, RoundRes } from '../components.gen'
import { GRAVITY_Y } from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { TICK_DT, degToRad } from '../lib/units.as'

// TAU is the full turn used by packages/sim/src/features/annulus.ts:53.
const TAU: f64 = 2.0 * Math.PI
// packages/sim/src/features/annulus.ts:161 draws candy.floor-tile; E4 fixes its base colour.
const ANNULUS_COLOR: u32 = 0xF5D0E0

// The source writes the floor-tile transform of packages/sim/src/features/annulus.ts:151-165.
function writePose(entity: u32, x: f64, y: f64, z: f64, theta: f64): void {
  const at = pose(<f32>x, <f32>y, <f32>z)
  at.qy = <f32>sin(theta / 2.0)
  at.qw = <f32>cos(theta / 2.0)
  setPose(entity, at)
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  transform.pos_0 = <f32>x
  transform.pos_1 = <f32>y
  transform.pos_2 = <f32>z
  transform.rot_0 = 0
  transform.rot_1 = <f32>sin(theta / 2.0)
  transform.rot_2 = 0
  transform.rot_3 = <f32>cos(theta / 2.0)
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

export function rf_feature_annulus_pre(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureAnnulus>(FeatureAnnulus.ID, FeatureAnnulus.SIZE)
  const segments = readColumn<FeatureAnnulusSegment>(FeatureAnnulusSegment.ID, FeatureAnnulusSegment.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick() - <i32>round.intro_ticks
  const overtime = round.phase == 2
  for (let i: u32 = 0; i < features.count; i++) {
    const rootEntity = features.entity(i)
    const feature = features.at(i)
    const owner = getComponent<Feature>(rootEntity, Feature.ID, Feature.SIZE).index
    // packages/sim/src/features/annulus.ts:51-54.
    const mid = (feature.inner_m + feature.outer_m) / 2.0
    const radialHalf = (feature.outer_m - feature.inner_m) / 2.0
    const stepRad = TAU / <f64>feature.segments
    const tangHalf = mid * sin(stepRad / 2.0) + 0.02
    const halfY = feature.thick_m / 2.0
    // packages/sim/src/features/annulus.ts:108-111: overtime adds half a tick per tick.
    if (overtime) feature.overtime_ticks = feature.overtime_ticks + 1
    const effective = <f64>now + <f64>feature.overtime_ticks / 2.0
    const radPerSec = degToRad(feature.speed_deg_s)
    const angle = radPerSec * effective / 60.0
    // packages/sim/src/features/annulus.ts:76: overtime carries at 1.5x.
    const omega = radPerSec * (overtime ? 1.5 : 1.0)
    const first = feature.placed == 0
    for (let j: u32 = 0; j < segments.count; j++) {
      const segment = segments.at(j)
      if (segment.owner != owner) continue
      const theta = angle + <f64>segment.index * stepRad
      const x = feature.center_0 + mid * sin(theta)
      const y = feature.center_1
      const z = feature.center_2 + mid * cos(theta)
      const entity = segments.entity(j)
      writePose(entity, x, y, z, theta)
      if (!first) continue
      const collider = getComponent<EgeBoxCollider>(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE)
      if (!isNull<EgeBoxCollider>(collider)) {
        collider.half_extents_0 = <f32>tangHalf
        collider.half_extents_1 = <f32>halfY
        collider.half_extents_2 = <f32>radialHalf
        setComponent(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE, collider)
      }
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      if (!isNull<EgeRender>(render)) {
        render.params_0 = <f32>tangHalf
        render.params_1 = <f32>halfY
        render.params_2 = <f32>radialHalf
        render.params_3 = 0
        render.color = ANNULUS_COLOR
        render.visible = 1
        setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
      }
    }
    if (first) feature.placed = 1
    // packages/sim/src/features/annulus.ts:75-84: carry each alive grounded seat.
    for (let k: u32 = 0; k < seats.count; k++) {
      const seat = seats.at(k)
      if (seat.status != 1) continue
      const seatEntity = seats.entity(k)
      const row = characters.find(seatEntity)
      if (row < 0) continue
      const ch = characters.at(<u32>row)
      if (ch.grounded == 0) continue
      let riding = false
      for (let j: u32 = 0; j < segments.count; j++) {
        const segment = segments.at(j)
        if (segment.owner == owner && segments.entity(j) == ch.ground_entity) riding = true
      }
      if (!riding) continue
      const transform = getComponent<EgeTransform>(seatEntity, EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(transform)) continue
      const dx = <f64>transform.pos_0 - feature.center_0
      const dz = <f64>transform.pos_2 - feature.center_2
      setLinvel(seatEntity,
        <f32>(<f64>ch.pre_vel_0 + omega * dz),
        <f32>(<f64>ch.pre_vel_1 + GRAVITY_Y * TICK_DT),
        <f32>(<f64>ch.pre_vel_2 - omega * dx))
    }
  }
  features.write()
}
