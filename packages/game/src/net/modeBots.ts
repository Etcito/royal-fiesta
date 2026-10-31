import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { CHAR, CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { Vec3 } from '@royal-fiesta/sim/vec'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { takeoverInput } from './takeoverBot.ts'

const STUCK_SPEED = 0.3
const STUCK_LIMIT = 90
const TAKEOVER_TICKS = 60
const DIVE_DIST = 2
const GRAB_DIST = 1
const GAP_AHEAD = 1
const GAP_DEPTH = 1.5

export interface ModeBotMemory {
  takeover: object
  target: Vec3 | null
  stuckTicks: number
}

export function newModeBotMemory(): ModeBotMemory {
  return { takeover: newMemory(), target: null, stuckTicks: 0 }
}

const goal: Vec3 = { x: 0, y: 0, z: 0 }
const candidates: { id: number; dist: number }[] = []
let scratchRay: InstanceType<RapierModule['Ray']> | null = null

/** Ground under the point one metre ahead of the feet; a downward 1.5 m ray that misses means a drop. */
function groundAhead(domain: FiestaDomain, x: number, y: number, z: number,
  dx: number, dz: number): boolean {
  if (scratchRay === null) scratchRay = new domain.ctx.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const ray = scratchRay
  ray.origin.x = x + dx * GAP_AHEAD
  ray.origin.y = y
  ray.origin.z = z + dz * GAP_AHEAD
  ray.dir.x = 0
  ray.dir.y = -1
  ray.dir.z = 0
  return domain.ctx.physics.world.castRay(ray, GAP_DEPTH, true) !== null
}

/** The nearest course path node in front of the steering direction carries its jump flag. */
function pathJumpAhead(course: ResolvedCourse, x: number, z: number, dx: number, dz: number): boolean {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < course.path.length; i++) {
    const node = course.path[i]
    const ax = node.p.x - x
    const az = node.p.z - z
    if (ax * dx + az * dz <= 0) continue
    const d = ax * ax + az * az
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best >= 0 && course.path[best].jump
}

function grabNear(domain: FiestaDomain, state: CharState): boolean {
  const pos = state.pos
  const facing = state.facing
  for (let i = 0; i < domain.features.length; i++) {
    const feature = domain.features[i]
    if (feature.grabCandidates === undefined) continue
    candidates.length = 0
    feature.grabCandidates(pos, facing, candidates)
    for (let c = 0; c < candidates.length; c++) {
      if (candidates[c].dist <= GRAB_DIST) return true
    }
  }
  return false
}

/** Feature-aware bot input: drive to the first course feature target, else the takeover path. */
export function modeBotInput(domain: FiestaDomain, memory: ModeBotMemory, seat: number,
  tick: number, out: PlayerInput): number {
  const state = domain.state(seat)
  if (state.mode === CharMode.parked || state.mode === CharMode.frozen ||
      domain.status(seat) !== PlayerStatus.alive) {
    decodeInput(NEUTRAL_CODE, out)
    memory.target = null
    memory.stuckTicks = 0
    return 0
  }
  const course = domain.obstacles.courses[0]
  const fallback = memory.stuckTicks >= STUCK_LIMIT
  if (!fallback) {
    goal.x = 0
    goal.y = 0
    goal.z = 0
    let found = false
    for (let i = 0; i < domain.features.length; i++) {
      const feature = domain.features[i]
      if (feature.botTarget !== undefined && feature.botTarget(seat, state.pos, goal)) {
        found = true
        break
      }
    }
    if (found) {
      const target = memory.target ?? (memory.target = { x: 0, y: 0, z: 0 })
      target.x = goal.x
      target.y = goal.y
      target.z = goal.z
      const dx = goal.x - state.pos.x
      const dz = goal.z - state.pos.z
      const len = Math.sqrt(dx * dx + dz * dz)
      const nx = len > 1e-6 ? dx / len : 0
      const nz = len > 1e-6 ? dz / len : 0
      const feet = state.pos.y - CHAR.halfHeight - CHAR.radius
      out.moveX = nx
      out.moveZ = nz
      out.jump = pathJumpAhead(course, state.pos.x, state.pos.z, nx, nz) ||
        !groundAhead(domain, state.pos.x, feet, state.pos.z, nx, nz)
      out.dive = state.grounded && len <= DIVE_DIST
      out.grab = grabNear(domain, state)
      const planar = Math.sqrt(state.vel.x * state.vel.x + state.vel.z * state.vel.z)
      memory.stuckTicks = planar < STUCK_SPEED ? memory.stuckTicks + 1 : 0
      return encodeInput(out)
    }
    memory.target = null
    memory.stuckTicks = 0
  } else {
    // A stuck bot runs the takeover path for 60 ticks before trying the features again.
    memory.target = null
    memory.stuckTicks++
    if (memory.stuckTicks >= STUCK_LIMIT + TAKEOVER_TICKS) memory.stuckTicks = 0
  }
  return takeoverInput(course, memory.takeover as Parameters<typeof takeoverInput>[1], state, tick, out)
}
