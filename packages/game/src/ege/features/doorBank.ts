import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { listParam, numOf, numParam, objOf, vec3Of } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

// no handoff: Marker kind: emitter, post script, schema and the two race test files takes nothing from this card.
export const doorBankEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
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
    return row.doors.map((value, index) => {
      const doorPath = `${ptr}/doors/${index}`
      const door = objOf(value, doorPath)
      const t = vec3Of(door.t, `${doorPath}/t`)
      const size = vec3Of(door.size, `${doorPath}/size`)
      const dimensions = [size.x, size.y, size.z]
      dimensions.forEach((n, axis) => numOf(n, `${doorPath}/size/${axis}`, 0.1, 10))
      return {
        t: [t.x, t.y, t.z], size: dimensions, row: rowIndex, real,
        yaw: numOf(door.yawDeg, `${doorPath}/yawDeg`, -Infinity, Infinity),
      }
    })
  })
  const breakSpeed = numParam(spec, path, 'breakSpeed', 1, 20)
  const doors = rows.flat()
  const children: RawEntity[] = doors.map((door, index) => {
    const [x, y, z] = door.size
    const visual = visualOf('candy.mech-door', { x, y, z })
    return {
      name: `feature/${spec.id}/door/${index}`,
      body: { type: 'fixed' },
      colliders: [{ shape: 'box', half_extents: [x / 2, y / 2, z / 2], group: 'static' }],
      components: {
        'ege.transform': { pos: door.t, rot: [0, 0, 0, 1] },
        'ege.render': { ...visual, visible: 1 },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        feature_door_bank_door: {
          owner: ctx.index, index, row: door.row, real: door.real, t: door.t, size: door.size,
          yaw_deg: door.yaw, solid: 0, open: 0, revealed: 0, open_tick: -1,
        },
      },
    }
  })
  for (const [index, door] of doors.entries()) {
    for (let piece = 0; piece < 3; piece++) {
      children.push({
        name: `feature/${spec.id}/debris/${3 * index + piece}`,
        components: {
          'ege.transform': { pos: door.t, rot: [0, 0, 0, 1] },
          'ege.render': { shape: 1, color: visualOf('candy.wall-block', { x: 0, y: 0, z: 0 }).color, params: [door.size[0] * 0.15, door.size[1] * 0.15, door.size[2] * 0.15, 0], visible: 0 },
          feature_door_bank_debris: { owner: ctx.index, door: index, piece: piece - 1 },
        },
      })
    }
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.doorBank, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_door_bank: { break_speed: breakSpeed, door_count: doors.length, placed: 0 },
        'ege.transform': { pos: doors[0].t, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
