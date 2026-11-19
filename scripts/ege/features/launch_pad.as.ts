import { getComponent, readColumn, setComponent, setLinvel, tick } from 'ege'
import { EgeTransform, EgeVelocity, Feature, FeatureLaunchPad, FeatureLaunchPadSeat, Gate } from '../components.gen'
import { GRAVITY_Y } from '../character/constants.as'
import { inBox } from '../lib/boxes.as'
import { TICK_DT } from '../lib/units.as'
import { characterColumn, seatColumn } from '../lib/seats.as'

function nearestStage(x: f64, y: f64, z: f64): i32 {
  const gates = readColumn<Gate>(Gate.ID, Gate.SIZE)
  let best: i32 = -1
  let bestDistance: f64 = Infinity
  for (let i: u32 = 0; i < gates.count; i++) {
    const gate = gates.at(i)
    const dx = gate.respawn_t_0 - x
    const dy = gate.respawn_t_1 - y
    const dz = gate.respawn_t_2 - z
    const distance = dx * dx + dy * dy + dz * dz
    if (distance < bestDistance) {
      bestDistance = distance
      best = gate.stage
    }
  }
  return best
}

function pass(): void {
  const pads = readColumn<FeatureLaunchPad>(FeatureLaunchPad.ID, FeatureLaunchPad.SIZE)
  const rows = readColumn<FeatureLaunchPadSeat>(FeatureLaunchPadSeat.ID, FeatureLaunchPadSeat.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const nowTick = <i32>tick()
  const gravity = Math.abs(GRAVITY_Y)
  for (let i: u32 = 0; i < pads.count; i++) {
    const pad = pads.at(i)
    const feature = getComponent<Feature>(pads.entity(i), Feature.ID, Feature.SIZE)
    if (pad.placed == 0) {
      if (pad.recover_only == 1) pad.pad_stage = nearestStage(pad.center_0, pad.center_1, pad.center_2)
      pad.placed = 1
    }
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      const entity = seats.entity(j)
      const characterRow = characters.find(entity)
      if (characterRow < 0) continue
      const ch = characters.at(<u32>characterRow)
      const pos = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      for (let k: u32 = 0; k < rows.count; k++) {
        const row = rows.at(k)
        if (row.owner != feature.index || row.seat != seat.seat) continue
        row.alive = seat.status
        if (pad.recover_only == 1) {
          const protectedNow = nowTick < ch.protected_until
          if (protectedNow && row.prev_protected == 0) {
            row.last_fall = nearestStage(pos.pos_0, pos.pos_1, pos.pos_2)
          }
          row.prev_protected = protectedNow ? 1 : 0
        }
        const inside = inBox(pad.center_0, pad.center_1, pad.center_2,
          pad.half_0, pad.half_1, pad.half_2, pos.pos_0, pos.pos_1, pos.pos_2)
        const eligible = row.alive == 1 && (pad.recover_only == 0 ||
          (pad.pad_stage >= 0 && row.last_fall == pad.pad_stage))
        if (inside && row.inside == 0 && eligible) {
          // Source: packages/sim/src/features/launch.ts:65-71.
          const apexY = Math.max(<f64>pos.pos_1, pad.target_1) + pad.apex_m
          const vy = Math.sqrt(2 * gravity * (apexY - pos.pos_1))
          const duration = vy / gravity + Math.sqrt(2 * (apexY - pad.target_1) / gravity)
          row.launched = nowTick
          row.flight = <i32>Math.ceil(duration / TICK_DT)
          const vx = <f32>((pad.target_0 - pos.pos_0) / duration)
          const vz = <f32>((pad.target_2 - pos.pos_2) / duration)
          setLinvel(entity, vx, <f32>vy, vz)
          const velocity = getComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE)
          velocity.lin_0 = vx
          velocity.lin_1 = <f32>vy
          velocity.lin_2 = vz
          setComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE, velocity)
        }
        row.inside = inside ? 1 : 0
      }
    }
  }
  rows.write()
  pads.write()
}

// Handoff: Race feature courses: faults 0 and two-world equality test uses
// rf_feature_launch_pad_pre(): void and rf_feature_launch_pad_post(): void, attached
// by the schema schedule; state keys are feature_launch_pad and feature_launch_pad_seat.
// no handoff: Marker kind: emitter, post script, schema and the two race test files takes nothing from this card.
export function rf_feature_launch_pad_pre(): void { pass() }

export function rf_feature_launch_pad_post(): void { pass() }
