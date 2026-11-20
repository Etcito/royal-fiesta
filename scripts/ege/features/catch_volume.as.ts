import { Column, getComponent, newRecord, readColumn, spawn, setComponent, tick } from 'ege'
import { Character, EgeTransform, Feature, FeatureCatchVolume, ShowFeatureMembership, ShowSeatIdentity, EgeZoneId, Gate, Seat } from '../components.gen'
import { releaseGrab } from '../character/grab.as'
import { inBox } from '../lib/boxes.as'
import { characterColumn, placeSeat, seatColumn } from '../lib/seats.as'

function insideOf(feature: FeatureCatchVolume, seat: u32): u32 {
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

function setInside(feature: FeatureCatchVolume, seat: u32, value: u32): void {
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
  const features = readColumn<FeatureCatchVolume>(FeatureCatchVolume.ID, FeatureCatchVolume.SIZE)
  const rows = show ? readColumn<ShowFeatureMembership>(ShowFeatureMembership.ID, ShowFeatureMembership.SIZE) : null
  const seats = seatColumn()
  const characters = characterColumn()
  const gates = readColumn<Gate>(Gate.ID, Gate.SIZE)
  const nowTick = <i32>tick()
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
      let now = inBox(
        feature.center_0, feature.center_1, feature.center_2,
        feature.half_0, feature.half_1, feature.half_2,
        <f64>transform.pos_0, <f64>transform.pos_1, <f64>transform.pos_2,
      )
      if (now && wasInside == 0 && seat.status == 1) {
        for (let k: u32 = 0; k < gates.count; k++) {
          const gate = gates.at(k)
          if (gate.index != feature.checkpoint) continue
          placeSeat(entity, ch, gate.respawn_t_0, gate.respawn_t_1, gate.respawn_t_2,
            gate.respawn_facing_0, gate.respawn_facing_1)
          transform.pos_0 = <f32>gate.respawn_t_0
          transform.pos_1 = <f32>(gate.respawn_t_1 + ch.stand + 0.01)
          transform.pos_2 = <f32>gate.respawn_t_2
          transform.rot_0 = 0
          transform.rot_1 = 0
          transform.rot_2 = 0
          transform.rot_3 = 1
          setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
          ch.parked = 0
          ch.grounded = 0
          ch.ground_obstacle = -1
          ch.ground_item = -1
          ch.ground_body = -1
          ch.coyote = 0
          ch.jump_buffer = 0
          ch.teleport_tick = nowTick
          if (ch.grab_lever >= 0) releaseGrab(entity, ch)
          now = show && inBox(
            feature.center_0, feature.center_1, feature.center_2,
            feature.half_0, feature.half_1, feature.half_2,
            <f64>transform.pos_0, <f64>transform.pos_1, <f64>transform.pos_2,
          )
          break
        }
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

export function rf_feature_catch_volume_pre(): void { scan() }
export function rf_feature_catch_volume_post(): void { scan() }
export function rf_feature_catch_volume_show_pre(): void { scan() }
export function rf_feature_catch_volume_show_post(): void { scan() }
