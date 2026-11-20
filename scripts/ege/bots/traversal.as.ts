import { Column, capsuleShape, getComponent, isNull, newRecord, overlap, pose, rayCast, readColumn } from 'ege'
import {
  BotBehaviour,
  BotMemory,
  BotRoute,
  BotRouteWaypoint,
  BotSeat,
  Character,
  EgeMechLever,
  EgeMechSignal,
  EgeMover,
  EgeTransform,
  Feature,
  FeatureHexField,
  FeatureHexFieldHex,
  ShowNavNode
} from '../components.gen'

// Returned codes use the engine layout: signed-byte axes in bits 0..7 and 8..15 and the
// engine jump/dive/grab bits 16/17/18 (never the S1 offset-byte axis encoding).
const JUMP: u32 = 0x10000
const DIVE: u32 = 0x20000
const GRAB: u32 = 0x40000

// Collision groups of E3: static 1, moving 2, char 4. Support scans only settled geometry;
// moving bodies are governed by the crossing/rotor rules, never mistaken for a ledge.
const GROUND_GROUPS: u32 = 1
const MOVING_GROUP: u32 = 2

// Brain timings of packages/sim/src/bots/brain.ts: a wait holds at most 600 ticks and a pull
// at most 240; the lever toggles on a 4-held/12-cycle press (brain.ts WAIT_MAX/PULL_MAX/PRESS_*).
const WAIT_MAX: u32 = 600
const PULL_MAX: u32 = 240
const PRESS_TICKS: u32 = 4
const PRESS_CYCLE: u32 = 12

// Traversal geometry of brain.ts: a gap opens within GAP_LEAD and closes within GAP_MAX, a
// ledge is a raised surface within GRAB_REACH of the feet and LEDGE_SCAN ahead.
const JUMP_APEX: f64 = 1.40625 // CHAR.jumpSpeed 7.5 over 2 * gravity 20
const GRAB_REACH: f64 = JUMP_APEX + 0.6
const GAP_STEP: f64 = 0.2
const GAP_MAX: f64 = 2.6
const GAP_LEAD: f64 = 2.2
const GAP_PROBE: f64 = GAP_LEAD + GAP_MAX + GAP_STEP
const LEDGE_STEP: f64 = 0.35
const LEDGE_SCAN: f64 = 2.6
const LEDGE_NEAR: f64 = 1.0
const FALL_DEPTH: f64 = 3.0
const GROUND_PROBE: f64 = 0.08
const RAMP_AIM: f64 = 3.0
const RAMP_SCAN: f64 = 2.0
const RAMP_STEP: f64 = 0.5
const SEESAW_DIVE_DIST: f64 = 3.0
const ROTOR_ALONG_MIN: f64 = 1.5
const ROTOR_ALONG_MAX: f64 = 2.5
const ROTOR_ACROSS: f64 = 2.0
const ARRIVE_FALLBACK: f64 = 0.5
const ADVANCE_FALLBACK: f64 = 1.5
const NEG_INF: f64 = -1e30
const NO_ENTITY: u32 = 0xffffffff

function fail(message: string): void {
  abort(message, 'scripts/ege/bots/traversal.as.ts', 0, 0)
}

function rowOf<T>(column: Column<T>, entity: u32): i32 {
  return column.find(entity)
}

function distance2(ax: f64, az: f64, bx: f64, bz: f64): f64 {
  const dx = ax - bx
  const dz = az - bz
  return Math.sqrt(dx * dx + dz * dz)
}

// The support top below a vertical ray, or NEG_INF when the run is open (brain.ts topUnder).
function supportTop(x: f64, feet: f64, z: f64): f64 {
  const origin = feet + GRAB_REACH
  const hit = rayCast(<f32>x, <f32>origin, <f32>z, 0.0, -1.0, 0.0, <f32>(GRAB_REACH + FALL_DEPTH), GROUND_GROUPS)
  if (changetype<usize>(hit) == 0) return NEG_INF
  return origin - <f64>hit.toi
}

function groundedAt(x: f64, y: f64, z: f64, stand: f64): bool {
  const hit = rayCast(<f32>x, <f32>y, <f32>z, 0.0, -1.0, 0.0, <f32>(stand + GROUND_PROBE), GROUND_GROUPS)
  return changetype<usize>(hit) != 0
}

