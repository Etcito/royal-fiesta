import { getComponent, isNull, newRecord, rayCast, RayHit } from 'ege'
import { EgeMover, EgeTransform, EgeVelocity, Surface } from '../components.gen'
import {
  CHAR_GROUND_MIN_NY,
  CHAR_GROUND_PROBE,
  MOVER_BOUNCE_PAD,
  MOVER_CONVEYOR,
  NO_ENTITY,
  PROBE_GROUPS,
  SURFACE_NORMAL
} from './constants.as'
import { slideFriction } from './constants.as'

@unmanaged
export class Ground {
  grounded: u32
  touching: u32
  entity: u32
  toi: f64
  nx: f64
  ny: f64
  nz: f64
  surface: u32
  friction: f64
  obstacle: i32
  riding: u32
  conveyor: u32
  baseX: f64
  baseY: f64
  baseZ: f64
  pad: u32
  padSpeed: f64
}

export function newGround(): Ground {
  return newRecord<Ground>(<u32>sizeof<Ground>())
}

function clearGround(out: Ground): void {
  out.grounded = 0
  out.touching = 0
  out.entity = NO_ENTITY
  out.toi = 0
  out.nx = 0
  out.ny = 0
  out.nz = 0
  out.surface = SURFACE_NORMAL
  out.friction = slideFriction(SURFACE_NORMAL)
  out.obstacle = -1
  out.riding = 0
  out.conveyor = 0
  out.baseX = 0
  out.baseY = 0
  out.baseZ = 0
  out.pad = 0
  out.padSpeed = 0
}

function pointVelocity(entity: u32, x: f64, y: f64, z: f64, out: Ground): void {
  const velocity = getComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE)
  if (isNull<EgeVelocity>(velocity)) return
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  let px: f64 = 0
  let py: f64 = 0
  let pz: f64 = 0
  if (!isNull<EgeTransform>(transform)) {
    px = <f64>transform.pos_0
    py = <f64>transform.pos_1
    pz = <f64>transform.pos_2
  }
  const rx = x - px
  const ry = y - py
  const rz = z - pz
  out.baseX = <f64>velocity.lin_0 + <f64>velocity.ang_1 * rz - <f64>velocity.ang_2 * ry
  out.baseY = <f64>velocity.lin_1 + <f64>velocity.ang_2 * rx - <f64>velocity.ang_0 * rz
  out.baseZ = <f64>velocity.lin_2 + <f64>velocity.ang_0 * ry - <f64>velocity.ang_1 * rx
}

/** Handoff: 'Character systems rf.character.pre and rf.character.post with schedule registration' calls `probeGround` and `newGround`; this probe fills the scratch `Ground` from one engine ray hit. It uses `slideFriction` from constants.as.ts:168 as documented at `slideFriction` there. */
export function probeGround(x: f64, y: f64, z: f64, vy: f64, stand: f64, dt: f64, out: Ground): Ground {
  clearGround(out)
  let reach = stand + CHAR_GROUND_PROBE + Math.max(0.0, -vy) * dt
  const hit = rayCast(<f32>x, <f32>y, <f32>z, 0.0, -1.0, 0.0, <f32>reach, PROBE_GROUPS)
  if (changetype<usize>(hit) == 0) return out
  if (<f64>hit.ny < CHAR_GROUND_MIN_NY) return out

  out.grounded = 1
  out.touching = <u32>(<f64>hit.toi <= stand + CHAR_GROUND_PROBE)
  out.entity = hit.entity
  out.toi = <f64>hit.toi
  out.nx = <f64>hit.nx
  out.ny = <f64>hit.ny
  out.nz = <f64>hit.nz
  const surface = getComponent<Surface>(hit.entity, Surface.ID, Surface.SIZE)
  if (!isNull<Surface>(surface)) {
    out.surface = surface.kind
    out.friction = surface.friction
    out.obstacle = surface.obstacle
  }

  const mover = getComponent<EgeMover>(hit.entity, EgeMover.ID, EgeMover.SIZE)
  if (!isNull<EgeMover>(mover)) {
    if (mover.kind == MOVER_CONVEYOR) {
      out.conveyor = 1
      out.baseX = <f64>mover.vec_0
      out.baseY = <f64>mover.vec_1
      out.baseZ = <f64>mover.vec_2
    } else if (mover.kind == MOVER_BOUNCE_PAD) {
      out.pad = 1
      out.padSpeed = <f64>mover.a
    } else if (mover.kind == 1 || mover.kind == 2 || mover.kind == 3 || mover.kind == 4 || mover.kind == 7) {
      out.riding = 1
      pointVelocity(hit.entity, x, y - out.toi, z, out)
    }
  } else if (!isNull<EgeVelocity>(getComponent<EgeVelocity>(hit.entity, EgeVelocity.ID, EgeVelocity.SIZE))) {
    out.riding = 1
    pointVelocity(hit.entity, x, y - out.toi, z, out)
  }
  return out
}
