import { Column, hypot3, readColumn, setComponent, spawn } from 'ege'
import { BotMemory, BotRoute, BotRouteEdge, BotRouteRegion, BotRouteWaypoint, BotSeat, BotBehaviour, EgeMover, EgeTransform, ShowNavEdge, ShowNavNode, ShowNavRegion } from '../components.gen'

const INF: i64 = 0x3fffffffffffffff

function fail(message: string): void {
  abort(message, 'scripts/ege/bots/routes.as.ts', 0, 0)
}

function rowOf<T>(column: Column<T>, entity: u32): i32 {
  return column.find(entity)
}

function tieKey(seed: u32, from: i32, to: i32): u32 {
  let h: u32 = seed * <u32>0x9e3779b1 ^ <u32>(from + 1) * <u32>0x85ebca6b ^ <u32>(to + 1) * <u32>0xc2b2ae35
  h = (h ^ (h >>> 16)) * <u32>0x7feb352d
  h = (h ^ (h >>> 15)) * <u32>0x846ca68b
  return h ^ (h >>> 16)
}

function distMm(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64): i64 {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  return <i64>Math.round(hypot3(dx, dy, dz) * 1000.0) + 1
}

function inside(region: ShowNavRegion, x: f64, y: f64, z: f64): bool {
  return abs(x - region.center_0) <= region.half_0 && abs(y - region.center_1) <= region.half_1 && abs(z - region.center_2) <= region.half_2
}

function child<T>(column: Column<T>, owner: u32, index: u32): i32 {
  for (let i: u32 = 0; i < column.count; i++) {
    const value = column.at(i)
    if (value.owner == owner && value.index == index) return <i32>i
  }
  return -1
}

