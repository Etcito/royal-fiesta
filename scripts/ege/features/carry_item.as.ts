import { getComponent, isNull, pose, readColumn, readResource, setAngvel, setComponent, setLinvel, setPose, tick } from 'ege'
import { Column, Pose } from 'ege'
import {
  Character, CourseRes, EgeBodyProps, EgeTransform, EgeVelocity, Feature, FeatureCarryItem, FeatureCarryItemHome,
  FeatureCarryItemItem, FeatureCarryItemSeat, Seat,
} from '../components.gen'
import {
  BTN_GRAB_BIT, CARRY_NONE, CARRY_OBJECT, CHAR_GRAB_RANGE, MODE_AIR, MODE_GROUND, MODE_PARKED, MODE_STUNNED,
} from '../character/constants.as'
import { inBox } from '../lib/boxes.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'

// packages/sim/src/features/carry.ts:78: the source ball is radius 0.35 with density 1; the emitter uses density 0.
const ITEM_RADIUS: f64 = 0.35
// packages/sim/src/features/carry.ts:60: hand = seat position + facing * 0.55, + 0.25 up.
const ITEM_HAND_FORWARD: f64 = 0.55
const ITEM_HAND_UP: f64 = 0.25

// Density-one sphere mass 4/3 pi r^3, the mass the source setDensity(1) ball had.
const ITEM_MASS: f64 = 4.0 / 3.0 * Math.PI * ITEM_RADIUS * ITEM_RADIUS * ITEM_RADIUS

function handPose(entity: u32, ch: Character): Pose {
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  const at = pose(
    <f32>(<f64>transform.pos_0 + <f64>ch.facing_0 * ITEM_HAND_FORWARD),
    <f32>(<f64>transform.pos_1 + ITEM_HAND_UP),
    <f32>(<f64>transform.pos_2 + <f64>ch.facing_1 * ITEM_HAND_FORWARD),
  )
  return at
}

function translationPose(entity: u32, x: f64, y: f64, z: f64, keepRotation: bool): Pose {
  const at = pose(<f32>x, <f32>y, <f32>z)
  if (keepRotation) {
    const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
    if (!isNull<EgeTransform>(transform)) {
      at.qx = transform.rot_0
      at.qy = transform.rot_1
      at.qz = transform.rot_2
      at.qw = transform.rot_3
    }
  }
  return at
}

function placeItem(entity: u32, x: f64, y: f64, z: f64, keepRotation: bool): void {
  setPose(entity, translationPose(entity, x, y, z, keepRotation))
}

function stopItem(entity: u32): void {
  setLinvel(entity, 0, 0, 0)
  setAngvel(entity, 0, 0, 0)
}

function massOf(owner: u32, items: Column<FeatureCarryItemItem>): void {
  for (let i: u32 = 0; i < items.count; i++) {
    if (items.at(i).owner != owner) continue
    const entity = items.entity(i)
    const props = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
    if (isNull<EgeBodyProps>(props)) continue
    props.additional_mass = <f32>ITEM_MASS
    setComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, props)
  }
}

function seatRowOf(seats: Column<Seat>, seatId: i32): i32 {
  for (let i: u32 = 0; i < seats.count; i++) {
    if (<i32>seats.at(i).seat == seatId) return <i32>i
  }
  return -1
}

function protectedHome(owner: u32, homes: Column<FeatureCarryItemHome>, team: u32, x: f64, y: f64, z: f64): bool {
  for (let i: u32 = 0; i < homes.count; i++) {
    const home = homes.at(i)
    if (home.owner != owner || home.team < 0 || <u32>home.team == team) continue
    if (inBox(home.center_0, home.center_1, home.center_2, home.half_0, home.half_1, home.half_2, x, y, z)) return true
  }
  return false
}