// The signal entity of an authored signal index. Mechanism signals are emitted switches, then
// levers, then logic, sorted by id, so the ascending ege.mech.signal rows keep that order.
function signalEntity(index: i32): u32 {
  if (index < 0) return NO_ENTITY
  const signals = readColumn<EgeMechSignal>(EgeMechSignal.ID, EgeMechSignal.SIZE)
  if (<u32>index >= signals.count) fail('authored wait/pull signal index is unresolved')
  return signals.entity(<u32>index)
}

function signalOn(index: i32): bool {
  const entity = signalEntity(index)
  if (entity == NO_ENTITY) return false
  const signal = getComponent<EgeMechSignal>(entity, EgeMechSignal.ID, EgeMechSignal.SIZE)
  if (isNull<EgeMechSignal>(signal)) fail('authored wait/pull signal is not a mechanism signal')
  return signal.value != 0
}

// A hex support is invalid once it warns into falling (state 2) or has dropped (state 3);
// state 0 is solid and state 1 is still walkable (scripts/ege/features/hex_field.as.ts).
function hexInvalidAt(x: f64, z: f64): bool {
  const hexes = readColumn<FeatureHexFieldHex>(FeatureHexFieldHex.ID, FeatureHexFieldHex.SIZE)
  if (hexes.count == 0) return false
  const fields = readColumn<FeatureHexField>(FeatureHexField.ID, FeatureHexField.SIZE)
  let best = 1e30
  let state: u32 = 0
  for (let i: u32 = 0; i < hexes.count; i++) {
    const hex = hexes.at(i)
    let flat: f64 = 0
    for (let f: u32 = 0; f < fields.count; f++) {
      const feature = getComponent<Feature>(fields.entity(f), Feature.ID, Feature.SIZE)
      if (isNull<Feature>(feature) || feature.index != hex.owner) continue
      flat = fields.at(f).flat_m
      break
    }
    if (!(flat > 0)) continue
    const d = distance2(x, z, hex.t_0, hex.t_2)
    if (d <= flat / 2 && d < best) {
      best = d
      state = hex.state
    }
  }
  return best < 1e30 && state >= 2
}

// The authored node of a one-based previous index, kept by index so a sparse path still resolves.
function nodeAt(nodes: Column<ShowNavNode>, index: i32): i32 {
  for (let i: u32 = 0; i < nodes.count; i++) if (<i32>nodes.at(i).index == index) return <i32>i
  return -1
}

function nodeIndexInRoute(waypoints: Column<BotRouteWaypoint>, owner: u32, node: i32): i32 {
  for (let i: u32 = 0; i < waypoints.count; i++) {
    const wp = waypoints.at(i)
    if (wp.owner == owner && <i32>wp.node == node) return <i32>i
  }
  return -1
}

function nextRouteNode(waypoints: Column<BotRouteWaypoint>, owner: u32, node: i32): i32 {
  const row = nodeIndexInRoute(waypoints, owner, node)
  if (row < 0) return -1
  const current = waypoints.at(<u32>row).index
  let bestIndex: u32 = 0xffffffff
  let next: i32 = -1
  for (let i: u32 = 0; i < waypoints.count; i++) {
    const wp = waypoints.at(i)
    if (wp.owner != owner || wp.index <= current || wp.index >= bestIndex) continue
    bestIndex = wp.index
    next = <i32>wp.node
  }
  return next
}

function nearestValidNode(waypoints: Column<BotRouteWaypoint>, nodes: Column<ShowNavNode>, owner: u32, x: f64, z: f64): i32 {
  let best = 1e30
  let found = -1
  for (let i: u32 = 0; i < waypoints.count; i++) {
    const wp = waypoints.at(i)
    if (wp.owner != owner) continue
    const row = nodeAt(nodes, <i32>wp.node)
    if (row < 0) fail('route references an unresolved authored node')
    const node = nodes.at(<u32>row)
    if (hexInvalidAt(node.p_0, node.p_2)) continue
    const d = distance2(x, z, node.p_0, node.p_2)
    if (d < best) {
      best = d
      found = <i32>wp.node
    }
  }
  return found
}

