import { axis, cos, getComponent, readColumn, readResource, setComponent, setLinvel, sin, tick } from 'ege'
import { AXIS_MOVE_X, AXIS_MOVE_Z, EgeRender, EgeTransform, FeatureBoostLane, RoundRes } from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { TICK_DT, degToRad, ticksOf } from '../lib/units.as'
import { approach2, v3 } from '../lib/vec.as'
import { CHAR_GROUND_ACCEL, CHAR_MAX_RUN, GRAVITY_Y, MODE_AIR, MODE_GROUND, MODE_PARKED, MODE_SLIDE } from '../character/constants.as'

// Tint 0 is the base draw selected at packages/sim/src/features/boostLane.ts:118.
const BOOST_LANE_BASE_COLOR: u32 = 0x8C6BD9
// Tint 4 is the active draw selected at packages/sim/src/features/boostLane.ts:118.
const BOOST_LANE_ACTIVE_COLOR: u32 = 0x73D966

function boostUntil(feature: FeatureBoostLane, seat: u32): i32 {
  switch (seat) {
    case 0: return feature.boost_until_0
    case 1: return feature.boost_until_1
    case 2: return feature.boost_until_2
    case 3: return feature.boost_until_3
    case 4: return feature.boost_until_4
    case 5: return feature.boost_until_5
    case 6: return feature.boost_until_6
    default: return feature.boost_until_7
  }
}

function setBoostUntil(feature: FeatureBoostLane, seat: u32, value: i32): void {
  switch (seat) {
    case 0: feature.boost_until_0 = value; break
    case 1: feature.boost_until_1 = value; break
    case 2: feature.boost_until_2 = value; break
    case 3: feature.boost_until_3 = value; break
    case 4: feature.boost_until_4 = value; break
    case 5: feature.boost_until_5 = value; break
    case 6: feature.boost_until_6 = value; break
    default: feature.boost_until_7 = value
  }
}

function readyAt(feature: FeatureBoostLane, seat: u32): i32 {
  switch (seat) {
    case 0: return feature.ready_at_0
    case 1: return feature.ready_at_1
    case 2: return feature.ready_at_2
    case 3: return feature.ready_at_3
    case 4: return feature.ready_at_4
    case 5: return feature.ready_at_5
    case 6: return feature.ready_at_6
    default: return feature.ready_at_7
  }
}

function setReadyAt(feature: FeatureBoostLane, seat: u32, value: i32): void {
  switch (seat) {
    case 0: feature.ready_at_0 = value; break
    case 1: feature.ready_at_1 = value; break
    case 2: feature.ready_at_2 = value; break
    case 3: feature.ready_at_3 = value; break
    case 4: feature.ready_at_4 = value; break
    case 5: feature.ready_at_5 = value; break
    case 6: feature.ready_at_6 = value; break
    default: feature.ready_at_7 = value
  }
}

function inside(feature: FeatureBoostLane, transform: EgeTransform, s: f64, c: f64): bool {
  const dx = <f64>transform.pos_0 - feature.center_0
  const dz = <f64>transform.pos_2 - feature.center_2
  const x = c * dx + s * dz
  const y = <f64>transform.pos_1 - feature.center_1
  const z = c * dz - s * dx
  return Math.abs(x) <= feature.half_0 && Math.abs(y) <= feature.half_1 && Math.abs(z) <= feature.half_2
}

// Handoff: Race feature courses: faults 0 and two-world equality test uses
// `rf_feature_boost_lane_pre(): void` from this export; ege.schema.json attaches
// it at `rf.feature.boost_lane.pre`; state keys are feature_boost_lane.placed,
// boost_until and ready_at.
export function rf_feature_boost_lane_pre(): void {
  const features = readColumn<FeatureBoostLane>(FeatureBoostLane.ID, FeatureBoostLane.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const now = <i32>tick()
  for (let i: u32 = 0; i < features.count; i++) {
    const root = features.entity(i)
    const feature = features.at(i)
    const yaw = degToRad(feature.yaw_deg)
    if (feature.placed == 0) {
      const visualEntity = root + 1
      // Place the active stripe on the permanent purple belt. Only the
      // stripe changes tint when a seat is boosted.
      const belt = root + 2
      const transform = getComponent<EgeTransform>(belt, EgeTransform.ID, EgeTransform.SIZE)
      const stripe = getComponent<EgeRender>(belt, EgeRender.ID, EgeRender.SIZE)
      transform.pos_1 += stripe.params_1
      stripe.params_0 *= 0.25
      stripe.params_1 = 0.02
      setComponent(visualEntity, EgeTransform.ID, EgeTransform.SIZE, transform)
      setComponent(visualEntity, EgeRender.ID, EgeRender.SIZE, stripe)
      feature.placed = 1
    }
    const s = sin(-yaw)
    const c = cos(-yaw)
    const duration = <i32>Math.max(1.0, <f64>ticksOf(feature.duration_s))
    const recharge = <i32>Math.max(1.0, <f64>ticksOf(feature.recharge_s))
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      if (seat.status != 1) continue
      const entity = seats.entity(j)
      const characterRow = characters.find(entity)
      if (characterRow < 0) continue
      const ch = characters.at(<u32>characterRow)
      if (ch.mode == MODE_PARKED) continue
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const eligible = feature.eligibility == 0 || <i32>seat.team == round.trailing_team
      if (inside(feature, transform, s, c) && eligible && now >= readyAt(feature, seat.seat)) {
        setBoostUntil(feature, seat.seat, now + duration)
        setReadyAt(feature, seat.seat, now + duration + recharge)
      }
      const boosted = now < boostUntil(feature, seat.seat)
      const mode = ch.mode == MODE_GROUND || ch.mode == MODE_AIR || ch.mode == MODE_SLIDE
      if (!boosted || !mode) continue
      const mx = <f64>axis(seat.player, AXIS_MOVE_X)
      const mz = <f64>axis(seat.player, AXIS_MOVE_Z)
      const len = Math.sqrt(mx * mx + mz * mz)
      if (!(len > 0.0)) continue
      const velocity = v3(ch.pre_vel_0, ch.pre_vel_1 + GRAVITY_Y * TICK_DT, ch.pre_vel_2)
      const cap = CHAR_MAX_RUN + feature.boost
      const rate = CHAR_GROUND_ACCEL * TICK_DT
      approach2(velocity.x, velocity.z, mx / len * cap, mz / len * cap, rate, velocity)
      setLinvel(entity, <f32>velocity.x, <f32>velocity.y, <f32>velocity.z)
    }
    let anyBoosted = false
    for (let seat: u32 = 0; seat < 8; seat++) {
      if (boostUntil(feature, seat) > now) anyBoosted = true
    }
    const visual = getComponent<EgeRender>(root + 1, EgeRender.ID, EgeRender.SIZE)
    visual.color = anyBoosted ? BOOST_LANE_ACTIVE_COLOR : BOOST_LANE_BASE_COLOR
    setComponent(root + 1, EgeRender.ID, EgeRender.SIZE, visual)
  }
  features.write()
}
