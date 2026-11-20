import { axis, button, getComponent, isNull, readColumn, setComponent, setLinvel, tick } from 'ege'
import { AXIS_MOVE_X, AXIS_MOVE_Z, BUTTON_DIVE, BUTTON_GRAB, BUTTON_JUMP, Character, EgeBodyProps, EgeTransform, EgeVelocity, ShowCharacterRef, ShowControl } from '../components.gen'
import { characterColumn, seatColumn, transformOf, velocityOf } from '../lib/seats.as'
import { TICK_DT } from '../lib/units.as'
import {
  BTN_DIVE_BIT,
  BTN_GRAB_BIT,
  BTN_JUMP_BIT,
  CHAR_FILTER,
  CHAR_MEMBERSHIPS,
  CARRY_NONE,
  GRAVITY_Y,
  MODE_AIR,
  MODE_GROUND,
  MODE_GRABBING,
  MODE_STUNNED,
  PROTECTED_FILTER
} from './constants.as'
import { newGround, probeGround } from './ground.as'
import { grabPass, holdLever, pullGrabRefs, pushGrabRefs, releaseGrab, startLeverGrab } from './grab.as'
import { newMove, settleTimer, stepMoves } from './moves.as'

// S1 wire code (sim/input): moveX bits 0..7, moveZ bits 8..15, jump 16, dive 17, grab 18.
// Axis bytes decode as clamp(byte,0,254)-127 divided by 127; see packages/sim/src/input.ts.
// A show_control.code of 0 is therefore a full diagonal (-1,-1), not neutral: scene construction seeds
// SHOW_CONTROL_NEUTRAL (32639) instead of relying on the record's default. See ege/sceneEmitter.ts.
function controlAxis(code: u32, shift: u32): f64 {
  let v: u32 = (code >> shift) & 0xFF
  if (v > 254) v = 254
  return <f64>(<i32>v - 127) / 127.0
}

function controlButtons(code: u32): u32 {
  let b: u32 = 0
  if ((code & 0x10000) != 0) b |= BTN_JUMP_BIT
  if ((code & 0x20000) != 0) b |= BTN_DIVE_BIT
  if ((code & 0x40000) != 0) b |= BTN_GRAB_BIT
  return b
}

