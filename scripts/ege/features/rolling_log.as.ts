import { atan2, cos, getComponent, readColumn, setComponent, setPose, sin, tick, pose } from 'ege'
import { Character, EgeTransform, FeatureRollingLog } from '../components.gen'
import { CHAR_BUMP_MIN_SPEED, CHAR_KNOCK_GAIN, CHAR_KNOCK_NORMAL, CHAR_KNOCK_UP, MODE_STUNNED } from '../character/constants.as'
import { knockSeat } from '../character/bump.as'
import { characterColumn, seatColumn } from '../lib/seats.as'

class LogPose {
  x: f64 = 0
  y: f64 = 0
  z: f64 = 0
  qx: f64 = 0
  qy: f64 = 0
  qz: f64 = 0
  qw: f64 = 1
  ax: f64 = 0
  az: f64 = 0
  dx: f64 = 0
  dy: f64 = 0
  dz: f64 = 0
  vx: f64 = 0
  vy: f64 = 0
  vz: f64 = 0
}

function poseAt(rec: FeatureRollingLog, now: i32): LogPose {
  const out = new LogPose()
  const dx = rec.to_0 - rec.from_0
  const dy = rec.to_1 - rec.from_1
  const dz = rec.to_2 - rec.from_2
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const h = Math.sqrt(dx * dx + dz * dz)
  const dirX = dx / h
  const dirZ = dz / h
  const axisX = dz / h
  const axisZ = -dx / h
  const pathX = dx / distance
  const pathY = dy / distance
  const pathZ = dz / distance
  const travelS = distance / rec.speed
  const pauseS = (rec.period_s - 2 * travelS) / 2
  const periodTicks = <i32>Math.max(1, Math.round(rec.period_s * 60))
  const phaseTicks = rec.phase_s > 0 ? <i32>Math.max(1, Math.round(rec.phase_s * 60)) : 0
  let c = (now + phaseTicks) % periodTicks
  if (c < 0) c += periodTicks
  const s = <f64>c / 60
  const t2 = travelS + pauseS
  const t3 = t2 + travelS
  let u = 0.0
  let signed = 0.0
  if (s < travelS) {
    u = s / travelS
    signed = distance * u
    out.vx = pathX * rec.speed
    out.vy = pathY * rec.speed
    out.vz = pathZ * rec.speed
  } else if (s < t2) {
    u = 1
    signed = distance
  } else if (s < t3) {
    u = 1 - (s - t2) / travelS
    signed = distance * u
    out.vx = -pathX * rec.speed
    out.vy = -pathY * rec.speed
    out.vz = -pathZ * rec.speed
  }
  out.x = rec.from_0 + dx * u
  out.y = rec.from_1 + dy * u
  out.z = rec.from_2 + dz * u
  out.ax = axisX
  out.az = axisZ
  out.dx = dirX
  out.dz = dirZ
  const half = signed / rec.radius / 2
  const rs = sin(half)
  const rc = cos(half)
  const angle = atan2(dirX, dirZ) / 2
  const os = sin(angle)
  const oc = cos(angle)
  // Hamilton product: roll * orient * Z(-PI/2), matching quatMul in packages/sim/src/vec.ts:96.
  const aX = axisX * rs
  const aZ = axisZ * rs
  const bY = os
  const bW = oc
  const rX = aX * bW - aZ * bY
  const rY = rc * bY
  const rZ = aZ * bW + aX * bY
  const rW = rc * bW
  const hs = sin(-Math.PI / 4)
  const hc = cos(-Math.PI / 4)
  out.qx = rW * 0 + rX * hc + rY * hs
  out.qy = rW * 0 + rY * hc - rX * hs
  out.qz = rW * hs + rZ * hc
  out.qw = rW * hc - rZ * hs
  return out
}

function writePose(entity: u32, p: LogPose): void {
  const bodyPose = pose(<f32>p.x, <f32>p.y, <f32>p.z)
  bodyPose.qx = <f32>p.qx
  bodyPose.qy = <f32>p.qy
  bodyPose.qz = <f32>p.qz
  bodyPose.qw = <f32>p.qw
  setPose(entity, bodyPose)
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  transform.pos_0 = <f32>p.x
  transform.pos_1 = <f32>p.y
  transform.pos_2 = <f32>p.z
  transform.rot_0 = <f32>p.qx
  transform.rot_1 = <f32>p.qy
  transform.rot_2 = <f32>p.qz
  transform.rot_3 = <f32>p.qw
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

export function rf_feature_rolling_log_pre(): void {
  const features = readColumn<FeatureRollingLog>(FeatureRollingLog.ID, FeatureRollingLog.SIZE)
  const now = <i32>tick() + 1
  for (let i: u32 = 0; i < features.count; i++) writePose(features.entity(i), poseAt(features.at(i), now))
}

export function rf_feature_rolling_log_post(): void {
  const features = readColumn<FeatureRollingLog>(FeatureRollingLog.ID, FeatureRollingLog.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    const p = poseAt(feature, now + 1)
    const half = feature.length / 2
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      if (seat.status != 1) continue
      const entity = seats.entity(j)
      const row = characters.find(entity)
      if (row < 0) continue
      const ch = characters.at(<u32>row)
      if (now < ch.protected_until || ch.mode == MODE_STUNNED) continue
      const reach = feature.radius + ch.radius + 0.05
      const t = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const rx = <f64>t.pos_0 - p.x
      const ry = <f64>t.pos_1 - p.y
      const rz = <f64>t.pos_2 - p.z
      const along = rx * p.ax + rz * p.az
      const clamped = along < -half ? -half : along > half ? half : along
      const nx = rx - p.ax * clamped
      const ny = ry
      const nz = rz - p.az * clamped
      const d2 = nx * nx + ny * ny + nz * nz
      if (!(d2 < reach * reach)) continue
      const d = Math.sqrt(d2)
      const ux = d > 1e-9 ? nx / d : 0
      const uy = d > 1e-9 ? ny / d : 1
      const uz = d > 1e-9 ? nz / d : 0
      if (!(p.vx * ux + p.vy * uy + p.vz * uz > CHAR_BUMP_MIN_SPEED)) continue
      const planar = Math.sqrt(ux * ux + uz * uz)
      const px = planar > 1e-9 ? ux / planar : p.dx
      const pz = planar > 1e-9 ? uz / planar : p.dz
      knockSeat(entity, ch, p.vx * CHAR_KNOCK_GAIN + px * CHAR_KNOCK_NORMAL,
        CHAR_KNOCK_UP, p.vz * CHAR_KNOCK_GAIN + pz * CHAR_KNOCK_NORMAL, now)
    }
  }
  characters.write()
}
