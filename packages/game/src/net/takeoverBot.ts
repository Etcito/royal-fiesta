import { parseBehaviour } from '@royal-fiesta/sim/bots/behaviour'
import { evaluateBrain } from '@royal-fiesta/sim/bots/brain'
import type { BrainInput, BrainMemory } from '@royal-fiesta/sim/bots/brain'
import { updateRoute } from '@royal-fiesta/sim/bots/routes'
import type { RouteInput, RoutePlan } from '@royal-fiesta/sim/bots/routes'
import shortProfile from '../../../sim/src/bots/behaviours/short.bot.json' with { type: 'json' }
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'

const behaviour = parseBehaviour(shortProfile)
// Same progress threshold as BotSystem.
const STUCK_MOVE = 0.02

interface TakeoverMemory extends BrainMemory {
  takeover?: {
    brain: BrainInput
    input: RouteInput
    route: RoutePlan | null
    steer: RoutePlan | null
  }
}

/** Keep one newMemory() per seat in the caller's reused table, across domain moves.
 * Pass the holding FiestaDomain.state(seat), its course and the absolute input tick.
 * Domain obstacles load at tick zero, so their motion uses that same tick.
 */
export function takeoverInput(
  course: ResolvedCourse,
  memory: TakeoverMemory,
  state: CharState,
  tick: number,
  out: PlayerInput,
): number {
  if (!Number.isInteger(tick) || tick < 0) throw new RangeError('brain tick must be a nonnegative integer')
  if (state.mode === CharMode.parked || state.mode === CharMode.frozen) {
    decodeInput(NEUTRAL_CODE, out)
    return NEUTRAL_CODE
  }
  let cache = memory.takeover
  if (cache === undefined || cache.brain.course !== course) {
    cache = memory.takeover = {
      brain: { course, pos: state.pos, vel: state.vel, facing: state.facing,
        grounded: state.grounded, mode: state.mode, obstacleAhead: false, hazardNear: false },
      input: { course, behaviour, pos: state.pos, seed: 0, tick },
      route: null,
      steer: null,
    }
    memory.pathIndex = 0
    memory.stuckTicks = 0
    memory.lastX = state.pos.x
    memory.lastZ = state.pos.z
  }
  const dx = state.pos.x - memory.lastX, dz = state.pos.z - memory.lastZ
  memory.stuckTicks = Math.sqrt(dx * dx + dz * dz) < STUCK_MOVE ? memory.stuckTicks + 1 : 0
  memory.lastX = state.pos.x
  memory.lastZ = state.pos.z
  memory.ticks = tick

  const b = cache.brain
  b.pos = state.pos
  b.vel = state.vel
  b.facing = state.facing
  b.grounded = state.grounded
  b.mode = state.mode
  cache.input.pos = state.pos
  cache.input.tick = tick
  const route = updateRoute(cache.route, cache.input)
  if (cache.route !== route) {
    cache.route = route
    cache.steer = { ...route, waypoints: [] }
  }
  // Match BotSystem's ordered cursor: nearest-node steering alone can orbit a passed node.
  const list = route.waypoints
  let at = list.indexOf(memory.pathIndex)
  if (at < 0) {
    at = list.findIndex(w => w >= memory.pathIndex)
    if (at < 0) at = list.length - 1
  }
  while (at >= 0 && at < list.length - 1) {
    const node = course.path[list[at]]
    const x = node.p.x - state.pos.x, z = node.p.z - state.pos.z
    if (Math.sqrt(x * x + z * z) > behaviour.route.advanceDist) break
    at++
  }
  const steer = cache.steer!
  if (at >= 0) {
    memory.pathIndex = list[at]
    steer.waypoints[0] = memory.pathIndex
    steer.waypoints.length = 1
  } else steer.waypoints.length = 0
  const code = evaluateBrain(b, behaviour, steer, tick, memory.stuckTicks)
  decodeInput(code, out)
  return code
}
