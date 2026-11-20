import { cos, getComponent, pose, readColumn, readResource, setComponent, setPose, sin, tick } from 'ege'
import { EgeBodyProps, EgeBoxCollider, EgeRender, EgeTransform, Feature, FeatureSweep, FeatureSweepPart, FeatureSweepPhase, RoundRes } from '../components.gen'
import { degToRad, ticksOf } from '../lib/units.as'

// packages/sim/src/features/sweeps.ts:29 uses a 0.1 m thick bar.
const THICK: f64 = 0.1

function placePart(entity: u32, x: f64, y: f64, z: f64, angle: f64): void {
  const at = pose(<f32>x, <f32>y, <f32>z)
  at.qy = <f32>sin(angle / 2.0)
  at.qw = <f32>cos(angle / 2.0)
  setPose(entity, at)
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  transform.pos_0 = <f32>x
  transform.pos_1 = <f32>y
  transform.pos_2 = <f32>z
  transform.rot_0 = 0
  transform.rot_1 = at.qy
  transform.rot_2 = 0
  transform.rot_3 = at.qw
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

// no handoff: Declare sweep root, phase and part records takes nothing from this card.
export function rf_feature_sweep_pre(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureSweep>(FeatureSweep.ID, FeatureSweep.SIZE)
  const phases = readColumn<FeatureSweepPhase>(FeatureSweepPhase.ID, FeatureSweepPhase.SIZE)
  const parts = readColumn<FeatureSweepPart>(FeatureSweepPart.ID, FeatureSweepPart.SIZE)
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    const owner = getComponent<Feature>(features.entity(i), Feature.ID, Feature.SIZE).index
    const wasLive = feature.live
    const previous = feature.active
    if (round.phase == 2) feature.overtime_ticks++
    feature.effective = <f64>(<i32>tick() - <i32>round.intro_ticks) + <f64>feature.overtime_ticks / 2.0
    let active: u32 = 0
    for (let j: u32 = 0; j < phases.count; j++) {
      const phase = phases.at(j)
      if (phase.owner == owner && phase.index > active && <f64>ticksOf(phase.at_s) <= feature.effective) active = phase.index
    }
    feature.active = active
    for (let j: u32 = 0; j < phases.count; j++) {
      const phase = phases.at(j)
      if (phase.owner != owner || phase.index != active) continue
      const elapsed = feature.effective - <f64>ticksOf(phase.at_s)
      const telegraph = <f64>Math.max(1, ticksOf(feature.telegraph_s))
      feature.live = elapsed >= telegraph ? 1 : 0
      feature.just_live = feature.live != 0 && (wasLive == 0 || previous != active) ? 1 : 0
      const seconds = Math.max(0.0, elapsed - telegraph) / 60.0
      const angle = phase.pattern == 1 ? 0.0 : degToRad(phase.speed_deg_s * seconds)
      feature.cos = cos(angle)
      feature.sin = sin(angle)
      const travel = (seconds * phase.speed_mps + feature.length_m / 2.0) % (2.0 * feature.length_m)
      feature.slide = feature.length_m - Math.abs(travel - feature.length_m) - feature.length_m / 2.0
      for (let k: u32 = 0; k < parts.count; k++) {
        const part = parts.at(k)
        if (part.owner != owner) continue
        let halfX = feature.length_m / 2.0
        let halfY = Math.min(THICK, phase.height_m) / 2.0
        const halfZ = THICK / 2.0
        let x = feature.length_m / 2.0
        let y = phase.height_m - halfY
        if (phase.pattern == 1) {
          halfX = (feature.length_m - phase.gap_m) / 4.0
          halfY = phase.height_m / 2.0
          x = feature.slide + (part.index == 0 ? -1.0 : 1.0) * (phase.gap_m / 2.0 + halfX)
          y = halfY
        } else if (part.index == 1) {
          y = phase.height_m + phase.gap_m + halfY
        }
        const entity = parts.entity(k)
        placePart(entity, feature.center_0 + x * feature.cos, feature.center_1 + y, feature.center_2 - x * feature.sin, angle)
        part.half_0 = halfX
        part.half_1 = halfY
        part.half_2 = halfZ
        const collider = getComponent<EgeBoxCollider>(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE)
        collider.half_extents_0 = <f32>halfX
        collider.half_extents_1 = <f32>halfY
        collider.half_extents_2 = <f32>halfZ
        setComponent(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE, collider)
        const props = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
        props.colliders_enabled = feature.live != 0 && (part.index == 0 || phase.pattern != 0) ? 1 : 0
        setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, props)
        const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
        render.params_0 = <f32>halfX
        render.params_1 = <f32>halfY
        render.params_2 = <f32>halfZ
        render.params_3 = 0
        render.visible = part.index == 0 || phase.pattern != 0 ? 1 : 0
        render.color = feature.live != 0 ? 0xE04F5F : 0xFF6B9E
        setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
      }
    }
    feature.placed = 1
  }
  parts.write()
  features.write()
}
