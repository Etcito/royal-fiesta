import type { Rng } from '@gamesaloon/rollback'
import type { ResolvedCourse } from '../course.ts'
import { dsincos } from '../detmath.ts'
import type { SinCos } from '../detmath.ts'
import { encodeInput, NEUTRAL_CODE } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import type { Vec3 } from '../vec.ts'

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

export interface BrainInput { course: ResolvedCourse; pos: Vec3; vel: Vec3; facing: { x: number; z: number }; grounded: boolean; mode: number; obstacleAhead: boolean; hazardNear: boolean }

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