function axisByte(value: f64): u32 {
  const clamped = Math.max(-1.0, Math.min(1.0, value))
  return <u32>((<i32>Math.round(clamped * 127.0)) & 0xff)
}

// Buttons pulse on even ticks so a held condition still yields press edges (brain.ts emit).
function emit(mx: f64, mz: f64, jump: bool, dive: bool, grab: bool, now: i32): u32 {
  const len = Math.sqrt(mx * mx + mz * mz)
  const nx = len > 1e-6 ? mx / len : 0.0
  const nz = len > 1e-6 ? mz / len : 0.0
  const pulse = (now & 1) == 0
  let code: u32 = axisByte(nx) | (axisByte(nz) << 8)
  if (jump && pulse) code |= JUMP
  if (dive && pulse) code |= DIVE
  if (grab) code |= GRAB
  if ((code & DIVE) != 0) code &= ~JUMP
  return code
}

// A horizontal rotor is jumped before contact look-ahead can see its tip (crossing.ts
// rotorJumpAhead): only bodies turning about Y and an authored jump mark near the body.
function rotorAhead(nodes: Column<ShowNavNode>, movers: Column<EgeMover>, transforms: Column<EgeTransform>, x: f64, y: f64, z: f64, ux: f64, uz: f64): bool {
  for (let i: u32 = 0; i < movers.count; i++) {
    const mover = movers.at(i)
    if (mover.kind != 1 && mover.kind != 4) continue
    const ay = Math.abs(<f64>mover.axis_1)
    const axz = Math.abs(<f64>mover.axis_0) + Math.abs(<f64>mover.axis_2)
    if (ay <= 0.1 || axz > 0.1) continue
    const row = transforms.find(movers.entity(i))
    if (row < 0) continue
    const body = transforms.at(<u32>row)
    const dx = <f64>body.pos_0 - x
    const dz = <f64>body.pos_2 - z
    const along = dx * ux + dz * uz
    const across = Math.abs(dx * uz - dz * ux)
    if (along <= ROTOR_ALONG_MIN || along >= ROTOR_ALONG_MAX || across >= ROTOR_ACROSS) continue
    if (Math.abs(<f64>body.pos_1 - y) >= 1.5) continue
    for (let n: u32 = 0; n < nodes.count; n++) {
      const node = nodes.at(n)
      if (node.jump == 0) continue
      if (distance2(node.p_0, node.p_2, <f64>body.pos_0, <f64>body.pos_2) < 2.0) return true
    }
  }
  return false
}

// A tick-driven spinner, pendulum or door is a predictable free track: wait outside its swept
// volume before entry. A see-saw integrates loads and is stateful, so it is dived instead
// (crossing.ts crossingBlocked vs brain.ts seesawAhead).
function crossingBlocked(radius: f64, halfHeight: f64, x: f64, y: f64, z: f64, ux: f64, uz: f64, dist: f64): bool {
  const probe = Math.min(2.0, dist)
  if (!(probe > 0)) return false
  const shape = capsuleShape(<f32>radius, <f32>halfHeight)
  const at = pose(<f32>(x + ux * probe), <f32>y, <f32>(z + uz * probe))
  const hits = overlap(shape, at, MOVING_GROUP, 8)
  if (changetype<usize>(hits) == 0) return false
  for (let i: u32 = 0; i < hits.count; i++) {
    const mover = getComponent<EgeMover>(hits.at(i), EgeMover.ID, EgeMover.SIZE)
    if (isNull<EgeMover>(mover)) continue
    if (mover.kind == 1 || mover.kind == 2 || mover.kind == 4) return true
  }
  return false
}

function seesawAhead(movers: Column<EgeMover>, transforms: Column<EgeTransform>, x: f64, z: f64, ux: f64, uz: f64): bool {
  for (let i: u32 = 0; i < movers.count; i++) {
    if (movers.at(i).kind != 3) continue
    const row = transforms.find(movers.entity(i))
    if (row < 0) continue
    const body = transforms.at(<u32>row)
    const dx = <f64>body.pos_0 - x
    const dz = <f64>body.pos_2 - z
    const along = dx * ux + dz * uz
    if (along < 0 || along > SEESAW_DIVE_DIST) continue
    if (Math.abs(dx * uz - dz * ux) <= 2.0) return true
  }
  return false
}

