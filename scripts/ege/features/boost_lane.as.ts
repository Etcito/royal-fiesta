import { Column, axis, cos, getComponent, isNull, newRecord, readColumn, readResource, setComponent, setLinvel, sin, spawn, tick } from 'ege'
import { AXIS_MOVE_X, AXIS_MOVE_Z, Character, EgeRender, EgeTransform, Feature, FeatureBoostLane, RoundRes, ShowControl, ShowFeatureCooldown } from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { TICK_DT, degToRad, ticksOf } from '../lib/units.as'
import { approach2, v3 } from '../lib/vec.as'
import { CHAR_GROUND_ACCEL, CHAR_MAX_RUN, GRAVITY_Y, MODE_AIR, MODE_GROUND, MODE_PARKED, MODE_SLIDE } from '../character/constants.as'

// Tint 0 is the base draw selected at packages/sim/src/features/boostLane.ts:118.
const BOOST_LANE_BASE_COLOR: u32 = 0x8C6BD9
// Tint 4 is the active draw selected at packages/sim/src/features/boostLane.ts:118.
const BOOST_LANE_ACTIVE_COLOR: u32 = 0x73D966

// S1 wire code (sim/input): moveX bits 0..7 and moveZ bits 8..15; the same decode
// as scripts/ege/character/pre.as.ts.
function controlAxis(code: u32, shift: u32): f64 {
  let v: u32 = (code >> shift) & 0xFF
  if (v > 254) v = 254
  return <f64>(<i32>v - 127) / 127.0
}

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

// Place the active stripe on the permanent purple belt once per authored feature.
function placeLane(feature: FeatureBoostLane, root: u32): void {
  const visualEntity = root + 1
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

// The bounded boost: approach the boosted cap at the character's ground acceleration.
function boostSteer(feature: FeatureBoostLane, entity: u32, ch: Character, mx: f64, mz: f64): void {
  const len = Math.sqrt(mx * mx + mz * mz)
  if (!(len > 0.0)) return
  const velocity = v3(ch.pre_vel_0, ch.pre_vel_1 + GRAVITY_Y * TICK_DT, ch.pre_vel_2)
  const cap = CHAR_MAX_RUN + feature.boost
  const rate = CHAR_GROUND_ACCEL * TICK_DT
  approach2(velocity.x, velocity.z, mx / len * cap, mz / len * cap, rate, velocity)
  setLinvel(entity, <f32>velocity.x, <f32>velocity.y, <f32>velocity.z)
}

function tintLane(root: u32, anyBoosted: bool): void {
  const visual = getComponent<EgeRender>(root + 1, EgeRender.ID, EgeRender.SIZE)
  visual.color = anyBoosted ? BOOST_LANE_ACTIVE_COLOR : BOOST_LANE_BASE_COLOR
  setComponent(root + 1, EgeRender.ID, EgeRender.SIZE, visual)
}

function boostedMode(mode: u32): bool {
  return mode == MODE_GROUND || mode == MODE_AIR || mode == MODE_SLIDE
}

// The seat-owned cooldown row of one feature and character, found by identity
// rather than by a child-entity offset; transfer remaps the entity references.
function findCooldown(rows: Column<ShowFeatureCooldown>, featureIndex: u32, character: u32): i32 {
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.index == featureIndex && row.character == character) return <i32>i
  }
  return -1
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
    if (feature.placed == 0) placeLane(feature, root)
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
      if (now < boostUntil(feature, seat.seat) && boostedMode(ch.mode)) {
        boostSteer(feature, entity, ch, <f64>axis(seat.player, AXIS_MOVE_X), <f64>axis(seat.player, AXIS_MOVE_Z))
      }
    }
    let anyBoosted = false
    for (let seat: u32 = 0; seat < 8; seat++) {
      if (boostUntil(feature, seat) > now) anyBoosted = true
    }
    tintLane(root, anyBoosted)
  }
  features.write()
}

// Show path: the same bounded steering and stripe tint. Each seat's cooldown and boost
// window live in its own entity-owned row (show_feature_cooldown), keyed by feature index
// and character entity, instead of the fixed eight-seat arrays of the G6 export. A row is
// created on demand so a rebuilt show world never carries duplicate scene-authored timers.
// Schedule reads: seat, character, feature, round, show_control, show_feature_cooldown;
// writes: feature_boost_lane, show_feature_cooldown, ege.render, ege.transform, ege.velocity.
export function rf_feature_boost_lane_show_pre(): void {
  const features = readColumn<FeatureBoostLane>(FeatureBoostLane.ID, FeatureBoostLane.SIZE)
  const rows = readColumn<ShowFeatureCooldown>(ShowFeatureCooldown.ID, ShowFeatureCooldown.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const now = <i32>tick()
  for (let i: u32 = 0; i < features.count; i++) {
    const root = features.entity(i)
    const feature = features.at(i)
    const featureRow = getComponent<Feature>(root, Feature.ID, Feature.SIZE)
    const yaw = degToRad(feature.yaw_deg)
    if (feature.placed == 0) placeLane(feature, root)
    const s = sin(-yaw)
    const c = cos(-yaw)
    const duration = <i32>Math.max(1.0, <f64>ticksOf(feature.duration_s))
    const recharge = <i32>Math.max(1.0, <f64>ticksOf(feature.recharge_s))
    let anyBoosted = false
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      if (seat.status != 1) continue
      const entity = seats.entity(j)
      const characterRow = characters.find(entity)
      if (characterRow < 0) continue
      const ch = characters.at(<u32>characterRow)
      if (ch.mode == MODE_PARKED) continue
      const found = findCooldown(rows, featureRow.index, entity)
      let fresh: u32 = 0
      let window: ShowFeatureCooldown
      if (found >= 0) {
        window = rows.at(<u32>found)
        window.owner = entity
        window.feature = root
      } else {
        fresh = spawn()
        window = newRecord<ShowFeatureCooldown>(ShowFeatureCooldown.SIZE)
        window.owner = entity
        window.feature = root
        window.character = entity
        window.index = featureRow.index
        window.ready_at = 0
        window.boost_until = 0
      }
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const eligible = feature.eligibility == 0 || <i32>seat.team == round.trailing_team
      if (inside(feature, transform, s, c) && eligible && now >= window.ready_at) {
        window.boost_until = now + duration
        window.ready_at = now + duration + recharge
      }
      if (now < window.boost_until) anyBoosted = true
      if (now < window.boost_until && boostedMode(ch.mode)) {
        const control = getComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE)
        const mx = isNull<ShowControl>(control) ? <f64>axis(seat.player, AXIS_MOVE_X) : controlAxis(control.code, 0)
        const mz = isNull<ShowControl>(control) ? <f64>axis(seat.player, AXIS_MOVE_Z) : controlAxis(control.code, 8)
        boostSteer(feature, entity, ch, mx, mz)
      }
      if (fresh != 0) setComponent<ShowFeatureCooldown>(fresh, ShowFeatureCooldown.ID, ShowFeatureCooldown.SIZE, window)
    }
    tintLane(root, anyBoosted)
  }
  rows.write()
  features.write()
}
