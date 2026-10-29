import type { Rng } from '@gamesaloon/rollback'
import type { ResolvedCourse } from '../course.ts'
import { dsincos } from '../detmath.ts'
import type { SinCos } from '../detmath.ts'
import { encodeInput, NEUTRAL_CODE } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import type { Vec3 } from '../vec.ts'
import { quatMul, quatRotate, v3 } from '../vec.ts'
import { FIXED_DT } from '@gamesaloon/rollback-rapier'
import { CHAR } from '../character/constants.ts'
import type { ObstacleSpec } from '../course.ts'
import { motionPose } from '../obstacles/motion.ts'
import { TAU } from '../detmath.ts'
import type { BotBehaviour, PhaseWindow } from './behaviour.ts'
import { bindBehaviour } from './behaviour.ts'
import { obstaclePhase } from './courseRead.ts'
import type { RoutePlan } from './routes.ts'

// Pure: reads only its arguments, so view-side pilots can share it.

const ADVANCE_DIST = 1.5
const WOBBLE_TICKS = 45
const JUMP_DIST = 2
const STUCK_MOVE = 0.02
const STUCK_TICKS = 30
const FINISH_DIVE_DIST = 3
const RETARGET_TICKS = 120
const RETARGET_RANDOM = 0.25
const ARRIVE_DIST = 0.5

export interface BotSkill { reactionTicks: number; aimError: number; jumpLead: number; diveChance: number }

export function rollSkill(rng: Rng): BotSkill {
  const reactionTicks = rng.int(0, 10)
  const aimError = rng.range(0, 0.2)
  const jumpLead = rng.range(0, 0.4)
  const diveChance = rng.range(0, 0.3)
  return { reactionTicks, aimError, jumpLead, diveChance }
}

// ticks drives the wobble (45) and survival re-target (120) cadences.
export interface BrainMemory { pathIndex: number; stuckTicks: number; lastX: number; lastZ: number; wobble: number; ticks: number }

export function newMemory(): BrainMemory {
  return { pathIndex: 0, stuckTicks: 0, lastX: 0, lastZ: 0, wobble: 0, ticks: 0 }
}

export interface BrainInput { course: ResolvedCourse; pos: Vec3; vel: Vec3; facing: { x: number; z: number }; grounded: boolean; mode: number; obstacleAhead: boolean; hazardNear: boolean; bot?: { behaviour: BotBehaviour; route: RoutePlan; localTick: number } }

const scratch: PlayerInput = { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }
const sc: SinCos = { s: 0, c: 0 }

function trackStuck(b: BrainInput, mem: BrainMemory): void {
  const dx = b.pos.x - mem.lastX
  const dz = b.pos.z - mem.lastZ
  if (Math.sqrt(dx * dx + dz * dz) < STUCK_MOVE) mem.stuckTicks++
  else mem.stuckTicks = 0
  mem.lastX = b.pos.x
  mem.lastZ = b.pos.z
}

// Buttons are pulsed on even ticks so a held condition still yields press edges.
function emit(dx: number, dz: number, jump: boolean, dive: boolean, tick: number): number {
  const len = Math.sqrt(dx * dx + dz * dz)
  const pulse = (tick & 1) === 0
  scratch.moveX = len > 1e-6 ? dx / len : 0
  scratch.moveZ = len > 1e-6 ? dz / len : 0
  scratch.jump = jump && pulse
  scratch.dive = dive && pulse
  scratch.grab = false
  return encodeInput(scratch)
}

export function raceBrain(b: BrainInput, skill: BotSkill, mem: BrainMemory, rng: Rng): number {
  if (b.bot) return evaluateBrain(b, b.bot.behaviour, b.bot.route, b.bot.localTick, mem.stuckTicks)
  // Fixed draw order every call: wobble candidate, then dive roll.
  const wobbleDraw = rng.range(-1, 1)
  const diveDraw = rng.next()
  const tick = mem.ticks
  mem.ticks = tick + 1
  if (tick % WOBBLE_TICKS === 0) mem.wobble = wobbleDraw
  trackStuck(b, mem)

  const path = b.course.path
  if (path.length === 0) return NEUTRAL_CODE
  if (mem.pathIndex >= path.length) mem.pathIndex = path.length - 1

  let node = path[mem.pathIndex]
  let dx = node.p.x - b.pos.x
  let dz = node.p.z - b.pos.z
  let dist = Math.sqrt(dx * dx + dz * dz)
  if (dist < ADVANCE_DIST && mem.pathIndex < path.length - 1) {
    mem.pathIndex++
    node = path[mem.pathIndex]
    dx = node.p.x - b.pos.x
    dz = node.p.z - b.pos.z
    dist = Math.sqrt(dx * dx + dz * dz)
  }

  dsincos(skill.aimError * mem.wobble, sc)
  const rx = dx * sc.c + dz * sc.s
  const rz = dz * sc.c - dx * sc.s

  const nodeNear = dist < JUMP_DIST + skill.jumpLead
  let jump = b.obstacleAhead || mem.stuckTicks > STUCK_TICKS || (node.jump && nodeNear)
  if (mem.stuckTicks > STUCK_TICKS && (tick & 1) === 0) mem.stuckTicks = 0

  let dive = node.dive && nodeNear
  const fin = b.course.finish
  if (!dive && fin !== null) {
    const fx = Math.max(0, Math.abs(b.pos.x - fin.center.x) - fin.half.x)
    const fz = Math.max(0, Math.abs(b.pos.z - fin.center.z) - fin.half.z)
    if (Math.sqrt(fx * fx + fz * fz) < FINISH_DIVE_DIST && diveDraw < skill.diveChance) dive = true
  }
  if (dive) jump = false
  return emit(rx, rz, jump, dive, tick)
}