@unmanaged
class Aim {
  ok: bool
  x: f64
  z: f64
}

// A long authored rise is followed along the support centreline, not by a chord to the next
// floor's node (ramps.ts rampTarget). The centreline comes from probing the supported lateral
// offsets at RAMP_AIM ahead; false when the rise is short or no ramp surface is there.
function rampTarget(nodes: Column<ShowNavNode>, nodeIndex: i32, x: f64, y: f64, feet: f64, z: f64, ux: f64, uz: f64, out: Aim): bool {
  out.ok = false
  const toRow = nodeAt(nodes, nodeIndex)
  const fromRow = nodeAt(nodes, nodeIndex - 1)
  if (toRow < 0 || fromRow < 0) return false
  const to = nodes.at(<u32>toRow)
  const from = nodes.at(<u32>fromRow)
  if (<f64>to.p_1 - <f64>from.p_1 < 2.0) return false
  if (<f64>to.p_1 - y < 0.35) return false
  const length = distance2(<f64>to.p_0, <f64>to.p_2, <f64>from.p_0, <f64>from.p_2)
  if (length < 15.0) return false
  let lo = 1e30
  let hi = -1e30
  for (let off = -RAMP_SCAN; off <= RAMP_SCAN + 1e-9; off += RAMP_STEP) {
    const sx = x + ux * RAMP_AIM + uz * off
    const sz = z + uz * RAMP_AIM - ux * off
    if (supportTop(sx, feet, sz) <= feet + 0.1) continue
    if (off < lo) lo = off
    if (off > hi) hi = off
  }
  if (lo > hi) return false
  const centre = (lo + hi) / 2
  out.x = x + ux * RAMP_AIM + uz * centre
  out.z = z + uz * RAMP_AIM - ux * centre
  out.ok = true
  return true
}

/**
 * Handoff: G7.3 Bots and cumulative domain messages: run transferable scripted brains consumes
 * `showTraversalControl(seatEntity:u32, tick:i32, pathNode:i32):u32` from this file; the brain calls
 * `planShowRoute` first, passes the returned path node here, then hands the result to
 * `applyShowBehaviour`. Traversal keeps only the seat's `bot_memory` traversal state (`wait_ticks`,
 * `path_index`); it reads `bot_route`, `bot_route_waypoint`, `bot_seat`, `bot_behaviour`,
 * `show_nav_node`, `ege.transform`, `ege.mover`, `ege.mech.signal`, `ege.mech.lever` and the
 * `feature_hex_field_hex` support rows, and it never destroys the route or behavior state.
 */
