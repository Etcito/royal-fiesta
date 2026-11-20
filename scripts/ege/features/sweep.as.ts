import { cos, getComponent, pose, readColumn, readResource, setComponent, setPose, sin, tick } from 'ege'
import { EgeBodyProps, EgeBoxCollider, EgeRender, EgeTransform, Feature, FeatureSweep, FeatureSweepPart, FeatureSweepPhase, RoundRes } from '../components.gen'
import { knockSeat } from '../character/bump.as'
import { MODE_STUNNED } from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
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

function clamp(n: f64, lo: f64, hi: f64): f64 {
  return Math.max(lo, Math.min(hi, n))
}

// packages/sim/src/features/sweeps.ts:170-212: consult the active phase's bar and either
// knock the seat with the source's (8 horizontal, 4 up) vector or request a lethal fall.
export function rf_feature_sweep_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureSweep>(FeatureSweep.ID, FeatureSweep.SIZE)
  const phases = readColumn<FeatureSweepPhase>(FeatureSweepPhase.ID, FeatureSweepPhase.SIZE)
  const parts = readColumn<FeatureSweepPart>(FeatureSweepPart.ID, FeatureSweepPart.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    if (feature.live == 0) continue
    const owner = getComponent<Feature>(features.entity(i), Feature.ID, Feature.SIZE).index
    let pattern: u32 = 0
    for (let j: u32 = 0; j < phases.count; j++) {
      const phase = phases.at(j)
      if (phase.owner == owner && phase.index == feature.active) pattern = phase.pattern
    }
    // packages/sim/src/features/sweeps.ts:174: only survival and last-standing rounds make the laser lethal.
    const lethal = pattern == 0 && (round.kind == 1 || round.final_rule == 2)
    for (let s: u32 = 0; s < seats.count; s++) {
      const seat = seats.at(s)
      if (seat.status != 1) continue
      const entity = seats.entity(s)
      const row = characters.find(entity)
      if (row < 0) continue
      const ch = characters.at(<u32>row)
      if (now < ch.protected_until) continue
      if (!lethal && ch.mode == MODE_STUNNED) continue
      const at = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      for (let j: u32 = 0; j < parts.count; j++) {
        const part = parts.at(j)
        if (part.owner != owner) continue
        if (part.index == 1 && pattern == 0) continue
        const t = getComponent<EgeTransform>(parts.entity(j), EgeTransform.ID, EgeTransform.SIZE)
        const dx = <f64>at.pos_0 - <f64>t.pos_0
        const dz = <f64>at.pos_2 - <f64>t.pos_2
        // Rotate the seat into the bar's frame; half extents are the pre system's written pool sizes.
        const x = dx * feature.cos - dz * feature.sin
        const z = dx * feature.sin + dz * feature.cos
        const nx = x - clamp(x, -part.half_0, part.half_0)
        const nz = z - clamp(z, -part.half_2, part.half_2)
        // Distance from the character's vertical capsule segment to the cuboid.
        const ny = Math.max(0.0, Math.abs(<f64>at.pos_1 - <f64>t.pos_1) - ch.half_height - part.half_1)
        const reach = ch.radius + 0.05
        if (nx * nx + ny * ny + nz * nz > reach * reach) continue
        if (lethal) seat.kill_request = 1
        else {
          const d = Math.sqrt(nx * nx + nz * nz)
          const ux = d > 1e-9 ? nx / d : 0.0
          const uz = d > 1e-9 ? nz / d : (z < 0.0 ? -1.0 : 1.0)
          knockSeat(entity, ch,
            8.0 * (ux * feature.cos + uz * feature.sin),
            4.0,
            8.0 * (-ux * feature.sin + uz * feature.cos), now)
        }
        break
      }
    }
  }
  characters.write()
  seats.write()
}