/** Handoff: G7.3 Bots and cumulative domain messages: run transferable scripted brains calls `planShowRoute(seatEntity:u32, tick:i32):i32` before traversal and behavior; route rows and the `bot_memory.path_index` cursor are keyed by the live seat entity. */
export function planShowRoute(seatEntity: u32, now: i32): i32 {
  if (now < 0) fail('route tick must be nonnegative')
  const seats = readColumn<BotSeat>(BotSeat.ID, BotSeat.SIZE)
  const seatIndex = rowOf<BotSeat>(seats, seatEntity)
  if (seatIndex < 0) fail('seat has no bot_seat record')
  const seat = seats.at(<u32>seatIndex)
  const behaviours = readColumn<BotBehaviour>(BotBehaviour.ID, BotBehaviour.SIZE)
  const behaviourIndex = rowOf<BotBehaviour>(behaviours, seat.behaviour)
  if (behaviourIndex < 0) fail('bot seat has no authored behaviour')
  const behaviour = behaviours.at(<u32>behaviourIndex)
  const memoryRows = readColumn<BotMemory>(BotMemory.ID, BotMemory.SIZE)
  const memoryIndex = rowOf<BotMemory>(memoryRows, seatEntity)
  if (memoryIndex < 0) fail('seat has no bot_memory record')
  const memory = memoryRows.at(<u32>memoryIndex)
  const routeRows = readColumn<BotRoute>(BotRoute.ID, BotRoute.SIZE)
  let routeIndex = rowOf<BotRoute>(routeRows, seatEntity)
  let routeEntity = seatEntity
  let route = new BotRoute()
  let due = routeIndex < 0
  if (!due) {
    route = routeRows.at(<u32>routeIndex)
    due = route.plan_tick < 0 || now >= route.next_plan_tick
  }

  const nodes = readColumn<ShowNavNode>(ShowNavNode.ID, ShowNavNode.SIZE)
  if (nodes.count == 0) return -1
  let nodeByIndex = new StaticArray<i32>(nodes.count)
  let maxNode = -1
  for (let i: u32 = 0; i < nodes.count; i++) {
    const node = nodes.at(i)
    if (<i32>node.index > maxNode) maxNode = <i32>node.index
    if (node.index >= nodes.count) fail('authored path node indices are not contiguous')
    nodeByIndex[node.index] = <i32>i
  }
  const transformRows = readColumn<EgeTransform>(EgeTransform.ID, EgeTransform.SIZE)
  const transformIndex = rowOf<EgeTransform>(transformRows, seat.character)
  if (transformIndex < 0) fail('bot character has no transform')
  const transform = transformRows.at(<u32>transformIndex)
  let near = 0
  let best = INF
  for (let i: i32 = 0; i <= maxNode; i++) {
    const node = nodes.at(<u32>nodeByIndex[i])
    const d = distMm(transform.pos_0, transform.pos_1, transform.pos_2, node.p_0, node.p_1, node.p_2)
    if (d < best) { best = d; near = i }
  }
  let target = near
  if (due) {
    const regions = readColumn<ShowNavRegion>(ShowNavRegion.ID, ShowNavRegion.SIZE)
    const edges = readColumn<ShowNavEdge>(ShowNavEdge.ID, ShowNavEdge.SIZE)
    let start = -1
    let goal = nodes.at(<u32>nodeByIndex[maxNode]).region
    for (let i: u32 = 0; i < regions.count; i++) {
      const region = regions.at(i)
      if (inside(region, transform.pos_0, transform.pos_1, transform.pos_2)) { start = region.region; break }
    }
    if (start < 0) start = nodes.at(<u32>nodeByIndex[near]).region
    const count = regions.count
    const ids = new StaticArray<i32>(count)
    const costs = new StaticArray<i64>(count)
    const previous = new StaticArray<i32>(count)
    const settled = new StaticArray<bool>(count)
    const routePath = new StaticArray<i32>(count)
    const exposure = new StaticArray<i32>(count)
    let routePathCount = 0
    for (let i: u32 = 0; i < count; i++) { ids[i] = regions.at(i).region; costs[i] = INF; previous[i] = -1; settled[i] = false }
    const movers = readColumn<EgeMover>(EgeMover.ID, EgeMover.SIZE)
    for (let m: u32 = 0; m < movers.count; m++) {
      const transformRow = transformRows.find(movers.entity(m))
      if (transformRow < 0) continue
      const moverTransform = transformRows.at(<u32>transformRow)
      for (let r: u32 = 0; r < regions.count; r++) {
        if (inside(regions.at(r), moverTransform.pos_0, moverTransform.pos_1, moverTransform.pos_2)) { exposure[r]++; break }
      }
    }
    let startAt = -1
    let goalAt = -1
    for (let i: i32 = 0; i < <i32>count; i++) { if (ids[i] == start) startAt = i; if (ids[i] == goal) goalAt = i }
    if (startAt >= 0 && goalAt >= 0) {
      costs[startAt] = 0
      for (let step: i32 = 0; step < <i32>count; step++) {
        let u = -1
        for (let i: i32 = 0; i < <i32>count; i++) if (!settled[i] && costs[i] < INF && (u < 0 || costs[i] < costs[u] || (costs[i] == costs[u] && ids[i] < ids[u]))) u = i
        if (u < 0) break
        settled[u] = true
        if (u == goalAt) break
        let fromRow = -1
        for (let r: u32 = 0; r < regions.count; r++) if (regions.at(r).region == ids[u]) fromRow = <i32>r
        if (fromRow < 0) fail('navigation region lookup failed')
        const region = regions.at(<u32>fromRow)
        for (let e: u32 = 0; e < edges.count; e++) {
          const edge = edges.at(e)
          if (edge.region_index != region.index || edge.edge_index >= region.adjacent_count) continue
          let v = -1
          for (let j: i32 = 0; j < <i32>count; j++) if (ids[j] == edge.adjacent) v = j
          if (v < 0 || settled[v]) continue
          let otherRow = -1
          for (let r: u32 = 0; r < regions.count; r++) if (regions.at(r).region == ids[v]) otherRow = <i32>r
          if (otherRow < 0) continue
          const other = regions.at(<u32>otherRow)
          const distance = distMm(region.center_0, region.center_1, region.center_2, other.center_0, other.center_1, other.center_2)
          const edgeCost = behaviour.preference == 0
            ? distance * 64 + <i64>exposure[v]
            : <i64>exposure[v] * 1000000 + distance
          const candidate = costs[u] + edgeCost
          const seed = routeIndex < 0 ? memory.rng_state : route.seed
          if (candidate < costs[v] || (candidate == costs[v] && (previous[v] < 0 || tieKey(seed, ids[u], ids[v]) < tieKey(seed, ids[previous[v]], ids[v])))) { costs[v] = candidate; previous[v] = u }
        }
      }
      if (costs[goalAt] < INF) {
        let chain = new StaticArray<i32>(count)
        let n = 0
        let cursor = goalAt
        while (cursor >= 0 && n < <i32>count) { chain[n++] = cursor; if (cursor == startAt) break; cursor = previous[cursor] }
        if (n > 0 && chain[n - 1] == startAt) {
          for (let i = n - 1; i >= 0; i--) routePath[routePathCount++] = ids[chain[i]]
          let foundTarget = false
          for (let r: i32 = 0; r < routePathCount && !foundTarget; r++) {
            for (let nodeIndex = 0; nodeIndex <= maxNode; nodeIndex++) {
              const node = nodes.at(<u32>nodeByIndex[nodeIndex])
              if (node.region == routePath[r] && (routePath[r] != start || nodeIndex >= near)) { target = nodeIndex; foundTarget = true; break }
            }
          }
        }
      }
    }
    if (routePathCount == 0 && startAt >= 0) {
      routePath[0] = start
      routePathCount = 1
    }
    if (routeIndex < 0) { routeEntity = spawn(); route = new BotRoute(); route.owner = seatEntity }
    else route = routeRows.at(<u32>routeIndex)
    route.preference = behaviour.preference
    route.plan_tick = now
    route.next_plan_tick = now + <i32>max<u32>(1, behaviour.decision_ticks)
    if (routeIndex < 0) route.seed = memory.rng_state
    route.cost = startAt >= 0 && goalAt >= 0 && costs[goalAt] < INF ? <f64>costs[goalAt] : 0.0
    route.reachable = startAt >= 0 && goalAt >= 0 && costs[goalAt] < INF ? 1 : 0
    route.region_count = <u32>routePathCount
    route.edge_count = routePathCount > 0 ? <u32>(routePathCount - 1) : 0
    let waypointCount: u32 = 0
    if (routePathCount == 0 || (startAt >= 0 && goalAt >= 0 && costs[goalAt] >= INF)) {
      for (let nodeIndex = near; nodeIndex <= maxNode; nodeIndex++) {
        const column = readColumn<BotRouteWaypoint>(BotRouteWaypoint.ID, BotRouteWaypoint.SIZE)
        const row = child(column, seatEntity, waypointCount)
        let value = new BotRouteWaypoint()
        let entity: u32
        if (row >= 0) { value = column.at(<u32>row); entity = column.entity(<u32>row) }
        else { entity = spawn(); value.owner = seatEntity; value.index = waypointCount }
        value.node = <u32>nodeIndex
        setComponent<BotRouteWaypoint>(entity, BotRouteWaypoint.ID, BotRouteWaypoint.SIZE, value)
        waypointCount++
      }
    } else {
      for (let r: i32 = 0; r < routePathCount; r++) {
        for (let nodeIndex = 0; nodeIndex <= maxNode; nodeIndex++) {
          const node = nodes.at(<u32>nodeByIndex[nodeIndex])
          if (node.region != routePath[r] || (routePath[r] == start && nodeIndex < near)) continue
        const column = readColumn<BotRouteWaypoint>(BotRouteWaypoint.ID, BotRouteWaypoint.SIZE)
        let row = child(column, seatEntity, waypointCount)
        let value = new BotRouteWaypoint()
        let entity: u32
        if (row >= 0) { value = column.at(<u32>row); entity = column.entity(<u32>row) }
        else { entity = spawn(); value.owner = seatEntity; value.index = waypointCount }
        value.node = <u32>nodeIndex
        setComponent<BotRouteWaypoint>(entity, BotRouteWaypoint.ID, BotRouteWaypoint.SIZE, value)
        waypointCount++
        }
      }
    }
    route.waypoint_count = waypointCount
    for (let i: u32 = 0; i < <u32>routePathCount; i++) {
      let column = readColumn<BotRouteRegion>(BotRouteRegion.ID, BotRouteRegion.SIZE)
      let row = child(column, seatEntity, i)
      let value = new BotRouteRegion()
      let entity: u32
      if (row >= 0) { value = column.at(<u32>row); entity = column.entity(<u32>row) }
      else { entity = spawn(); value.owner = seatEntity; value.index = i }
      value.region = routePath[i]
      setComponent<BotRouteRegion>(entity, BotRouteRegion.ID, BotRouteRegion.SIZE, value)
      if (i > 0) {
        let edgeColumn = readColumn<BotRouteEdge>(BotRouteEdge.ID, BotRouteEdge.SIZE)
        let edgeRow = child(edgeColumn, seatEntity, i - 1)
        let edgeValue = new BotRouteEdge()
        let edgeEntity: u32
        if (edgeRow >= 0) { edgeValue = edgeColumn.at(<u32>edgeRow); edgeEntity = edgeColumn.entity(<u32>edgeRow) }
        else { edgeEntity = spawn(); edgeValue.owner = seatEntity; edgeValue.index = i - 1 }
        edgeValue.from_region = routePath[i - 1]
        edgeValue.to_region = routePath[i]
        setComponent<BotRouteEdge>(edgeEntity, BotRouteEdge.ID, BotRouteEdge.SIZE, edgeValue)
      }
    }
    if (routeIndex < 0) setComponent<BotRoute>(routeEntity, BotRoute.ID, BotRoute.SIZE, route)
    else routeRows.write()
    memory.path_index = <u32>target
    memoryRows.write()
  } else target = <i32>memory.path_index
  if (target < 0 || target > maxNode) return -1
  return target
}
