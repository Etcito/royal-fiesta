import { cos, getComponent, pose, readColumn, rng, setComponent, setPose, sin, tick } from 'ege'
import { EgeBodyProps, EgeRender, EgeTransform, Feature, FeatureDoorBank, FeatureDoorBankDoor, FeatureDoorBankDebris } from '../components.gen'
import { GRAVITY_Y, MODE_DIVE } from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { degToRad, TICK_DT } from '../lib/units.as'
import { Quat4, quatAxisAngleY } from '../lib/vec.as'

function rotate(entity: u32, door: FeatureDoorBankDoor, body: bool): void {
  const q = quatAxisAngleY(degToRad(door.yaw_deg), new Quat4())
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  transform.rot_0 = <f32>q.x
  transform.rot_1 = <f32>q.y
  transform.rot_2 = <f32>q.z
  transform.rot_3 = <f32>q.w
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
  if (body) {
    const p = pose(<f32>door.t_0, <f32>door.t_1, <f32>door.t_2)
    p.qx = <f32>q.x
    p.qy = <f32>q.y
    p.qz = <f32>q.z
    p.qw = <f32>q.w
    setPose(entity, p)
  }
}

// no handoff: Marker kind: emitter, post script, schema and the two race test files takes nothing from this card.
export function rf_feature_door_bank_pre(): void {
  const features = readColumn<FeatureDoorBank>(FeatureDoorBank.ID, FeatureDoorBank.SIZE)
  const doors = readColumn<FeatureDoorBankDoor>(FeatureDoorBankDoor.ID, FeatureDoorBankDoor.SIZE)
  const debris = readColumn<FeatureDoorBankDebris>(FeatureDoorBankDebris.ID, FeatureDoorBankDebris.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  const indices = new StaticArray<u32>(8)
  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const root = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE)
    if (feature.placed == 0) {
      for (let row: u32 = 0; row < 8; row++) {
        let n: i32 = 0
        let real: u32 = 0
        for (let d: u32 = 0; d < doors.count; d++) {
          const door = doors.at(d)
          if (door.owner != root.index || door.row != row) continue
          indices[n++] = d
          real = door.real
        }
        for (let i: i32 = 0; i < <i32>real; i++) {
          const j = i + <i32>(rng(root.salt) % <u32>(n - i))
          const tmp = indices[i]
          indices[i] = indices[j]
          indices[j] = tmp
          doors.at(indices[i]).solid = 1
        }
      }
      for (let d: u32 = 0; d < doors.count; d++) {
        const door = doors.at(d)
        if (door.owner != root.index) continue
        rotate(doors.entity(d), door, true)
        for (let p: u32 = 0; p < debris.count; p++) {
          const piece = debris.at(p)
          if (piece.owner != root.index || piece.door != door.index) continue
          const entity = debris.entity(p)
          rotate(entity, door, false)
          const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
          render.params_0 = <f32>(door.size_0 * 0.15)
          render.params_1 = <f32>(door.size_1 * 0.15)
          render.params_2 = <f32>(door.size_2 * 0.15)
          render.params_3 = 0
          setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
        }
      }
      feature.placed = 1
    }
    for (let s: u32 = 0; s < seats.count; s++) {
      const seat = seats.at(s)
      if (seat.status != 1) continue
      const entity = seats.entity(s)
      const c = characters.find(entity)
      if (c < 0) continue
      const ch = characters.at(<u32>c)
      if (now < ch.protected_until) continue
      const p = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const vx = ch.pre_vel_0
      const vy = ch.pre_vel_1 + GRAVITY_Y * TICK_DT
      const vz = ch.pre_vel_2
      const margin = ch.radius + 0.1
      for (let d: u32 = 0; d < doors.count; d++) {
        const door = doors.at(d)
        if (door.owner != root.index || door.open != 0) continue
        const yaw = degToRad(door.yaw_deg)
        const nx = sin(yaw)
        const nz = cos(yaw)
        const dx = <f64>p.pos_0 + vx * TICK_DT - door.t_0
        const dy = <f64>p.pos_1 + vy * TICK_DT - door.t_1
        const dz = <f64>p.pos_2 + vz * TICK_DT - door.t_2
        if (Math.abs(dx * nz - dz * nx) > door.size_0 / 2 + margin ||
            Math.abs(dy) > door.size_1 / 2 + margin ||
            Math.abs(dx * nx + dz * nz) > door.size_2 / 2 + margin) continue
        const side = (<f64>p.pos_0 - door.t_0) * nx + (<f64>p.pos_2 - door.t_2) * nz
        const toward = (vx * nx + vz * nz) * (side > 0 ? -1 : 1)
        if (ch.mode != MODE_DIVE && toward < feature.break_speed) continue
        if (door.solid != 0) {
          door.revealed = 1
        } else {
          door.open = 1
          door.open_tick = now
          const doorEntity = doors.entity(d)
          const body = getComponent<EgeBodyProps>(doorEntity, EgeBodyProps.ID, EgeBodyProps.SIZE)
          body.colliders_enabled = 0
          setComponent(doorEntity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
          const render = getComponent<EgeRender>(doorEntity, EgeRender.ID, EgeRender.SIZE)
          render.visible = 0
          setComponent(doorEntity, EgeRender.ID, EgeRender.SIZE, render)
        }
      }
    }
    for (let p: u32 = 0; p < debris.count; p++) {
      const piece = debris.at(p)
      if (piece.owner != root.index) continue
      for (let d: u32 = 0; d < doors.count; d++) {
        const door = doors.at(d)
        if (door.owner != root.index || door.index != piece.door) continue
        const age = now - door.open_tick
        const visible = door.open != 0 && age >= 0 && age < 60
        const entity = debris.entity(p)
        const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
        const wanted: u32 = visible ? 1 : 0
        if (render.visible != wanted) {
          render.visible = wanted
          setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
        }
        if (visible) {
          const yaw = degToRad(door.yaw_deg)
          const spread = <f64>piece.piece * 0.4 * door.size_0 * <f64>age / 60.0
          const seconds = <f64>age * TICK_DT
          const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
          transform.pos_0 = <f32>(door.t_0 + cos(yaw) * spread)
          transform.pos_1 = <f32>(door.t_1 + 0.5 * GRAVITY_Y * seconds * seconds)
          transform.pos_2 = <f32>(door.t_2 - sin(yaw) * spread)
          setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
        }
        break
      }
    }
  }
  features.write()
  doors.write()
  debris.write()
}
