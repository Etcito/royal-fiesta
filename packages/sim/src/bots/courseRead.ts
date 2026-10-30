import { regionOf } from '../course.ts'
import type { Box, CourseKind, MotionKind, ObstacleSpec, ResolvedCourse } from '../course.ts'
import { dsin, TAU } from '../detmath.ts'
import type { BodyRef, LeverSpec } from '../mechanismSpec.ts'
import { isKinematic, smoothstep01, triangleWave } from '../obstacles/motion.ts'
import type { Vec3 } from '../vec.ts'
import { BOT_ACTIONS } from './behaviour.ts'
import type { BotAction } from './behaviour.ts'

// Pure read-only view of an S2 ResolvedCourse for bot predicates. Every read returns fresh
// copies, so callers can never mutate the course, and equal inputs give deep-equal outputs.

export interface ReadPathNode {
  index: number; p: Vec3; jump: boolean; dive: boolean; region: number; wait?: string; pull?: string
}
export interface ReadRegion { id: number; center: Vec3; half: Vec3; adjacent: number[] }
export interface CourseNav { id: string; kind: CourseKind; path: ReadPathNode[]; regions: ReadRegion[]; finish: Box | null }
// handle is copied from the lever; rest is the handle body's rest position, in world space.
export interface ReadLever { index: number; id: string; handle: BodyRef; grabRange: number; rest: Vec3 }

// tickDriven: obstaclePhase is a pure function of the tick (the see-saw integrates loads).
export interface MechanismInfo {
  index: number; id: string; kind: MotionKind; kinematic: boolean; tickDriven: boolean
  periodTicks: number | null; center: Vec3; region: number
}

export interface MotionPhase {
  kind: MotionKind
  // Position inside the integer period, in 0..periodTicks-1; null without an integer period.
  cycleTick: number | null
  periodTicks: number | null
  // The scalar the simulation feeds motionPose: angle (spinner wrapped to [0, TAU), pendulum,
  // door) or offset weight (moving platform); 0 for motions without a tick-driven value.
  value: number
  moving: boolean
}

export interface CourseCapabilities {
  id: string; levers: readonly string[]; hasLevers: boolean; hasPath: boolean; hasRegions: boolean
  hasFinish: boolean; motionKinds: MotionKind[]; actions: BotAction[]
}

function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z }
}

// Floor modulo for integers, matching the simulation's floor-based wrap for negative ticks.
function wrap(t: number, period: number): number {
  return t - Math.floor(t / period) * period
}

export function readNavigation(c: ResolvedCourse): CourseNav {
  return {
    id: c.id,
    kind: c.kind,
    path: c.path.map((n, index) => {
      const read: ReadPathNode = { index, p: vec(n.p), jump: n.jump, dive: n.dive, region: regionOf(c, n.p) }
      if (n.wait !== undefined) read.wait = n.wait
      if (n.pull !== undefined) read.pull = n.pull
      return read
    }),
    regions: c.regions.map(r => ({ id: r.id, center: vec(r.box.center), half: vec(r.box.half), adjacent: r.adjacent.slice() })),
    finish: c.finish === null ? null : { center: vec(c.finish.center), half: vec(c.finish.half) },
  }
}

// Region ids reachable from `id` in one step; [] for an unknown region.
export function regionNeighbours(c: ResolvedCourse, id: number): number[] {
  for (const r of c.regions) if (r.id === id) return r.adjacent.slice()
  return []
}

// Region-to-region hops along adjacency (breadth first, in file order); -1 when unreachable.
export function regionDistance(c: ResolvedCourse, from: number, to: number): number {
  if (from === to) return c.regions.some(r => r.id === from) ? 0 : -1
  const seen = new Set<number>([from])
  let frontier = [from]
  for (let d = 1; frontier.length > 0; d++) {
    const next: number[] = []
    for (const id of frontier) {
      for (const n of regionNeighbours(c, id)) {
        if (n === to) return d
        if (!seen.has(n)) { seen.add(n); next.push(n) }
      }
    }
    frontier = next
  }
  return -1
}

