import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RespawnSpec, SpawnPoint } from '../course.ts'

// Respawn timing and spread-slot placement. Anchors are the checkpoint indices
// followed by one anchor per home.

const GRID_COLUMNS = 4
const GRID_ROWS = 3
const MAX_SLOTS = 12

export interface RespawnState {
  waitUntil: Int32Array
  protectUntil: Int32Array
  slotCursor: Uint16Array
}

export function newRespawnState(seats: number, anchors: number): RespawnState {
  return {
    waitUntil: new Int32Array(seats).fill(-1),
    protectUntil: new Int32Array(seats).fill(-1),
    slotCursor: new Uint16Array(anchors),
  }
}

function slotCount(spec: RespawnSpec): number {
  const slots = Math.min(spec.slots, MAX_SLOTS) | 0
  return slots > 0 ? slots : 1
}

export function scheduleRespawn(spec: RespawnSpec, st: RespawnState, seat: number, tick: number): void {
  const waitUntil = tick + spec.waitTicks
  st.waitUntil[seat] = waitUntil
  st.protectUntil[seat] = waitUntil + spec.protectTicks
}

export function dueRespawn(st: RespawnState, seat: number, tick: number): boolean {
  const waitUntil = st.waitUntil[seat]
  return waitUntil >= 0 && tick >= waitUntil
}

export function respawnSlot(base: SpawnPoint, slot: number, spec: RespawnSpec, out: SpawnPoint): SpawnPoint {
  const count = slotCount(spec)
  const index = ((slot % count) + count) % count
  const column = index % GRID_COLUMNS
  const row = Math.floor(index / GRID_COLUMNS)
  const fx = base.facing.x
  const fz = base.facing.z
  const bx = base.t.x
  const by = base.t.y
  const bz = base.t.z
  const spacing = spec.spacingM
  const alongRight = (column - (GRID_COLUMNS - 1) / 2) * spacing
  const alongBack = (row - (GRID_ROWS - 1) / 2) * spacing
  // Right is the facing vector rotated -90 degrees about Y: (-fz, fx).
  out.t.x = bx - fz * alongRight - fx * alongBack
  out.t.y = by
  out.t.z = bz + fx * alongRight - fz * alongBack
  out.facing.x = fx
  out.facing.z = fz
  return out
}

export function nextSlot(st: RespawnState, anchor: number, spec: RespawnSpec): number {
  const count = slotCount(spec)
  const slot = st.slotCursor[anchor] % count
  st.slotCursor[anchor] = (slot + 1) % count
  return slot
}

export function writeRespawn(w: SnapWriter, st: RespawnState): void {
  for (let seat = 0; seat < st.waitUntil.length; seat++) {
    w.i32(st.waitUntil[seat])
    w.i32(st.protectUntil[seat])
  }
  for (let anchor = 0; anchor < st.slotCursor.length; anchor++) w.u16(st.slotCursor[anchor])
}

export function readRespawn(r: SnapReader, st: RespawnState): void {
  for (let seat = 0; seat < st.waitUntil.length; seat++) {
    st.waitUntil[seat] = r.i32()
    st.protectUntil[seat] = r.i32()
  }
  for (let anchor = 0; anchor < st.slotCursor.length; anchor++) st.slotCursor[anchor] = r.u16()
}
