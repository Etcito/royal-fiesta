import type { ZoneRoundResult } from '../net/zoneRounds.ts'

export const ELIM_SHOW = Object.freeze({
  minMs: 6000,
  maxMs: 8000,
  cols: 10,
  rows: 6,
  skipAfterMs: 1500,
})

export type ElimCellState = 'stay' | 'drop' | 'gone'

export interface ElimShowModel {
  grid: { seat: number; col: number; row: number; state: ElimCellState }[]
  counter: { from: number; to: number; now: number }
  doneAtMs: number
  lastMs: number
  schedule: { seat: number; atMs: number }[]
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

export function elimShow(entrants: readonly number[], result: ZoneRoundResult): ElimShowModel {
  const present = new Set(entrants)
  const order = result.eliminated.filter(seat => present.has(seat))
  const count = order.length
  const interval = count === 0
    ? 0
    : clamp((7000 - ELIM_SHOW.skipAfterMs) / Math.max(1, count), 40, 1000)
  const doneAtMs = count === 0
    ? ELIM_SHOW.minMs
    : clamp(ELIM_SHOW.skipAfterMs + count * interval + 600, ELIM_SHOW.minMs, ELIM_SHOW.maxMs)
  const group = result.kind === 'team'
  return {
    grid: entrants.map((seat, index) => ({
      seat,
      col: index % ELIM_SHOW.cols,
      row: Math.floor(index / ELIM_SHOW.cols),
      state: 'stay',
    })),
    counter: { from: entrants.length, to: entrants.length - count, now: entrants.length },
    doneAtMs,
    lastMs: 0,
    schedule: order.map((seat, index) => ({ seat, atMs: group ? ELIM_SHOW.skipAfterMs : ELIM_SHOW.skipAfterMs + index * interval })),
  }
}

export function elimShowAt(m: ElimShowModel, ms: number): { drops: number[]; counter: number; done: boolean } {
  const from = m.lastMs
  const due = ms > from
    ? m.schedule.filter(entry => entry.atMs > from && entry.atMs <= ms)
    : []
  if (ms > m.lastMs) m.lastMs = ms
  const dropped = m.schedule.filter(entry => entry.atMs <= m.lastMs).length
  m.counter.now = m.counter.from - dropped
  if (due.length > 0) {
    const seats = new Set(due.map(entry => entry.seat))
    for (const cell of m.grid) if (cell.state === 'stay' && seats.has(cell.seat)) cell.state = 'drop'
  }
  return { drops: due.map(entry => entry.seat), counter: m.counter.now, done: ms >= m.doneAtMs }
}

export function elimSkip(m: ElimShowModel, ms: number): ElimShowModel {
  if (ms < ELIM_SHOW.skipAfterMs) return m
  const seats = new Set(m.schedule.map(entry => entry.seat))
  return {
    grid: m.grid.map(cell => ({
      ...cell,
      state: seats.has(cell.seat) ? 'gone' : cell.state,
    })),
    counter: { from: m.counter.from, to: m.counter.to, now: m.counter.to },
    doneAtMs: ms,
    lastMs: ms,
    schedule: m.schedule.map(entry => ({ ...entry })),
  }
}