export function rf_character_pre(): void {
  const characters = characterColumn()
  const refs = readColumn<ShowCharacterRef>(ShowCharacterRef.ID, ShowCharacterRef.SIZE)
  const now = tick()
  if (now == 0) {
    for (let i: u32 = 0; i < characters.count; i++) {
      const ch = characters.at(i)
      ch.grab_target = -1
      ch.grab_lever = -1
      ch.ground_item = -1
      ch.ground_body = -1
      ch.ground_obstacle = -1
    }
  }
  // Entity-typed grab references are authoritative in show_character_ref, so a rebuilt domain
  // reads its remapped ids before the controller uses them.
  pullGrabRefs(characters, refs)

  const seats = seatColumn()
  const ground = newGround()
  const move = newMove()
  for (let i: u32 = 0; i < characters.count; i++) {
    const entity = characters.entity(i)
    const ch = characters.at(i)
    if (ch.parked != 0) {
      if (ch.stroke_timer > 0) ch.stroke_timer--
      ch.pre_vel_0 = 0
      ch.pre_vel_1 = 0
      ch.pre_vel_2 = 0
      setLinvel(entity, 0, 0, 0)
      continue
    }

    ch.slid = 0
    const frozen: bool = ch.frozen != 0
    const seatRow = seats.find(entity)
    if (seatRow < 0) continue
    const player = seats.at(<u32>seatRow).player
    // show_control, when the seat carries it, replaces the SDK slot for every control source.
    const control = getComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE)
    let mx: f64 = 0.0
    let mz: f64 = 0.0
    let buttons: u32 = 0
    if (!isNull<ShowControl>(control)) {
      if (!frozen) {
        mx = controlAxis(control.code, 0)
        mz = controlAxis(control.code, 8)
        buttons = controlButtons(control.code)
      }
    } else if (!frozen) {
      mx = <f64>axis(player, AXIS_MOVE_X)
      mz = <f64>axis(player, AXIS_MOVE_Z)
      if (button(player, BUTTON_JUMP)) buttons |= BTN_JUMP_BIT
      if (button(player, BUTTON_DIVE)) buttons |= BTN_DIVE_BIT
      if (button(player, BUTTON_GRAB)) buttons |= BTN_GRAB_BIT
    }
    const pressed = buttons & ~ch.prev_buttons
    ch.prev_buttons = buttons
    const mlen = Math.sqrt(mx * mx + mz * mz)
    if (mlen > 1.0) {
      mx /= mlen
      mz /= mlen
    }

    const protectedNow = <i32>now < ch.protected_until
    const bodyProps = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
    if (!isNull<EgeBodyProps>(bodyProps)) {
      if (protectedNow && bodyProps.groups_override != 1) {
        bodyProps.groups_override = 1
        bodyProps.memberships = CHAR_MEMBERSHIPS
        bodyProps.filter = PROTECTED_FILTER
        setComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, bodyProps)
      } else if (!protectedNow && bodyProps.groups_override == 1 && bodyProps.filter != CHAR_FILTER) {
        bodyProps.groups_override = 1
        bodyProps.memberships = CHAR_MEMBERSHIPS
        bodyProps.filter = CHAR_FILTER
        setComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, bodyProps)
      }
    }

    const transform = transformOf(entity)
    let px: f64 = 0
    let py: f64 = 0
    let pz: f64 = 0
    if (!isNull<EgeTransform>(transform)) {
      px = <f64>transform.pos_0
      py = <f64>transform.pos_1
      pz = <f64>transform.pos_2
    }
    const velocity = velocityOf(entity)
    let vx0: f64 = 0
    let vy0: f64 = 0
    let vz0: f64 = 0
    if (!isNull<EgeVelocity>(velocity)) {
      vx0 = <f64>velocity.lin_0
      vy0 = <f64>velocity.lin_1
      vz0 = <f64>velocity.lin_2
    }
    const wasGrounded: bool = ch.grounded != 0
    probeGround(px, py, pz, vy0, ch.stand, TICK_DT, ground)
    ch.grounded = ground.grounded
    ch.ground_entity = ground.entity
    ch.ground_obstacle = ground.obstacle
    stepMoves(ch, ground, frozen, protectedNow, mx, mz, mlen, buttons, pressed, wasGrounded, vx0, vy0, vz0, TICK_DT, move)

    let mode = move.mode
    if (move.wasSliding == 0 && (mode == MODE_GROUND || mode == MODE_AIR) && !protectedNow && ch.carry == CARRY_NONE &&
        (pressed & BTN_GRAB_BIT) != 0 && ch.grab_cooldown == 0 && startLeverGrab(entity, ch, px, py, pz)) {
      mode = MODE_GRABBING
    }
    if (mode != MODE_GRABBING && (ch.grab_target >= 0 || ch.grab_lever >= 0)) releaseGrab(entity, ch)
    if (ch.grab_lever >= 0) holdLever(entity, ch)
    ch.timer = settleTimer(mode, move.timer)
    ch.mode = mode

    let vx = move.vx
    let vy = move.vy
    let vz = move.vz
    if (frozen) {
      vx = 0
      vz = 0
    } else if (mode == MODE_STUNNED) {
      vx = vx0
      vy = vy0
      vz = vz0
    }
    ch.pre_vel_0 = vx
    ch.pre_vel_1 = vy
    ch.pre_vel_2 = vz
    if (frozen) setLinvel(entity, 0, <f32>(vy + GRAVITY_Y * TICK_DT), 0)
    else setLinvel(entity, <f32>vx, <f32>(vy + GRAVITY_Y * TICK_DT), <f32>vz)
  }
  grabPass(characters, now, TICK_DT)
  pushGrabRefs(characters, refs)
  characters.write()
  refs.write()
}