function nearestNode(b: BrainInput): number {
  const path = b.course.path
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const dx = path[i].p.x - b.pos.x
    const dz = path[i].p.z - b.pos.z
    const d = dx * dx + dz * dz
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

export function survivalBrain(b: BrainInput, _skill: BotSkill, mem: BrainMemory, rng: Rng): number {
  if (b.bot) return evaluateBrain(b, b.bot.behaviour, b.bot.route, b.bot.localTick, mem.stuckTicks)
  // Fixed draw order every call: re-target choice, then random node.
  const choiceDraw = rng.next()
  const nodeDraw = rng.next()
  const tick = mem.ticks
  mem.ticks = tick + 1
  trackStuck(b, mem)

  const path = b.course.path
  if (path.length === 0) return NEUTRAL_CODE
  if (tick % RETARGET_TICKS === 0 || mem.pathIndex >= path.length) {
    mem.pathIndex = choiceDraw < RETARGET_RANDOM
      ? Math.min(path.length - 1, Math.floor(nodeDraw * path.length))
      : nearestNode(b)
  }

  const node = path[mem.pathIndex]
  let dx = node.p.x - b.pos.x
  let dz = node.p.z - b.pos.z
  // Stand still on the safe spot instead of orbiting it.
  if (Math.sqrt(dx * dx + dz * dz) < ARRIVE_DIST) { dx = 0; dz = 0 }
  const jump = b.hazardNear || mem.stuckTicks > STUCK_TICKS
  if (mem.stuckTicks > STUCK_TICKS && (tick & 1) === 0) mem.stuckTicks = 0
  return emit(dx, dz, jump, false, tick)
}

// Bounds in the route frame, including collider offsets/rotations and all primitive shapes.
function routeBounds(o: ObstacleSpec, tick: number | null, ux: number, uz: number) {
  const pose = tick === null ? { t: o.t, r: o.r } : motionPose(o, tick, 0, { t: v3(0, 0, 0), r: { x: 0, y: 0, z: 0, w: 1 } })
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const c of o.colliders) {
    const h = 'half' in c ? c.half : v3(c.radius, 'halfHeight' in c ? c.halfHeight + (c.shape === 'capsule' ? c.radius : 0) : c.radius, c.radius)
    const q = quatMul(pose.r, c.r, { x: 0, y: 0, z: 0, w: 1 })
    const t = quatRotate(pose.r, c.t, v3(0, 0, 0))
    const border = c.shape === 'roundCuboid' ? c.border : 0
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const p = quatRotate(q, v3(x * (h.x + border), y * (h.y + border), z * (h.z + border)), v3(0, 0, 0))
      p.x += t.x + pose.t.x; p.y += t.y + pose.t.y; p.z += t.z + pose.t.z
      const a = [p.x * ux + p.z * uz, p.x * uz - p.z * ux, p.y]
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a[i]); hi[i] = Math.max(hi[i], a[i]) }
    }
  }
  return { lo, hi }
}

// Authored intervals are inclusive and may extend past a cycle boundary (90..110 in a
// 100-tick cycle). Spinner windows use ticks of angular travel, including reverse rotation.
function inWindow(o: ObstacleSpec, tick: number, w: PhaseWindow): boolean {
  const ph = obstaclePhase(o, tick)
  const m = o.motion
  const period = ph.periodTicks ?? (m.kind === 'spinner' && m.radPerTick !== 0 ? TAU / Math.abs(m.radPerTick) : null)
  if (period === null) return tick >= w.from && tick <= w.to
  const cycle = ph.cycleTick ?? ph.value / (m.kind === 'spinner' ? Math.abs(m.radPerTick) : 1)
  const relative = (cycle - w.from) - Math.floor((cycle - w.from) / period) * period
  return relative <= w.to - w.from + 1e-9
}

