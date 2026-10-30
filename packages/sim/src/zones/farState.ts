import type { SnapWriter } from '@gamesaloon/rollback'
import type { FarReader } from '@gamesaloon/rollback/zones'
import type { CharState } from '../character/system.ts'
import { datan2, TAU } from '../detmath.ts'

/** Display-only pose; yaw is in radians, with zero facing +Z. */
export interface FarEntity {
  seat: number
  x: number
  y: number
  z: number
  yaw: number
  mode: number
  status: number
}

const YAW_STEPS = 1 << 16
const ENTRY_BYTES = 2 + 4 + 4 + 4 + 2 + 1 + 1

/** Writes the count for the session to promote into the FAR header. Seats must be unique. */
export function encodeFar(
  w: SnapWriter,
  entities: readonly (Pick<CharState, 'pos' | 'facing' | 'mode'> & { seat: number; status: number })[],
): void {
  w.u16(entities.length)
  // Select by seat without sorting or copying the caller's simulation records.
  let previous = -1
  for (let i = 0; i < entities.length; i++) {
    let next = -1
    for (let j = 0; j < entities.length; j++) {
      const seat = entities[j].seat
      if (seat > previous && (next < 0 || seat < entities[next].seat)) next = j
    }
    const entity = entities[next]
    w.u16(entity.seat)
    w.f32(entity.pos.x)
    w.f32(entity.pos.y)
    w.f32(entity.pos.z)
    const yaw = datan2(entity.facing.x, entity.facing.z)
    w.u16(Math.round(yaw * YAW_STEPS / TAU) & 0xffff)
    w.u8(entity.mode)
    w.u8(entity.status)
    previous = entity.seat
  }
}

/**
 * Reads entries only, returning the active prefix length (zero for a short payload).
 * Keep out as a pool: it never shrinks, so smaller packets preserve warmed entries.
 */
export function decodeFar(r: FarReader, n: number, out: FarEntity[]): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff || r.remaining < n * ENTRY_BYTES) return 0
  for (let i = 0; i < n; i++) {
    let entity = out[i]
    if (entity === undefined) {
      entity = { seat: 0, x: 0, y: 0, z: 0, yaw: 0, mode: 0, status: 0 }
      out[i] = entity
    }
    entity.seat = r.u16()
    entity.x = r.f32()
    entity.y = r.f32()
    entity.z = r.f32()
    entity.yaw = r.u16() * TAU / YAW_STEPS
    entity.mode = r.u8()
    entity.status = r.u8()
  }
  return n
}
