import { regionOf } from '../course.ts'
import type { ResolvedCourse } from '../course.ts'
import { dhypot3 } from '../detmath.ts'
import type { Vec3 } from '../vec.ts'
import type { BotBehaviour, RoutePreference } from './behaviour.ts'
import { nearestPathIndex, readMechanisms, readNavigation } from './courseRead.ts'
import type { CourseNav } from './courseRead.ts'

// Region route planning for bots. A plan is a pure function of (course, behaviour, position,
// seed, tick): no module state, no history, and the plan object itself is the only carried data.
// Costs are integers (millimetres of centre-to-centre travel, plus weighted obstacle exposure),
// so comparisons are exact; equal costs resolve by a seeded integer key, then by region id.

export interface RouteEdge { from: number; to: number }
export interface RoutePlan {
  preference: RoutePreference
  seed: number
  // Tick the plan was made at and the next integer tick it must be replaced.
  planTick: number
  nextPlanTick: number
  // Region ids from the start region to the goal region (inclusive); [] without regions.
  regions: number[]
  edges: RouteEdge[]
  // Path node indices to visit in order: the course path inside each chosen region.
  waypoints: number[]
  cost: number
  // False when the goal cannot be reached over adjacency: the plan then makes no region
  // move and falls back to the authored course path from the nearest node.
  reachable: boolean
}

export interface RouteInput {
  course: ResolvedCourse
  behaviour: BotBehaviour
  pos: Vec3
  seed: number
  tick: number
  // Round start tick: the replanning cadence counts from here (default 0).
  startTick?: number
}

// Exposure dominates the safe cost; one exposed obstacle outweighs any course-sized detour.
export const EXPOSURE_WEIGHT = 1_000_000

// Obstacles that move (anything but static) expose a bot in their region.
export function regionExposure(c: ResolvedCourse): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of c.regions) out.set(r.id, 0)
  for (const m of readMechanisms(c)) {
    if (m.kind !== 'static' && out.has(m.region)) out.set(m.region, out.get(m.region)! + 1)
  }
  return out
}

function lengthMm(nav: CourseNav, a: number, b: number): number {
  const ra = nav.regions.find(r => r.id === a)!
  const rb = nav.regions.find(r => r.id === b)!
  return Math.round(dhypot3(rb.center.x - ra.center.x, rb.center.y - ra.center.y, rb.center.z - ra.center.z) * 1000)
}

// Integer cost of traversing a -> b (always >= 1, so Dijkstra settles ties before use).
export function edgeCost(nav: CourseNav, exposure: Map<number, number>, pref: RoutePreference, a: number, b: number): number {
  const len = lengthMm(nav, a, b) + 1
  const exp = exposure.get(b) ?? 0
  return pref === 'safe' ? exp * EXPOSURE_WEIGHT + len : len * 64 + exp
}

// Seeded 32-bit key for an edge; only consulted between equal-cost alternatives.
export function tieKey(seed: number, from: number, to: number): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(from + 1, 0x85ebca6b) ^ Math.imul(to + 1, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

// Region holding the finish (race) or the last path node (other kinds); -1 when none.
export function goalRegion(c: ResolvedCourse): number {
  const p = c.finish !== null ? c.finish.center : c.path.length > 0 ? c.path[c.path.length - 1].p : null
  return p === null ? -1 : regionOf(c, p)
}

function startRegion(c: ResolvedCourse, nav: CourseNav, pos: Vec3): number {
  const r = regionOf(c, pos)
  if (r >= 0) return r
  const i = nearestPathIndex(c, pos)
  return i < 0 ? -1 : nav.path[i].region
}

// Cheapest region sequence from -> to over directed adjacency, or null when disconnected.
export function cheapestRegions(c: ResolvedCourse, pref: RoutePreference, seed: number, from: number, to: number): { regions: number[]; cost: number } | null {
  const nav = readNavigation(c)
  const ids = new Set(nav.regions.map(r => r.id))
  if (!ids.has(from) || !ids.has(to)) return null
  const exposure = regionExposure(c)
  const dist = new Map<number, number>([[from, 0]])
  const prev = new Map<number, number>()
  const done = new Set<number>()
  for (;;) {
    let u = -1
    for (const [id, d] of dist) {
      if (!done.has(id) && (u < 0 || d < dist.get(u)! || (d === dist.get(u)! && id < u))) u = id
    }
    if (u < 0) return null
    if (u === to) break
    done.add(u)
    const adjacent = nav.regions.find(r => r.id === u)!.adjacent
    for (const n of adjacent) {
      if (!ids.has(n) || done.has(n)) continue
      const d = dist.get(u)! + edgeCost(nav, exposure, pref, u, n)
      const old = dist.get(n)
      if (old === undefined || d < old || (d === old && tieKey(seed, u, n) < tieKey(seed, prev.get(n)!, n))) {
        dist.set(n, d)
        prev.set(n, u)
      }
    }
  }
  const regions = [to]
  while (regions[0] !== from) regions.unshift(prev.get(regions[0])!)
  return { regions, cost: dist.get(to)! }
}

// Plan at `tick`. Without regions the route is the course path from the nearest node.
export function planRoute(input: RouteInput): RoutePlan {
  const { course: c, behaviour: b, pos, seed, tick } = input
  if (!Number.isInteger(tick)) throw new RangeError(`tick must be an integer; got ${tick}`)
  const nav = readNavigation(c)
  const near = nearestPathIndex(c, pos)
  const forward: number[] = []
  for (let i = Math.max(near, 0); near >= 0 && i < nav.path.length; i++) forward.push(i)
  const start = input.startTick ?? 0
  const step = b.tick.decisionTicks
  const nextPlanTick = start + (Math.floor((tick - start) / step) + 1) * step
  const base = { preference: b.route.preference, seed, planTick: tick, nextPlanTick }
  if (nav.regions.length === 0) return { ...base, regions: [], edges: [], waypoints: forward, cost: 0, reachable: true }
  const from = startRegion(c, nav, pos)
  const found = cheapestRegions(c, b.route.preference, seed, from, goalRegion(c))
  if (found === null) {
    return { ...base, regions: from < 0 ? [] : [from], edges: [], waypoints: forward, cost: 0, reachable: false }
  }
  const edges: RouteEdge[] = []
  for (let i = 1; i < found.regions.length; i++) edges.push({ from: found.regions[i - 1], to: found.regions[i] })
  // Waypoints follow the authored path within each chosen region, never stepping backwards
  // past the nearest node of the start region.
  const waypoints: number[] = []
  for (const r of found.regions) {
    for (const n of nav.path) {
      if (n.region === r && (r !== from || n.index >= near) && !waypoints.includes(n.index)) waypoints.push(n.index)
    }
  }
  return { ...base, regions: found.regions, edges, waypoints, cost: found.cost, reachable: true }
}

// Replanning cadence: the first plan at the round's start tick, then every decisionTicks.
export function replanDue(startTick: number, decisionTicks: number, tick: number): boolean {
  return tick >= startTick && (tick - startTick) % decisionTicks === 0
}

// Returns `plan` unchanged between boundaries, a fresh plan on a boundary or when none exists.
export function updateRoute(plan: RoutePlan | null, input: RouteInput): RoutePlan {
  if (plan === null || replanDue(input.startTick ?? 0, input.behaviour.tick.decisionTicks, input.tick)) return planRoute(input)
  return plan
}