// Index of the path node closest to p in XZ (first wins on ties); -1 on an empty path.
export function nearestPathIndex(c: ResolvedCourse, p: Vec3): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < c.path.length; i++) {
    const dx = c.path[i].p.x - p.x
    const dz = c.path[i].p.z - p.z
    const d = dx * dx + dz * dz
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

function periodOf(o: ObstacleSpec): number | null {
  const m = o.motion
  return m.kind === 'pendulum' || m.kind === 'rotatingDoor' || m.kind === 'movingPlatform' ? m.periodTicks : null
}

export function readMechanisms(c: ResolvedCourse): MechanismInfo[] {
  return c.obstacles.map((o, index) => ({
    index, id: o.id, kind: o.motion.kind, kinematic: isKinematic(o.motion.kind), tickDriven: o.motion.kind !== 'seesaw',
    periodTicks: periodOf(o), center: vec(o.t), region: regionOf(c, o.t),
  }))
}

// One entry per LeverSpec; the rest position comes from the handle body, which the loader
// has already placed in world space through the item pose.
export function readLevers(c: ResolvedCourse): ReadLever[] {
  const mechanisms = c.mechanisms
  if (!mechanisms) return []
  return mechanisms.levers.map((l, index) => leverRead(mechanisms, l, index))
}

function leverRead(mechanisms: NonNullable<ResolvedCourse['mechanisms']>, l: LeverSpec, index: number): ReadLever {
  const rest = mechanisms.items[l.handle.item]?.bodies[l.handle.body]?.rest.t
  return {
    index, id: l.id, handle: { item: l.handle.item, body: l.handle.body },
    grabRange: l.grabRange, rest: rest === undefined ? { x: 0, y: 0, z: 0 } : vec(rest),
  }
}

// The lever with this id, or null when the course has no mechanisms or no such lever.
export function leverByPull(c: ResolvedCourse, id: string): ReadLever | null {
  return readLevers(c).find(l => l.id === id) ?? null
}

// Index of a signal id in mechanisms.signals (switches, then levers, then logic); -1 if absent.
export function signalIndex(c: ResolvedCourse, id: string): number {
  return c.mechanisms?.signals.indexOf(id) ?? -1
}

// Phase of an obstacle at round-local tick L (ObstacleSystem.localTick), using the same
// expressions as motionPose so the value reproduces the simulated pose bit for bit.
export function obstaclePhase(o: ObstacleSpec, localTick: number): MotionPhase {
  if (!Number.isInteger(localTick)) throw new RangeError(`localTick must be an integer; got ${localTick}`)
  const L = localTick
  const m = o.motion
  switch (m.kind) {
    case 'static':
    case 'conveyor':
    case 'bouncePad':
    case 'seesaw':
      return { kind: m.kind, cycleTick: null, periodTicks: null, value: 0, moving: m.kind === 'conveyor' }
    case 'spinner': {
      const a = m.phase + m.radPerTick * L
      return { kind: m.kind, cycleTick: null, periodTicks: null, value: a - TAU * Math.floor(a / TAU), moving: m.radPerTick !== 0 }
    }
    case 'pendulum':
      return {
        kind: m.kind, cycleTick: wrap(L, m.periodTicks), periodTicks: m.periodTicks,
        value: m.amp * dsin(TAU * L / m.periodTicks + m.phase), moving: m.amp !== 0,
      }
    case 'rotatingDoor': {
      const tau = L + m.phaseTicks
      const k = Math.floor(tau / m.periodTicks)
      const cycle = tau - k * m.periodTicks
      return {
        kind: m.kind, cycleTick: cycle, periodTicks: m.periodTicks,
        value: m.stepAngle * (k + smoothstep01(cycle / m.moveTicks)), moving: cycle < m.moveTicks,
      }
    }
    case 'movingPlatform':
      return {
        kind: m.kind, cycleTick: wrap(L, m.periodTicks), periodTicks: m.periodTicks,
        value: m.wave === 'sine' ? dsin(TAU * L / m.periodTicks + m.phase) : triangleWave(L / m.periodTicks + m.phase / TAU),
        moving: true,
      }
  }
}

// True when the obstacle's integer cycle tick at L lies in [from, to] (inclusive).
export function phaseInWindow(o: ObstacleSpec, localTick: number, from: number, to: number): boolean {
  const ph = obstaclePhase(o, localTick)
  return ph.cycleTick !== null && ph.cycleTick >= from && ph.cycleTick <= to
}

// Capabilities for bindBehaviour: useLever is offered only when the course has a lever.
export function courseCapabilities(c: ResolvedCourse): CourseCapabilities {
  const kinds: MotionKind[] = []
  for (const o of c.obstacles) if (!kinds.includes(o.motion.kind)) kinds.push(o.motion.kind)
  const levers = c.mechanisms?.levers ?? []
  const hasLevers = levers.length > 0
  return {
    id: c.id, levers: levers.map(l => l.id), hasLevers, hasPath: c.path.length > 0, hasRegions: c.regions.length > 0,
    hasFinish: c.finish !== null, motionKinds: kinds,
    actions: hasLevers ? BOT_ACTIONS.slice() : BOT_ACTIONS.filter(a => a !== 'useLever'),
  }
}
