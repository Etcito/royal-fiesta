import { Column, getComponent, newRecord, readColumn, spawn, setComponent, setLinvel } from 'ege'
import { Character, EgeTransform, Feature, FeatureSwimVolume, ShowFeatureMembership, ShowSeatIdentity, EgeZoneId, Seat } from '../components.gen'
import { inBox } from '../lib/boxes.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { TICK_DT } from '../lib/units.as'
import { CHAR_SWIM_DRAG, GRAVITY_Y, MODE_AIR, MODE_FROZEN, MODE_STUNNED, MODE_SWIM } from '../character/constants.as'

function insideOf(feature: FeatureSwimVolume, seat: u32): u32 {
  switch (seat) {
    case 0: return feature.inside_0
    case 1: return feature.inside_1
    case 2: return feature.inside_2
    case 3: return feature.inside_3
    case 4: return feature.inside_4
    case 5: return feature.inside_5
    case 6: return feature.inside_6
    default: return feature.inside_7
  }
}

function setInside(feature: FeatureSwimVolume, seat: u32, value: u32): void {
  switch (seat) {
    case 0: feature.inside_0 = value; break
    case 1: feature.inside_1 = value; break
    case 2: feature.inside_2 = value; break
    case 3: feature.inside_3 = value; break
    case 4: feature.inside_4 = value; break
    case 5: feature.inside_5 = value; break
    case 6: feature.inside_6 = value; break
    default: feature.inside_7 = value
  }
}

// Membership follows its character and is keyed by authored feature index across transfer.
function findMembership(rows: Column<ShowFeatureMembership>, index: u32, character: u32): i32 {
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.index == index && row.character == character) return <i32>i
  }
  return -1
}

function scan(): void {
  const identities = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const show = identities.count > 0
  const features = readColumn<FeatureSwimVolume>(FeatureSwimVolume.ID, FeatureSwimVolume.SIZE)
  const rows = show ? readColumn<ShowFeatureMembership>(ShowFeatureMembership.ID, ShowFeatureMembership.SIZE) : null
  const seats = seatColumn()
  const characters = characterColumn()
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    const root = features.entity(i)
    const index = show ? getComponent<Feature>(root, Feature.ID, Feature.SIZE).index : 0
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      const entity = seats.entity(j)
      const characterRow = characters.find(entity)
      if (characterRow < 0) continue
      const ch = characters.at(<u32>characterRow)
      let membership: ShowFeatureMembership | null = null
      let fresh: u32 = 0
      if (show) {
        const found = findMembership(rows!, index, entity)
        if (found >= 0) {
          membership = rows!.at(<u32>found)
          membership.owner = entity
          membership.feature = root
        } else {
          fresh = spawn()
          membership = newRecord<ShowFeatureMembership>(ShowFeatureMembership.SIZE)
          membership.owner = entity
          membership.feature = root
          membership.character = entity
          membership.index = index
          membership.inside = 0
          const identity = identities.at(<u32>identities.find(entity))
          const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
          zone.id = 0x40000000 + index * 64 + identity.room_seat
          zone.owner = identity.round_seat
          zone.group = identity.room_seat + 1
          setComponent<EgeZoneId>(fresh, EgeZoneId.ID, EgeZoneId.SIZE, zone)
        }
      }
      const wasInside = show ? membership!.inside : insideOf(feature, seat.seat)
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const now = seat.status == 1 && inBox(
        feature.center_0, feature.center_1, feature.center_2,
        feature.half_0, feature.half_1, feature.half_2,
        <f64>transform.pos_0, <f64>transform.pos_1, <f64>transform.pos_2,
      )
      if (now && ch.parked == 0 && ch.frozen == 0 && ch.mode != MODE_FROZEN && ch.mode != MODE_STUNNED) {
        ch.mode = MODE_SWIM
        ch.swim = 1
        ch.swim_drag = feature.drag
        ch.swim_buoyancy = feature.buoyancy
        const d = feature.drag > 0 ? feature.drag : CHAR_SWIM_DRAG
        const k = Math.max(0.0, 1.0 - d * TICK_DT)
        const vx = ch.pre_vel_0
        const vy = ch.pre_vel_1 + GRAVITY_Y * TICK_DT
        const vz = ch.pre_vel_2
        setLinvel(entity, <f32>(vx * k), <f32>(vy + feature.buoyancy * TICK_DT), <f32>(vz * k))
      } else if (!now && wasInside != 0) {
        ch.swim = 0
        ch.swim_drag = 0
        ch.swim_buoyancy = 0
        if (ch.parked == 0 && ch.frozen == 0 && ch.mode != MODE_FROZEN && ch.mode != MODE_STUNNED) ch.mode = MODE_AIR
      }
      if (show) {
        membership!.inside = now ? 1 : 0
        if (fresh != 0) setComponent<ShowFeatureMembership>(fresh, ShowFeatureMembership.ID, ShowFeatureMembership.SIZE, membership!)
      } else setInside(feature, seat.seat, now ? 1 : 0)
    }
  }
  if (show) rows!.write()
  characters.write()
  features.write()
}

export function rf_feature_swim_volume_pre(): void { scan() }
export function rf_feature_swim_volume_show_pre(): void { scan() }
