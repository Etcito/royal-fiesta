import { Column, cos, getComponent, inputCode, isNull, readColumn, setComponent, sin, spawn, tick } from 'ege'
import { BotBehaviour, BotMemory, BotReaction, BotReactionChunk, BotRoute, BotSeat, BotSkill, ShowControl, ShowSeatIdentity } from '../components.gen'
import { applyShowBehaviour } from './behaviour.as'
import { planShowRoute } from './routes.as'
import { showTraversalControl } from './traversal.as'

const NO_ENTITY: u32 = 0xffffffff
const MAX_REACTION: u32 = 120
const BOT_RNG_SALT: u32 = 0xb0700000

class Mulberry {
  state: u32
  constructor(state: u32) { this.state = state }
  nextU32(): u32 {
    this.state += <u32>0x6d2b79f5
    let t = this.state
    t = (t ^ (t >>> 15)) * (t | 1)
    t ^= t + ((t ^ (t >>> 7)) * (t | 61))
    return t ^ (t >>> 14)
  }
  next(): f64 { return <f64>this.nextU32() / 4294967296.0 }
  range(a: f64, b: f64): f64 { return a + (b - a) * this.next() }
  int(a: u32, b: u32): u32 { return a + <u32>(this.next() * <f64>(b - a + 1)) }
  fork(salt: u32): Mulberry { return new Mulberry(mix32(this.state ^ salt)) }
}

function fail(message: string): void { abort(message, 'scripts/ege/bots/brain.as.ts', 0, 0) }

function mix32(value: u32): u32 {
  let h = value
  h ^= h >>> 16
  h *= <u32>0x85ebca6b
  h ^= h >>> 13
  h *= <u32>0xc2b2ae35
  h ^= h >>> 16
  return h
}

function codeAt(row: BotReactionChunk, index: u32): u32 {
  if (index == 0) return row.codes_0
  if (index == 1) return row.codes_1
  if (index == 2) return row.codes_2
  if (index == 3) return row.codes_3
  if (index == 4) return row.codes_4
  if (index == 5) return row.codes_5
  if (index == 6) return row.codes_6
  if (index == 7) return row.codes_7
  if (index == 8) return row.codes_8
  if (index == 9) return row.codes_9
  if (index == 10) return row.codes_10
  if (index == 11) return row.codes_11
  if (index == 12) return row.codes_12
  if (index == 13) return row.codes_13
  if (index == 14) return row.codes_14
  if (index == 15) return row.codes_15
  fail('reaction code index is outside its chunk')
  return 0
}

function putCode(row: BotReactionChunk, index: u32, value: u32): void {
  if (index == 0) row.codes_0 = value
  else if (index == 1) row.codes_1 = value
  else if (index == 2) row.codes_2 = value
  else if (index == 3) row.codes_3 = value
  else if (index == 4) row.codes_4 = value
  else if (index == 5) row.codes_5 = value
  else if (index == 6) row.codes_6 = value
  else if (index == 7) row.codes_7 = value
  else if (index == 8) row.codes_8 = value
  else if (index == 9) row.codes_9 = value
  else if (index == 10) row.codes_10 = value
  else if (index == 11) row.codes_11 = value
  else if (index == 12) row.codes_12 = value
  else if (index == 13) row.codes_13 = value
  else if (index == 14) row.codes_14 = value
  else if (index == 15) row.codes_15 = value
  else fail('reaction code index is outside its chunk')
}

const S1_BUTTON_MASK: u32 = 0x70000

function axisS1(axis: i32): u32 {
  const clamped = axis < -127 ? -127 : (axis > 127 ? 127 : axis)
  return <u32>(clamped + 127)
}

function axisEngine(byte: u32): i32 {
  const clamped: u32 = byte > 254 ? 254 : byte
  return <i32>clamped - 127
}

/** Engine axis bytes become offset S1 bytes; button bits 16..18 survive unchanged. */
function s1OfEngine(code: u32): u32 {
  const qx = <i32><i8><u8>(code & 0xff)
  const qz = <i32><i8><u8>((code >>> 8) & 0xff)
  return axisS1(qx) | (axisS1(qz) << 8) | (code & S1_BUTTON_MASK)
}

