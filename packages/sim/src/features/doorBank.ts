import { orderedSeatIndices } from './seatState.ts'
import { CHAR, CharMode } from '../character/constants.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { degToRad, quatAxisAngle, quatIdentity, v3, yawFacing } from '../vec.ts'
import type { Quat, Vec3 } from '../vec.ts'
import { GRAVITY_Y } from '../world.ts'
import type { FeatureFactory } from './feature.ts'
import { listParam, numOf, numParam, objOf, vec3Of } from './params.ts'

interface Door {
  t: Vec3
  size: Vec3
  r: Quat
  normal: { x: number; z: number }
  body: number
  solid: boolean
  open: boolean
  revealed: boolean
  openTick: number
}

export const doorBankFeature: FeatureFactory = (spec, path) => {
  const rows = listParam(spec, path, 'rows', 1, 8).map((value, rowIndex) => {
    const ptr = `${path}/rows/${rowIndex}`
    const row = objOf(value, ptr)
    if (!Array.isArray(row.doors) || row.doors.length < 2 || row.doors.length > 8) {
      refuse('feature', `${ptr}/doors`, 'expected 2..8 doors; write a list of door objects')
    }
    const real = numOf(row.real, `${ptr}/real`, 1, row.doors.length - 1)
    if (!Number.isInteger(real)) {
      refuse('feature', `${ptr}/real`, 'expected a whole number of solid doors in 1..doors-1')
    }
    const doors: Door[] = row.doors.map((entry, index) => {
      const dp = `${ptr}/doors/${index}`
      const door = objOf(entry, dp)
      const t = vec3Of(door.t, `${dp}/t`)
      const size = vec3Of(door.size, `${dp}/size`)
      numOf(size.x, `${dp}/size/0`, 0.1, 10)
      numOf(size.y, `${dp}/size/1`, 0.1, 10)
      numOf(size.z, `${dp}/size/2`, 0.1, 10)
      const yaw = degToRad(numOf(door.yawDeg, `${dp}/yawDeg`, -Infinity, Infinity))
      return {
        t, size, r: quatAxisAngle(v3(0, 1, 0), yaw, quatIdentity()),
        normal: yawFacing(yaw, { x: 0, z: 1 }), body: -1,
        solid: false, open: false, revealed: false, openTick: -1,
      }
    })
    return { doors, real, maxZ: Math.max(...doors.map(door => door.t.z)) }
  })
  const breakSpeed = numParam(spec, path, 'breakSpeed', 1, 20)
  const doors = rows.flatMap(row => row.doors)
  const pos = v3(0, 0, 0), vel = v3(0, 0, 0)
  let tick = 0, dt = 1 / 60

  return {
    id: spec.id,
    kind: 'doorBank',
    init(ctx) {
      tick = ctx.tick
      dt = ctx.physics.dt
      for (const row of rows) {
        const indices = row.doors.map((_, i) => i)
        for (let i = 0; i < row.real; i++) {
          const j = ctx.rng.int(i, indices.length - 1)
          const swap = indices[i]
          indices[i] = indices[j]
          indices[j] = swap
          row.doors[indices[i]].solid = true
        }
        for (const door of row.doors) {
          const { t, size, r } = door
          door.body = ctx.physics.createBody(
            ctx.R.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z).setRotation(r),
            [ctx.R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
              .setCollisionGroups(groups(G.STATIC, G.CHAR | G.PROBE | G.DEBRIS))],
          )
        }
      }
    },
    preStep(ctx) {
      tick = ctx.tick
      dt = ctx.physics.dt
      const margin = CHAR.radius + 0.1
      for (const i of orderedSeatIndices(ctx.seats)) {
        if (ctx.seats.status(i) !== PlayerStatus.alive || ctx.seats.protectedNow(i)) continue
        ctx.seats.pos(i, pos)
        ctx.seats.vel(i, vel)
        for (const door of doors) {
          if (door.open) continue
          const { t, size, normal: n } = door
          const dx = pos.x + vel.x * dt - t.x
          const dy = pos.y + vel.y * dt - t.y
          const dz = pos.z + vel.z * dt - t.z
          if (Math.abs(dx * n.z - dz * n.x) > size.x / 2 + margin ||
              Math.abs(dy) > size.y / 2 + margin ||
              Math.abs(dx * n.x + dz * n.z) > size.z / 2 + margin) continue
          const side = (pos.x - t.x) * n.x + (pos.z - t.z) * n.z
          const toward = (vel.x * n.x + vel.z * n.z) * (side > 0 ? -1 : 1)
          if (ctx.seats.mode(i) !== CharMode.dive && toward < breakSpeed) continue
          if (!door.solid) {
            door.open = true
            door.openTick = tick
            ctx.physics.body(door.body).collider(0).setEnabled(false)
            ctx.sound('mech.door-break', t, 1)
          } else if (!door.revealed) {
            door.revealed = true
            ctx.sound('mech.door', t, 1)
          }
        }
      }
    },
    postStep(ctx) { tick = ctx.tick },
    snapshot(w) {
      for (const door of doors) {
        w.u8(door.solid ? 1 : 0)
        w.u8(door.open ? 1 : 0)
        w.u8(door.revealed ? 1 : 0)
        w.i32(door.openTick)
      }
    },
    restore(r, ctx) {
      tick = ctx.tick
      dt = ctx.physics.dt
      for (const door of doors) {
        door.solid = r.u8() !== 0
        door.open = r.u8() !== 0
        door.revealed = r.u8() !== 0
        door.openTick = r.i32()
        const collider = ctx.physics.body(door.body).collider(0)
        if (collider.isEnabled() === door.open) collider.setEnabled(!door.open)
      }
    },
    draw(out) {
      for (const door of doors) {
        const { t, r, size, normal: n } = door
        if (!door.open) {
          out.push({ asset: 'candy.mech-door', t: { ...t }, r: { ...r }, s: { ...size }, visible: true, tint: 0 })
          continue
        }
        const age = tick - door.openTick
        if (age < 0 || age >= 60) continue
        const seconds = age * dt
        for (let piece = -1; piece <= 1; piece++) {
          const spread = piece * 0.4 * size.x * age / 60
          out.push({
            asset: 'candy.wall-block',
            t: v3(t.x + n.z * spread, t.y + 0.5 * GRAVITY_Y * seconds * seconds, t.z - n.x * spread),
            r: { ...r }, s: v3(size.x * 0.3, size.y * 0.3, size.z * 0.3), visible: true, tint: 0,
          })
        }
      }
    },
    botTarget(_seat, position, out) {
      for (const row of rows) {
        if (row.maxZ <= position.z - 0.5) continue
        let best: Door | undefined
        let distance = Infinity
        const hasOpen = row.doors.some(door => door.open)
        for (const door of row.doors) {
          if (hasOpen ? !door.open : door.revealed) continue
          const dx = door.t.x - position.x, dz = door.t.z - position.z
          const d2 = dx * dx + dz * dz
          if (d2 < distance) { best = door; distance = d2 }
        }
        if (!best) return false
        Object.assign(out, best.t)
        return true
      }
      return false
    },
  }
}
