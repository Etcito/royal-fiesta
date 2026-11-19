import { Seat } from '../components.gen'

// packages/sim/src/season/respawn.ts:7
const RESPAWN_GRID_COLUMNS: u32 = 4
// packages/sim/src/season/respawn.ts:8
const RESPAWN_GRID_ROWS: u32 = 3
// packages/sim/src/season/respawn.ts:9
const RESPAWN_MAX_SLOTS: u32 = 12

export function respawnSlotCount(slots: u32): u32 {
  const count = <u32>Math.min(<f64>slots, <f64>RESPAWN_MAX_SLOTS)
  return count > 0 ? count : 1
}

/** Handoff: card 'rf_seat_rules system script and its schedule row (rank 13)' calls `scheduleRespawn`, `dueRespawn`, `respawnSlotCount`, `respawnSlotX`, `respawnSlotZ`, `nextSlot` and `nextCursor` for seat timers and anchor cursors. */
export function scheduleRespawn(seat: Seat, tick: i32, waitTicks: u32, protectTicks: u32): void {
  seat.wait_until = tick + <i32>waitTicks
  seat.protect_until = seat.wait_until + <i32>protectTicks
}

export function dueRespawn(waitUntil: i32, tick: i32): bool {
  return waitUntil >= 0 && tick >= waitUntil
}

function slotOffset(slot: u32, slots: u32, spacingM: f64): f64 {
  const index = slot % respawnSlotCount(slots)
  return (<f64>(index % RESPAWN_GRID_COLUMNS) - 1.5) * spacingM
}

export function respawnSlotX(bx: f64, bz: f64, fx: f64, fz: f64, slot: u32, slots: u32, spacingM: f64): f64 {
  const index = slot % respawnSlotCount(slots)
  const alongRight = slotOffset(slot, slots, spacingM)
  const alongBack = (<f64>Math.floor(<f64>(index / RESPAWN_GRID_COLUMNS)) - <f64>(RESPAWN_GRID_ROWS - 1) / 2.0) * spacingM
  return bx - fz * alongRight - fx * alongBack
}

export function respawnSlotZ(bx: f64, bz: f64, fx: f64, fz: f64, slot: u32, slots: u32, spacingM: f64): f64 {
  const index = slot % respawnSlotCount(slots)
  const alongRight = slotOffset(slot, slots, spacingM)
  const alongBack = (<f64>Math.floor(<f64>(index / RESPAWN_GRID_COLUMNS)) - <f64>(RESPAWN_GRID_ROWS - 1) / 2.0) * spacingM
  return bz + fx * alongRight - fz * alongBack
}

export function nextSlot(cursor: u32, slots: u32): u32 {
  return cursor % respawnSlotCount(slots)
}

export function nextCursor(slot: u32, slots: u32): u32 {
  return (slot + 1) % respawnSlotCount(slots)
}