// Pure snapshot evaluator. reactionTicks delays observation on the decision cadence; the
// initial delay is neutral. Predictive motion includes that latency, approach acceleration,
// and every integer tick of crossing. No retained decisions or random stream consumption.
export function evaluateBrain(b: BrainInput, behaviour: BotBehaviour, route: RoutePlan, tick: number, stuckTicks = 0): number {
  if (!Number.isInteger(tick) || tick < 0) throw new RangeError('brain tick must be a nonnegative integer')
  bindBehaviour(behaviour, b.course)
  const { reactionTicks, decisionTicks } = behaviour.tick
  if (tick < reactionTicks || !route.reachable) return NEUTRAL_CODE
  const observed = Math.floor((tick - reactionTicks) / decisionTicks) * decisionTicks
  const now = observed + reactionTicks
  const distance = (p: Vec3) => Math.hypot(p.x - b.pos.x, p.z - b.pos.z)
  let index = 0
  for (let i = 1; i < route.waypoints.length; i++) {
    if (distance(b.course.path[route.waypoints[i]].p) < distance(b.course.path[route.waypoints[index]].p)) index = i
  }
  if (index < route.waypoints.length - 1 && distance(b.course.path[route.waypoints[index]].p) <= behaviour.route.advanceDist) index++
  const node = b.course.path[route.waypoints[index]]
  if (!node) return NEUTRAL_CODE
  const dist = distance(node.p)
  if (dist <= behaviour.route.arriveDist) return NEUTRAL_CODE
  const ux = (node.p.x - b.pos.x) / dist, uz = (node.p.z - b.pos.z) / dist
  const along = b.pos.x * ux + b.pos.z * uz, across = b.pos.x * uz - b.pos.z * ux
  const speed = Math.max(0, b.vel.x * ux + b.vel.z * uz)
  const braking = speed * speed / (2 * CHAR.groundBrake)
  const nearby = b.course.obstacles.filter(o => {
    if (!['pendulum', 'spinner', 'movingPlatform'].includes(o.motion.kind)) return false
    const box = routeBounds(o, null, ux, uz)
    return box.hi[0] + CHAR.radius >= along && box.lo[0] - CHAR.radius <= along + dist &&
      across >= box.lo[1] - CHAR.radius && across <= box.hi[1] + CHAR.radius
  }).sort((a, c) => a.id < c.id ? -1 : a.id > c.id ? 1 : 0)
  const fin = b.course.finish
  const finishDist = fin === null ? Infinity : Math.hypot(Math.max(0, Math.abs(b.pos.x - fin.center.x) - fin.half.x), Math.max(0, Math.abs(b.pos.z - fin.center.z) - fin.half.z))
  // File order is priority; the first matching action wins. Distance and phase are AND gates.
  const matches = behaviour.rules.filter(r => {
    const d = r.predicate === 'nearFinish' ? finishDist : r.predicate === 'nearNode' ? dist : Math.min(...nearby.map(o => distance(o.t)))
    const predicate = r.predicate === 'always' || (r.predicate === 'obstacleAhead' && b.obstacleAhead) ||
      (r.predicate === 'hazardNear' && b.hazardNear) || (r.predicate === 'stuck' && stuckTicks >= behaviour.tick.stuckTicks) ||
      r.predicate === 'nearNode' || r.predicate === 'nearFinish'
    return predicate && (r.distance === null || d <= r.distance)
  })
  for (const o of nearby) {
    const box = routeBounds(o, null, ux, uz)
    const gap = box.lo[0] - CHAR.radius - along
    if (gap > behaviour.route.advanceDist + braking + speed * reactionTicks * FIXED_DT) continue
    const windows = matches.filter(r => r.phase !== null)
    let travel = 0, v = Math.min(CHAR.maxRun, speed)
    // Bounded by the route segment: obstacles past the target never delay this decision.
    const exit = Math.min(dist, box.hi[0] + CHAR.radius - along)
    for (let dt = 0; travel <= exit; dt++) {
      if (travel >= Math.max(0, gap)) {
        const at = now + dt
        if (windows.length && !windows.some(r => inWindow(o, at, r.phase!))) return NEUTRAL_CODE
        const pose = routeBounds(o, at, ux, uz)
        const lateral = across >= pose.lo[1] - CHAR.radius && across <= pose.hi[1] + CHAR.radius
        if (o.motion.kind === 'movingPlatform') {
          const feet = b.pos.y - CHAR.halfHeight - CHAR.radius
          if (along + travel < pose.lo[0] - CHAR.radius || along + travel > pose.hi[0] + CHAR.radius ||
            across < pose.lo[1] || across > pose.hi[1] || Math.abs(pose.hi[2] - feet) > CHAR.groundProbe + CHAR.radius) return NEUTRAL_CODE
        } else if (lateral && pose.lo[2] < b.pos.y + CHAR.halfHeight + CHAR.radius && pose.hi[2] > b.pos.y - CHAR.halfHeight - CHAR.radius) return NEUTRAL_CODE
      }
      v = Math.min(CHAR.maxRun, v + (b.grounded ? CHAR.groundAccel : CHAR.airAccel) * FIXED_DT)
      travel += v * FIXED_DT
    }
  }
  const rule = matches.find(r => r.phase === null || (nearby.length ? nearby.some(o => inWindow(o, observed, r.phase!)) : observed >= r.phase.from && observed <= r.phase.to))
  const pulse = (tick & 1) === 0
  return encodeInput({ moveX: ux, moveZ: uz, jump: rule?.action === 'jump' && pulse,
    dive: rule?.action === 'dive' && pulse, grab: rule?.action === 'grab' })
}
