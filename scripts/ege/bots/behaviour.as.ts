import { readColumn } from 'ege'
import { BotBehaviour, BotMemory, BotRoute, BotRouteWaypoint, BotRule, BotSeat, EgeMover, EgeTransform, ShowNavNode } from '../components.gen'

const JUMP: u32 = 0x10000
const DIVE: u32 = 0x20000
const GRAB: u32 = 0x40000

function fail(message: string): void {
  abort(message, 'scripts/ege/bots/behaviour.as.ts', 0, 0)
}

function distance(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64): f64 {
  const x = ax - bx
  const y = ay - by
  const z = az - bz
  return Math.sqrt(x * x + y * y + z * z)
}

function axes(code: u32): u32 { return code & 0xffff }

/**
 * Handoff: G7.3 Bots and cumulative domain messages: run transferable scripted brains consumes `applyShowBehaviour(seatEntity:u32, tick:i32, proposedCode:u32):u32` from `scripts/ege/bots/brain.as.ts`; it calls this evaluator after traversal and owns reaction advancement. Behavior reads ordered `bot_rule` rows and retains the lever pulse cursor in the seat's `bot_memory.wait_ticks`.
 */
export function applyShowBehaviour(seatEntity: u32, now: i32, proposedCode: u32): u32 {
  if (now < 0) fail('behavior tick must be nonnegative')
  const seatRows = readColumn<BotSeat>(BotSeat.ID, BotSeat.SIZE)
  const si = seatRows.find(seatEntity)
  if (si < 0) fail('seat has no bot_seat record')
  const seat = seatRows.at(<u32>si)
  const behaviours = readColumn<BotBehaviour>(BotBehaviour.ID, BotBehaviour.SIZE)
  const bi = behaviours.find(seat.behaviour)
  if (bi < 0) fail('bot seat has no authored behavior')
  const behaviour = behaviours.at(<u32>bi)
  const routes = readColumn<BotRoute>(BotRoute.ID, BotRoute.SIZE)
  let ri = -1
  for (let i: u32 = 0; i < routes.count; i++) if (routes.at(i).owner == seatEntity) { ri = <i32>i; break }
  if (ri < 0) return 0
  const route = routes.at(<u32>ri)
  const waypoints = readColumn<BotRouteWaypoint>(BotRouteWaypoint.ID, BotRouteWaypoint.SIZE)
  const nodes = readColumn<ShowNavNode>(ShowNavNode.ID, ShowNavNode.SIZE)
  const transforms = readColumn<EgeTransform>(EgeTransform.ID, EgeTransform.SIZE)
  const ti = transforms.find(seat.character)
  if (ti < 0) fail('bot character has no transform')
  if (route.waypoint_count == 0) return 0
  const transform = transforms.at(<u32>ti)
  let targetIndex = -1
  let targetDistance = 1e30
  for (let i: u32 = 0; i < waypoints.count; i++) {
    const wp = waypoints.at(i)
    if (wp.owner != seatEntity) continue
    let ni = -1
    for (let j: u32 = 0; j < nodes.count; j++) if (nodes.at(j).index == wp.node) { ni = <i32>j; break }
    if (ni < 0) fail('route references an unresolved authored node')
    const node = nodes.at(<u32>ni)
    const d = distance(transform.pos_0, transform.pos_1, transform.pos_2, node.p_0, node.p_1, node.p_2)
    if (d < targetDistance) { targetDistance = d; targetIndex = <i32>wp.node }
  }
  if (targetIndex < 0) return 0
  let finishIndex = -1
  for (let i: u32 = 0; i < nodes.count; i++) if (finishIndex < 0 || nodes.at(i).index > <u32>finishIndex) finishIndex = <i32>nodes.at(i).index
  let targetRow = -1
  let finishRow = -1
  for (let i: u32 = 0; i < nodes.count; i++) {
    if (nodes.at(i).index == <u32>targetIndex) targetRow = <i32>i
    if (nodes.at(i).index == <u32>finishIndex) finishRow = <i32>i
  }
  if (targetRow < 0 || finishRow < 0) fail('route target or finish node is unresolved')
  const target = nodes.at(<u32>targetRow)
  const finish = nodes.at(<u32>finishRow)
  let nearestMover = 1e30
  let obstacleAhead = false
  const movers = readColumn<EgeMover>(EgeMover.ID, EgeMover.SIZE)
  const targetLength = distance(transform.pos_0, transform.pos_2, 0, target.p_0, target.p_2, 0)
  const ux = targetLength > 1e-6 ? (target.p_0 - transform.pos_0) / targetLength : 0.0
  const uz = targetLength > 1e-6 ? (target.p_2 - transform.pos_2) / targetLength : 0.0
  for (let i: u32 = 0; i < movers.count; i++) {
    const tr = transforms.find(movers.entity(i))
    if (tr < 0) continue
    const p = transforms.at(<u32>tr)
    const d = distance(transform.pos_0, transform.pos_1, transform.pos_2, p.pos_0, p.pos_1, p.pos_2)
    if (d < nearestMover) nearestMover = d
    const forward = (p.pos_0 - transform.pos_0) * ux + (p.pos_2 - transform.pos_2) * uz
    const lateral = (p.pos_0 - transform.pos_0) * uz - (p.pos_2 - transform.pos_2) * ux
    if (forward >= 0 && forward <= targetLength && abs(lateral) <= 1.0) obstacleAhead = true
  }
  const memoryRows = readColumn<BotMemory>(BotMemory.ID, BotMemory.SIZE)
  const mi = memoryRows.find(seatEntity)
  if (mi < 0) fail('seat has no bot_memory record')
  const memory = memoryRows.at(<u32>mi)
  const observed = now < <i32>behaviour.reaction_ticks ? -1 : <i32>behaviour.reaction_ticks + ((now - <i32>behaviour.reaction_ticks) / <i32>behaviour.decision_ticks) * <i32>behaviour.decision_ticks
  if (observed < 0) return 0
  let selected: i32 = -1
  const rules = readColumn<BotRule>(BotRule.ID, BotRule.SIZE)
  for (let rank: u32 = 0; rank < behaviour.rule_count; rank++) {
    let row = -1
    for (let i: u32 = 0; i < rules.count; i++) {
      const r = rules.at(i)
      if (r.behaviour == seat.behaviour && r.index == rank) { row = <i32>i; break }
    }
    if (row < 0) fail('authored behavior rule rank is missing')
    const rule = rules.at(<u32>row)
    if (rule.predicate > 5 || rule.action > 3) fail('invalid authored behavior rank')
    if (rule.has_phase != 0 && (observed < rule.phase_from || observed > rule.phase_to)) continue
    let matches = false
    if (rule.predicate == 0) matches = true
    else if (rule.predicate == 1) matches = obstacleAhead
    else if (rule.predicate == 2) matches = nearestMover <= (rule.has_distance == 0 ? 2.0 : rule.distance_m)
    else if (rule.predicate == 3) matches = memory.stuck_ticks >= behaviour.stuck_ticks
    else if (rule.predicate == 4) matches = rule.has_distance == 0 || targetDistance <= rule.distance_m
    else matches = rule.has_distance == 0 || distance(transform.pos_0, transform.pos_1, transform.pos_2, finish.p_0, finish.p_1, finish.p_2) <= rule.distance_m
    if (rule.predicate == 1 && rule.has_distance != 0 && nearestMover > rule.distance_m) matches = false
    if (matches) { selected = <i32>row; break }
  }
  if (selected < 0) return proposedCode
  const action = rules.at(<u32>selected).action
  let result = axes(proposedCode)
  if (action == 0) result |= JUMP
  else if (action == 1) result |= DIVE
  else if (action == 2) result |= GRAB
  else {
    if (memory.wait_ticks % 12 < 4) result |= GRAB
    memory.wait_ticks++
    memoryRows.write()
  }
  if ((result & DIVE) != 0) result &= ~JUMP
  return result
}