export function showTraversalControl(seatEntity: u32, now: i32, pathNode: i32): u32 {
  if (now < 0) fail('traversal tick must be nonnegative')
  if (pathNode == -1) return 0
  const seats = readColumn<BotSeat>(BotSeat.ID, BotSeat.SIZE)
  const seatRow = rowOf<BotSeat>(seats, seatEntity)
  if (seatRow < 0) fail('seat has no bot_seat record')
  const seat = seats.at(<u32>seatRow)
  const behaviours = readColumn<BotBehaviour>(BotBehaviour.ID, BotBehaviour.SIZE)
  const behaviourRow = rowOf<BotBehaviour>(behaviours, seat.behaviour)
  if (behaviourRow < 0) fail('bot seat has no authored behaviour')
  const behaviour = behaviours.at(<u32>behaviourRow)
  const memoryRows = readColumn<BotMemory>(BotMemory.ID, BotMemory.SIZE)
  const memoryRow = rowOf<BotMemory>(memoryRows, seatEntity)
  if (memoryRow < 0) fail('seat has no bot_memory record')
  const memory = memoryRows.at(<u32>memoryRow)
  let routeIndex = -1
  const routes = readColumn<BotRoute>(BotRoute.ID, BotRoute.SIZE)
  for (let i: u32 = 0; i < routes.count; i++) if (routes.at(i).owner == seatEntity) { routeIndex = <i32>i; break }
  if (routeIndex < 0) return 0
  const nodes = readColumn<ShowNavNode>(ShowNavNode.ID, ShowNavNode.SIZE)
  let nodeRow = nodeAt(nodes, pathNode)
  if (nodeRow < 0) fail('traversal target is not an authored path node')
  const transforms = readColumn<EgeTransform>(EgeTransform.ID, EgeTransform.SIZE)
  const transformRow = transforms.find(seat.character)
  if (transformRow < 0) fail('bot character has no transform')
  const transform = transforms.at(<u32>transformRow)
  const character = getComponent<Character>(seat.character, Character.ID, Character.SIZE)
  if (isNull<Character>(character)) fail('bot seat character has no character record')
  const waypoints = readColumn<BotRouteWaypoint>(BotRouteWaypoint.ID, BotRouteWaypoint.SIZE)
  const movers = readColumn<EgeMover>(EgeMover.ID, EgeMover.SIZE)

  const px = <f64>transform.pos_0
  const py = <f64>transform.pos_1
  const pz = <f64>transform.pos_2
  const stand = <f64>character.stand
  const feet = py - stand
  const radius = <f64>character.radius
  const halfHeight = <f64>character.half_height
  const advance = behaviour.advance_m > 0 ? behaviour.advance_m : ADVANCE_FALLBACK
  const arrive = behaviour.arrive_m > 0 ? behaviour.arrive_m : ARRIVE_FALLBACK

  let current = pathNode
  let node = nodes.at(<u32>nodeRow)
  let dx = <f64>node.p_0 - px
  let dz = <f64>node.p_2 - pz
  let dist = Math.sqrt(dx * dx + dz * dz)
  const gated = node.wait_signal >= 0 || node.pull_signal >= 0

  // The plain advance skips a passed node, but a wait or pull node's mechanism owns it.
  if (!gated && dist < advance) {
    const next = nextRouteNode(waypoints, seatEntity, current)
    if (next >= 0) {
      current = next
      nodeRow = nodeAt(nodes, current)
      if (nodeRow < 0) fail('route references an unresolved authored node')
      node = nodes.at(<u32>nodeRow)
      dx = <f64>node.p_0 - px
      dz = <f64>node.p_2 - pz
      dist = Math.sqrt(dx * dx + dz * dz)
    }
  }

  // L11 wait/pull rules, after path advance and before steering (brain.ts raceBrain).
  if (node.wait_signal >= 0 && dist < advance) {
    if (!signalOn(node.wait_signal) && memory.wait_ticks < WAIT_MAX) {
      memory.wait_ticks++
      memory.path_index = <u32>current
      memoryRows.write()
      return 0
    }
    memory.wait_ticks = 0
    const next = nextRouteNode(waypoints, seatEntity, current)
    if (next >= 0) {
      current = next
      nodeRow = nodeAt(nodes, current)
      if (nodeRow < 0) fail('route references an unresolved authored node')
      node = nodes.at(<u32>nodeRow)
      dx = <f64>node.p_0 - px
      dz = <f64>node.p_2 - pz
      dist = Math.sqrt(dx * dx + dz * dz)
    }
  } else if (node.pull_signal >= 0 && dist < advance) {
    if (signalOn(node.pull_signal)) {
      memory.wait_ticks = 0
      const next = nextRouteNode(waypoints, seatEntity, current)
      if (next >= 0) {
        current = next
        nodeRow = nodeAt(nodes, current)
        if (nodeRow < 0) fail('route references an unresolved authored node')
        node = nodes.at(<u32>nodeRow)
        dx = <f64>node.p_0 - px
        dz = <f64>node.p_2 - pz
        dist = Math.sqrt(dx * dx + dz * dz)
      }
    } else if (memory.wait_ticks >= PULL_MAX) {
      memory.wait_ticks = 0
      const next = nextRouteNode(waypoints, seatEntity, current)
      if (next >= 0) {
        current = next
        nodeRow = nodeAt(nodes, current)
        if (nodeRow < 0) fail('route references an unresolved authored node')
        node = nodes.at(<u32>nodeRow)
        dx = <f64>node.p_0 - px
        dz = <f64>node.p_2 - pz
        dist = Math.sqrt(dx * dx + dz * dz)
      }
    } else {
      const leverEntity = signalEntity(node.pull_signal)
      const lever = getComponent<EgeMechLever>(leverEntity, EgeMechLever.ID, EgeMechLever.SIZE)
      if (isNull<EgeMechLever>(lever)) fail('authored pull node has no lever')
      const handleRow = transforms.find(lever.handle)
      if (handleRow < 0) fail('authored pull lever handle has no transform')
      const handle = transforms.at(<u32>handleRow)
      const hx = <f64>handle.pos_0 - px
      const hy = <f64>handle.pos_1 - py
      const hz = <f64>handle.pos_2 - pz
      const hd = Math.sqrt(hx * hx + hy * hy + hz * hz)
      if (hd <= <f64>lever.grab_range) {
        // Stand still and press: 4 ticks held, 8 released, so the lever sees 1..11.
        const grab = memory.wait_ticks % PRESS_CYCLE < PRESS_TICKS
        memory.wait_ticks++
        memory.path_index = <u32>current
        memoryRows.write()
        return emit(0, 0, false, false, grab, now)
      }
      memory.wait_ticks++
      memory.path_index = <u32>current
      memoryRows.write()
      return emit(hx, hz, false, false, false, now)
    }
  }

  // A failing hex is not support: retarget to the nearest still-solid waypoint and hop off.
  const standingInvalid = hexInvalidAt(px, pz)
  if (standingInvalid || hexInvalidAt(<f64>node.p_0, <f64>node.p_2)) {
    const alt = nearestValidNode(waypoints, nodes, seatEntity, px, pz)
    if (alt >= 0 && alt != current) {
      current = alt
      nodeRow = nodeAt(nodes, current)
      if (nodeRow < 0) fail('route references an unresolved authored node')
      node = nodes.at(<u32>nodeRow)
      dx = <f64>node.p_0 - px
      dz = <f64>node.p_2 - pz
      dist = Math.sqrt(dx * dx + dz * dz)
    }
  }
  memory.path_index = <u32>current
  if (dist <= arrive && Math.abs(<f64>node.p_1 - py) <= 0.9 && !standingInvalid) {
    memoryRows.write()
    return 0
  }

  let ux = dist > 1e-6 ? dx / dist : 0.0
  let uz = dist > 1e-6 ? dz / dist : 0.0
  const aim = newRecord<Aim>(<u32>sizeof<Aim>())
  const onRamp = rampTarget(nodes, current, px, py, feet, pz, ux, uz, aim)

  // Walk the route direction: the first unsupported run is a gap when it opens close enough
  // and closes within jump range; a raised surface close ahead is a reachable ledge.
  let gap = false
  let gapStart = -1.0
  let ledgeTop = NEG_INF
  let ledgeDist = 1e30
  for (let s = 0.3; s <= GAP_PROBE + 1e-9; s += GAP_STEP) {
    const top = supportTop(px + ux * s, feet, pz + uz * s)
    if (top == NEG_INF) {
      if (gapStart < 0) gapStart = s
      continue
    }
    if (gapStart >= 0) {
      if (gapStart <= GAP_LEAD && s - gapStart <= GAP_MAX) gap = true
      gapStart = -1
    }
    if (top > feet + LEDGE_STEP && top - feet <= GRAB_REACH && s <= LEDGE_SCAN && s < ledgeDist) {
      ledgeTop = top
      ledgeDist = s
    }
  }
  const grounded = groundedAt(px, py, pz, stand)
  const ledge = ledgeTop != NEG_INF

  let jump = false
  let dive = false
  let grab = false
  if (ledge) {
    if (grounded) jump = true
    else if (ledgeDist <= LEDGE_NEAR) grab = true
  }
  if (gap && grounded) jump = true
  if (rotorAhead(nodes, movers, transforms, px, py, pz, ux, uz) && grounded) jump = true
  if (!jump && !grab && grounded && seesawAhead(movers, transforms, px, pz, ux, uz)) dive = true
  if (standingInvalid && grounded) jump = true
  if (dive) jump = false
  // A predictable free track is waited out; a stateful see-saw was handled as a dive above.
  if (!jump && !dive && !grab && crossingBlocked(radius, halfHeight, px, py, pz, ux, uz, dist)) {
    memoryRows.write()
    return 0
  }

  let mx = dx
  let mz = dz
  if (onRamp && aim.ok) {
    mx = aim.x - px
    mz = aim.z - pz
  }
  memoryRows.write()
  return emit(mx, mz, jump, dive, grab, now)
}
