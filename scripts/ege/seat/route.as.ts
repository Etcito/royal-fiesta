import { readColumn, readResource, Column } from 'ege'
import { PathNode, Gate, CourseRes } from '../components.gen'

// packages/sim/src/season/route.ts:19-31
export const ROUTE_NOT_CROSSED: i32 = -1
// packages/sim/src/season/route.ts:33-48
export const FINISH_IGNORED: u32 = 0
// packages/sim/src/season/route.ts:33-48
export const FINISH_LAP: u32 = 1
// packages/sim/src/season/route.ts:33-48
export const FINISH_DONE: u32 = 2

/** Handoff: card 'rf_seat_rules system script and its schedule row (rank 13)' calls `gateCrossed`, `finishCrossed`, `subTick` and `routeDistanceMm` to update route progress. */
export function gateCrossed(ordered: u32, stageCount: u32, checkpoint: u32, gateStage: i32, stage: i32): i32 {
  if (checkpoint >= stageCount) return ROUTE_NOT_CROSSED
  if (ordered != 0) return gateStage == stage + 1 ? stage + 1 : ROUTE_NOT_CROSSED
  const next = <i32>checkpoint
  return next > stage ? next : ROUTE_NOT_CROSSED
}

export function finishCrossed(ordered: u32, laps: u32, lastStage: i32, stage: i32, lap: u32): u32 {
  if (ordered == 0) return FINISH_DONE
  if (stage != lastStage) return FINISH_IGNORED
  return lap + 1 < laps ? FINISH_LAP : FINISH_DONE
}

export function subTick(prevY: f64, y: f64, plane: f64): u32 {
  if (prevY == y) return 0
  let f = (prevY - plane) / (prevY - y)
  if (!(f > 0)) f = 0
  else if (f > 1) f = 1
  return <u32>Math.round(f * 65535)
}

function nodeDistance2(node: PathNode, x: f64, y: f64, z: f64): f64 {
  const dx = node.p_0 - x
  const dy = node.p_1 - y
  const dz = node.p_2 - z
  return dx * dx + dy * dy + dz * dz
}

function nearestNode(paths: Column<PathNode>, count: u32, x: f64, y: f64, z: f64): i32 {
  let best: i32 = -1
  let bestDist = Infinity
  for (let i: u32 = 0; i < count; i++) {
    const dist = nodeDistance2(paths.at(i), x, y, z)
    if (dist < bestDist) {
      bestDist = dist
      best = <i32>i
    }
  }
  return best
}

function segmentLength(paths: Column<PathNode>, i: i32): f64 {
  const a = paths.at(<u32>i)
  const b = paths.at(<u32>(i + 1))
  const dx = b.p_0 - a.p_0
  const dy = b.p_1 - a.p_1
  const dz = b.p_2 - a.p_2
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function routeDistanceMm(stage: i32, x: f64, y: f64, z: f64): i32 {
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const paths = readColumn<PathNode>(PathNode.ID, PathNode.SIZE)
  if (course.path_count < 2) return 0
  let from: i32 = stage < 0 ? 0 : -1
  let to: i32 = -1
  const gates = readColumn<Gate>(Gate.ID, Gate.SIZE)
  for (let i: u32 = 0; i < gates.count; i++) {
    if (i >= course.stage_count || i >= course.checkpoint_count) break
    const gate = gates.at(i)
    if (stage >= 0 && gate.stage == stage) from = nearestNode(paths, course.path_count, gate.center_0, gate.center_1, gate.center_2)
    if (stage + 1 <= course.last_stage && gate.stage == stage + 1) to = nearestNode(paths, course.path_count, gate.center_0, gate.center_1, gate.center_2)
  }
  if (from < 0) return 0
  if (to < 0) {
    if (course.has_finish != 0) to = nearestNode(paths, course.path_count, course.finish_center_0, course.finish_center_1, course.finish_center_2)
    else to = <i32>course.path_count - 1
  }
  if (from == to || to < 0) return 0
  const ahead = to > from
  const lo = ahead ? from : to
  const hi = ahead ? to : from
  let bestSeg: i32 = -1
  let bestT = 0.0
  let bestDist = Infinity
  for (let i = lo; i < hi; i++) {
    const a = paths.at(<u32>i)
    const b = paths.at(<u32>(i + 1))
    const dx = b.p_0 - a.p_0, dy = b.p_1 - a.p_1, dz = b.p_2 - a.p_2
    const len2 = dx * dx + dy * dy + dz * dz
    let t = 0.0
    if (len2 > 0) {
      t = ((x - a.p_0) * dx + (y - a.p_1) * dy + (z - a.p_2) * dz) / len2
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    const ex = x - (a.p_0 + dx * t), ey = y - (a.p_1 + dy * t), ez = z - (a.p_2 + dz * t)
    const dist = ex * ex + ey * ey + ez * ez
    if (dist < bestDist) { bestDist = dist; bestSeg = i; bestT = t }
  }
  if (bestSeg < 0) return 0
  let arc = 0.0
  if (ahead) {
    arc = segmentLength(paths, bestSeg) * (1 - bestT)
    for (let i = bestSeg + 1; i < to; i++) arc += segmentLength(paths, i)
  } else {
    arc = segmentLength(paths, bestSeg) * bestT
    for (let i = bestSeg - 1; i >= to; i--) arc += segmentLength(paths, i)
  }
  const mm = <i32>Math.round(arc * 1000)
  return mm > 0 ? mm : 0
}