// no handoff: Emit carry items and their persistent records supplies the feature_carry_item records this
// system reads; the emitter has no callable entry point for the behaviour.
export function rf_feature_carry_item_pre(): void {
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const features = readColumn<FeatureCarryItem>(FeatureCarryItem.ID, FeatureCarryItem.SIZE)
  const items = readColumn<FeatureCarryItemItem>(FeatureCarryItemItem.ID, FeatureCarryItemItem.SIZE)
  const homes = readColumn<FeatureCarryItemHome>(FeatureCarryItemHome.ID, FeatureCarryItemHome.SIZE)
  const seatRecords = readColumn<FeatureCarryItemSeat>(FeatureCarryItemSeat.ID, FeatureCarryItemSeat.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const owner = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE).index
    const resetTicks = ticksOf(feature.reset_s)
    if (feature.placed == 0) {
      massOf(owner, items)
      feature.placed = 1
    }

    // Drop held items whose holder left, fell, was stunned or let go (carry.ts:85-104).
    for (let i: u32 = 0; i < items.count; i++) {
      const item = items.at(i)
      if (item.owner != owner || item.holder < 0) continue
      const row = seatRowOf(seats, item.holder)
      if (row < 0) {
        item.holder = -1
        item.last_touch_tick = now
        continue
      }
      const seat = seats.at(<u32>row)
      const entity = seats.entity(<u32>row)
      const chRow = characters.find(entity)
      if (chRow < 0) {
        item.holder = -1
        item.last_touch_tick = now
        continue
      }
      const ch = characters.at(<u32>chRow)
      const fallen = seat.status != 1 || ch.mode == MODE_PARKED
      const released = (ch.prev_buttons & BTN_GRAB_BIT) == 0
      if (!fallen && ch.mode != MODE_STUNNED && !released) continue
      const itemEntity = items.entity(i)
      // A parked seat has moved away: a fall keeps the item at its last hand pose (carry.ts:95).
      if (fallen) placeItem(itemEntity, item.last_hand_0, item.last_hand_1, item.last_hand_2, true)
      else {
        const at = handPose(entity, ch)
        placeItem(itemEntity, <f64>at.px, <f64>at.py, <f64>at.pz, true)
      }
      item.holder = -1
      ch.carry = CARRY_NONE
      ch.carry_id = -1
      item.last_touch_tick = now
      const velocity = getComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE)
      if (!isNull<EgeVelocity>(velocity)) setLinvel(itemEntity, velocity.lin_0, velocity.lin_1, velocity.lin_2)
      else setLinvel(itemEntity, 0, 0, 0)
    }

    // A carried item rides at its holder's hand with no velocity (carry.ts:105-116).
    for (let i: u32 = 0; i < items.count; i++) {
      const item = items.at(i)
      if (item.owner != owner || item.holder < 0) continue
      const row = seatRowOf(seats, item.holder)
      if (row < 0) continue
      const entity = seats.entity(<u32>row)
      const chRow = characters.find(entity)
      if (chRow < 0) continue
      const ch = characters.at(<u32>chRow)
      const at = handPose(entity, ch)
      item.last_hand_0 = <f64>at.px
      item.last_hand_1 = <f64>at.py
      item.last_hand_2 = <f64>at.pz
      const itemEntity = items.entity(i)
      placeItem(itemEntity, <f64>at.px, <f64>at.py, <f64>at.pz, true)
      stopItem(itemEntity)
      item.last_touch_tick = now
    }

    // Contested grabs run in ascending room seat (carry.ts:118-140).
    for (let rank: u32 = 0; rank < seats.count; rank++) {
      let row: i32 = -1
      for (let j: u32 = 0; j < seats.count; j++) {
        if (seats.at(j).seat == rank) {
          row = <i32>j
          break
        }
      }
      if (row < 0) continue
      const seat = seats.at(<u32>row)
      const entity = seats.entity(<u32>row)
      const chRow = characters.find(entity)
      if (chRow < 0) continue
      const ch = characters.at(<u32>chRow)
      const seatState = featureSeat(seatRecords, owner, rank)
      if (isNull<FeatureCarryItemSeat>(seatState)) continue
      const grab = (ch.prev_buttons & BTN_GRAB_BIT) != 0
      const pressed = grab && seatState.prev_grab == 0
      seatState.prev_grab = grab ? 1 : 0
      if (!pressed || seat.status != 1 || now < ch.protected_until || ch.carry != CARRY_NONE) continue
      if (ch.mode != MODE_GROUND && ch.mode != MODE_AIR) continue
      const seatTransform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(seatTransform)) continue
      const px = <f64>seatTransform.pos_0
      const py = <f64>seatTransform.pos_1
      const pz = <f64>seatTransform.pos_2
      let best: i32 = -1
      let bestD = CHAR_GRAB_RANGE * CHAR_GRAB_RANGE
      for (let i: u32 = 0; i < items.count; i++) {
        const item = items.at(i)
        if (item.owner != owner || item.holder >= 0) continue
        const itemEntity = items.entity(i)
        const at = getComponent<EgeTransform>(itemEntity, EgeTransform.ID, EgeTransform.SIZE)
        if (isNull<EgeTransform>(at)) continue
        const x = <f64>at.pos_0
        const y = <f64>at.pos_1
        const z = <f64>at.pos_2
        if (protectedHome(owner, homes, seat.team, x, y, z)) continue
        const dx = px - x
        const dy = py - y
        const dz = pz - z
        const d = dx * dx + dy * dy + dz * dz
        if (d <= bestD && (best < 0 || d < bestD)) {
          best = <i32>i
          bestD = d
        }
      }
      if (best < 0) continue
      const item = items.at(<u32>best)
      const itemEntity = items.entity(<u32>best)
      item.holder = <i32>seat.seat
      item.last_touch_tick = now
      ch.carry = CARRY_OBJECT
      ch.carry_id = best
      const at = handPose(entity, ch)
      item.last_hand_0 = <f64>at.px
      item.last_hand_1 = <f64>at.py
      item.last_hand_2 = <f64>at.pz
      placeItem(itemEntity, <f64>at.px, <f64>at.py, <f64>at.pz, true)
      stopItem(itemEntity)
    }

    // Untouched items reset on their timer or below the kill plane (carry.ts:141-150).
    for (let i: u32 = 0; i < items.count; i++) {
      const item = items.at(i)
      if (item.owner != owner || item.holder >= 0) continue
      const itemEntity = items.entity(i)
      const at = getComponent<EgeTransform>(itemEntity, EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(at)) continue
      if (now - item.last_touch_tick < resetTicks && <f64>at.pos_1 >= course.kill_plane_y) continue
      placeItem(itemEntity, item.spawn_0, item.spawn_1, item.spawn_2, false)
      stopItem(itemEntity)
      item.last_touch_tick = now
    }
  }
  items.write()
  seatRecords.write()
  characters.write()
  features.write()
}

function featureSeat(records: Column<FeatureCarryItemSeat>, owner: u32, seat: u32): FeatureCarryItemSeat {
  for (let i: u32 = 0; i < records.count; i++) {
    const record = records.at(i)
    if (record.owner == owner && record.seat == seat) return record
  }
  return changetype<FeatureCarryItemSeat>(0)
}