/** Offset S1 axis bytes become signed engine bytes; button bits 16..18 survive unchanged. */
function engineOfS1(code: u32): u32 {
  const qx = axisEngine(code & 0xff)
  const qz = axisEngine((code >>> 8) & 0xff)
  return (<u32>qx & 0xff) | ((<u32>qz & 0xff) << 8) | (code & S1_BUTTON_MASK)
}

function wobble(code: u32, angle: f64): u32 {
  const x = <f64><i8><u8>code / 127.0
  const z = <f64><i8><u8>(code >>> 8) / 127.0
  const c = <f64>cos(<f32>angle)
  const s = <f64>sin(<f32>angle)
  const rx = Math.max(-1.0, Math.min(1.0, x * c + z * s))
  const rz = Math.max(-1.0, Math.min(1.0, z * c - x * s))
  const ax = <i32>Math.round(rx * 127.0)
  const az = <i32>Math.round(rz * 127.0)
  return (<u32>ax & 0xff) | ((<u32>az & 0xff) << 8) | (code & 0x70000)
}

function reaction(seat: u32, code: u32, delay: u32): u32 {
  if (delay > MAX_REACTION) fail('reaction delay is outside 0..120 ticks')
  if (delay == 0) return code
  const rows = readColumn<BotReaction>(BotReaction.ID, BotReaction.SIZE)
  let ri = -1
  for (let i: u32 = 0; i < rows.count; i++) if (rows.at(i).owner == seat) { ri = <i32>i; break }
  let row: BotReaction
  let newReaction = false
  let reactionEntity = NO_ENTITY
  if (ri < 0) {
    row = new BotReaction()
    row.owner = seat
    row.chunk_head = NO_ENTITY
    row.chunk_tail = NO_ENTITY
    row.delay_ticks = delay
    reactionEntity = spawn()
    newReaction = true
  } else row = rows.at(<u32>ri)
  if (row.delay_ticks != delay) fail('reaction delay changed after initialization')
  const chunks = readColumn<BotReactionChunk>(BotReactionChunk.ID, BotReactionChunk.SIZE)
  let result: u32 = 0
  let recycled: u32 = NO_ENTITY
  if (row.code_count >= delay) {
    const headIndex = chunks.find(row.chunk_head)
    if (headIndex < 0) fail('reaction queue head is unresolved')
    const head = chunks.at(<u32>headIndex)
    result = codeAt(head, 0)
    for (let i: u32 = 1; i < head.code_count; i++) putCode(head, i - 1, codeAt(head, i))
    head.code_count--
    row.code_count--
    if (head.code_count == 0 && head.next_chunk != NO_ENTITY) {
      recycled = row.chunk_head
      row.chunk_head = head.next_chunk
    }
  }
  let tail = chunks.find(row.chunk_tail)
  let created = false
  let lastChunk = new BotReactionChunk()
  let tailFull = false
  if (tail >= 0) tailFull = chunks.at(<u32>tail).code_count == 16
  if (tail < 0 || tailFull) {
    let chunkEntity = recycled
    let chunk: BotReactionChunk
    if (chunkEntity != NO_ENTITY) {
      const oldHead = chunks.at(<u32>chunks.find(chunkEntity))
      oldHead.next_chunk = NO_ENTITY; oldHead.chunk_index = row.code_count / 16; oldHead.code_count = 0
      chunk = oldHead
    } else {
      chunk = new BotReactionChunk()
      chunk.owner = seat; chunk.next_chunk = NO_ENTITY; chunk.chunk_index = row.code_count / 16
      chunkEntity = spawn()
      created = true
    }
    if (tail >= 0) chunks.at(<u32>tail).next_chunk = chunkEntity
    else row.chunk_head = chunkEntity
    row.chunk_tail = chunkEntity
    lastChunk = chunk
    if (recycled == NO_ENTITY) setComponent<BotReactionChunk>(chunkEntity, BotReactionChunk.ID, BotReactionChunk.SIZE, chunk)
    tail = created ? -1 : chunks.find(chunkEntity)
  }
  if (tail < 0 && !created) fail('reaction tail is unresolved')
  const last = created ? lastChunk : chunks.at(<u32>tail)
  if (last.code_count >= 16) fail('reaction queue chunk is full without a successor')
  putCode(last, last.code_count++, code)
  if (created) setComponent<BotReactionChunk>(row.chunk_tail, BotReactionChunk.ID, BotReactionChunk.SIZE, last)
  row.code_count++
  chunks.write()
  if (newReaction) setComponent<BotReaction>(reactionEntity, BotReaction.ID, BotReaction.SIZE, row)
  else rows.write()
  return result
}

