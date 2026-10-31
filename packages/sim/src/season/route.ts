import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ResolvedCourse, RouteSpec } from '../course.ts'
import type { Vec3 } from '../vec.ts'

export interface RouteState {
  stage: Int16Array
  lap: Uint8Array
  finished: Uint8Array
}

export function newRouteState(seats: number): RouteState {
  return {
    stage: new Int16Array(seats).fill(-1),
    lap: new Uint8Array(seats),
    finished: new Uint8Array(seats),
  }
}

export function gateCrossed(spec: RouteSpec, st: RouteState, seat: number, checkpoint: number): boolean {
  if (checkpoint < 0 || checkpoint >= spec.stages.length) return false
  const stage = st.stage[seat]
  if (spec.ordered) {
    const next = stage + 1
    if (spec.stages[checkpoint] !== next) return false
    st.stage[seat] = next
    return true
  }
  if (checkpoint <= stage) return false
  st.stage[seat] = checkpoint
  return true
}

export function finishCrossed(
  spec: RouteSpec, st: RouteState, seat: number, lastStage: number,
): 'lap' | 'finish' | 'ignored' {
  if (!spec.ordered) {
    st.finished[seat] = 1
    return 'finish'
  }
  if (st.stage[seat] !== lastStage) return 'ignored'
  if (st.lap[seat] + 1 < spec.laps) {
    st.lap[seat] = st.lap[seat] + 1
    st.stage[seat] = -1
    return 'lap'
  }
  st.finished[seat] = 1
  return 'finish'
}

function nodeDistance2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function nearestNode(course: ResolvedCourse, p: Vec3): number {
  const path = course.path
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const dist = nodeDistance2(path[i].p, p)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

function stageGateNode(course: ResolvedCourse, spec: RouteSpec, stage: number): number {
  for (let c = 0; c < spec.stages.length && c < course.checkpoints.length; c++) {
    if (spec.stages[c] === stage) return nearestNode(course, course.checkpoints[c].box.center)
  }
  return -1
}

function finishGateNode(course: ResolvedCourse): number {
  if (course.finish) return nearestNode(course, course.finish.center)
  return course.path.length - 1
}

function segmentLength(course: ResolvedCourse, i: number): number {
  const a = course.path[i].p, b = course.path[i + 1].p
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function routeDistanceMm(course: ResolvedCourse, spec: RouteSpec, stage: number, pos: Vec3): number {
  const path = course.path
  if (path.length < 2) return 0
  const lastStage = spec.stages.length > 0 ? spec.stages[spec.stages.length - 1] : -1
  const from = stage < 0 ? 0 : stageGateNode(course, spec, stage)
  let to = stage + 1 <= lastStage ? stageGateNode(course, spec, stage + 1) : -1
  if (to < 0) to = finishGateNode(course)
  if (from < 0 || to < 0) return 0
  if (from === to) return 0

  const ahead = to > from
  const lo = ahead ? from : to
  const hi = ahead ? to : from

  let bestSeg = -1
  let bestT = 0
  let bestDist = Infinity
  for (let i = lo; i < hi; i++) {
    const a = path[i].p, b = path[i + 1].p
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    const len2 = dx * dx + dy * dy + dz * dz
    let t = 0
    if (len2 > 0) {
      t = ((pos.x - a.x) * dx + (pos.y - a.y) * dy + (pos.z - a.z) * dz) / len2
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    const px = a.x + dx * t, py = a.y + dy * t, pz = a.z + dz * t
    const ex = pos.x - px, ey = pos.y - py, ez = pos.z - pz
    const dist = ex * ex + ey * ey + ez * ez
    if (dist < bestDist) {
      bestDist = dist
      bestSeg = i
      bestT = t
    }
  }
  if (bestSeg < 0) return 0

  let arc = 0
  if (ahead) {
    arc = segmentLength(course, bestSeg) * (1 - bestT)
    for (let i = bestSeg + 1; i < to; i++) arc += segmentLength(course, i)
  } else {
    arc = segmentLength(course, bestSeg) * bestT
    for (let i = bestSeg - 1; i >= to; i--) arc += segmentLength(course, i)
  }
  const mm = Math.round(arc * 1000)
  return mm > 0 ? mm : 0
}

export function subTick(prevY: number, y: number, plane: number): number {
  if (prevY === y) return 0
  let f = (prevY - plane) / (prevY - y)
  if (!(f > 0)) f = 0
  else if (f > 1) f = 1
  return Math.round(f * 65535)
}

export function writeRoute(w: SnapWriter, st: RouteState): void {
  for (let p = 0; p < st.stage.length; p++) {
    w.i16(st.stage[p])
    w.u8(st.lap[p])
    w.u8(st.finished[p])
  }
}

export function readRoute(r: SnapReader, st: RouteState): void {
  for (let p = 0; p < st.stage.length; p++) {
    st.stage[p] = r.i16()
    st.lap[p] = r.u8()
    st.finished[p] = r.u8()
  }
}