function ensureSkill(seat: u32, roomSeat: u32, memory: BotMemory): BotSkill {
  const skills = readColumn<BotSkill>(BotSkill.ID, BotSkill.SIZE)
  const found = skills.find(seat)
  if (found >= 0) return skills.at(<u32>found)
  const root = new Mulberry(memory.rng_state)
  const rng = root.fork(BOT_RNG_SALT + roomSeat)
  const skill = new BotSkill()
  skill.owner = seat
  skill.reaction_ticks = rng.int(0, 10)
  skill.aim_error = rng.range(0, 0.2)
  skill.jump_lead = rng.range(0, 0.4)
  skill.dive_chance = rng.range(0, 0.3)
  memory.rng_state = rng.state
  setComponent<BotSkill>(seat, BotSkill.ID, BotSkill.SIZE, skill)
  return skill
}

/** Bot RNG, skill draws, route/traversal/behavior lifecycle and reaction codes remain on the live seat entity through EGZ transfer. */
export function rf_show_controls(): void {
  const identities = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  for (let i: u32 = 0; i < identities.count; i++) {
    const identity = identities.at(i)
    if (identity.bot != 0 || identity.input_slot < 0) continue
    const control = getComponent<ShowControl>(identities.entity(i), ShowControl.ID, ShowControl.SIZE)
    if (!isNull<ShowControl>(control)) {
      control.code = s1OfEngine(inputCode(<u32>identity.input_slot))
      setComponent<ShowControl>(identities.entity(i), ShowControl.ID, ShowControl.SIZE, control)
    }
  }
}

/** Runs due decisions in contract order; a non-due tick only advances the seat's delayed control queue. */
export function rf_show_bots(): void {
  const now = <i32>tick()
  const seats = readColumn<BotSeat>(BotSeat.ID, BotSeat.SIZE)
  const memories = readColumn<BotMemory>(BotMemory.ID, BotMemory.SIZE)
  for (let i: u32 = 0; i < seats.count; i++) {
    const seatEntity = seats.entity(i)
    let mi = memories.find(seatEntity)
    if (mi < 0) fail('bot seat has no bot_memory record')
    let memory = memories.at(<u32>mi)
    const skills = readColumn<BotSkill>(BotSkill.ID, BotSkill.SIZE)
    let si = skills.find(seatEntity)
    const identities = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
    const identityIndex = identities.find(seatEntity)
    if (identityIndex < 0) fail('bot seat has no show_seat_identity record')
    const identity = identities.at(<u32>identityIndex)
    const skill = si < 0 ? ensureSkill(seatEntity, identity.room_seat, memory) : skills.at(<u32>si)
    const decision = seats.at(i)
    const authored = getComponent<BotBehaviour>(decision.behaviour, BotBehaviour.ID, BotBehaviour.SIZE)
    if (isNull<BotBehaviour>(authored)) fail('bot seat has no authored behaviour')
    const control = getComponent<ShowControl>(seatEntity, ShowControl.ID, ShowControl.SIZE)
    if (isNull<ShowControl>(control)) fail('bot seat has no show_control record')
    const routeRows = readColumn<BotRoute>(BotRoute.ID, BotRoute.SIZE)
    const routeRow = routeRows.find(seatEntity)
    const due = routeRow < 0 || now >= routeRows.at(<u32>routeRow).next_plan_tick
    const rng = new Mulberry(memory.rng_state)
    const wobbleDraw = rng.range(-1, 1)
    rng.next()
    memory.rng_state = rng.state
    if (now % 45 == 0) memory.wobble = wobbleDraw
    let proposed: u32 = 0
    if (due) {
      const pathNode = planShowRoute(seatEntity, now)
      proposed = showTraversalControl(seatEntity, now, pathNode)
      proposed = applyShowBehaviour(seatEntity, now, proposed)
      proposed = wobble(proposed, skill.aim_error * memory.wobble)
    } else {
      proposed = engineOfS1(control.code)
    }
    control.code = s1OfEngine(reaction(seatEntity, proposed, authored.reaction_ticks))
    setComponent<ShowControl>(seatEntity, ShowControl.ID, ShowControl.SIZE, control)
    memories.write()
  }
}
