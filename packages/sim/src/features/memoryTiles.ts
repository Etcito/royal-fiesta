// Memory tile floor: each cycle reveals a symbol per cell, hides it, then falls
// every cell whose symbol is not the target. Correct crossings emit a match event
// with their crossing ticks; unsuccessful ones count the penalty.

import { fnv1a32 } from '@gamesaloon/rollback'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { intParam, numParam, ticksParam, vec3Param } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'
import { TileCells, TileState } from './tiles.ts'

const MIN_CELLS = 4
const MAX_CELLS = 512
const MARKER_LIFT_M = 0.3
const FAR_EDGE_GAP_M = 0.5

type Phase = 'idle' | 'reveal' | 'hide' | 'choice' | 'done'

function symbolTint(symbol: number): 1 | 2 | 3 | 4 {
  return ((symbol % 4) + 1) as 1 | 2 | 3 | 4
}

function seedGuess(seat: number, cycle: number): number {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, seat >>> 0, true)
  view.setUint32(4, cycle >>> 0, true)
  return fnv1a32(bytes)
}

export const memoryTilesFeature: FeatureFactory = (spec, path) => {
  const origin = vec3Param(spec, path, 'origin')
  const cols = intParam(spec, path, 'cols', 1, MAX_CELLS)
  const rows = intParam(spec, path, 'rows', 1, MAX_CELLS)
  const count = cols * rows
  if (count < MIN_CELLS || count > MAX_CELLS) {
    refuse('feature', `${path}/cols`, `expected cols * rows in ${MIN_CELLS}..${MAX_CELLS}; got ${cols} x ${rows}`)
  }
  const cellM = numParam(spec, path, 'cellM', 0.2, 100)
  const symbols = intParam(spec, path, 'symbols', 2, 6)
  const cycles = intParam(spec, path, 'cycles', 1, 20)
  const revealTicks = ticksParam(spec, path, 'revealS', 0, 600)
  const hideTicks = ticksParam(spec, path, 'hideS', 0, 600)
  const choiceTicks = ticksParam(spec, path, 'choiceS', 0, 600)
  const penaltyTicks = ticksParam(spec, path, 'penaltyS', 0, 600, 14)
  const cycleTicks = revealTicks + hideTicks + choiceTicks
  const choiceOffset = revealTicks + hideTicks

  const half = v3(cellM / 2 - 0.05, 0.2, cellM / 2 - 0.05)
  const cellSpecs = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cellSpecs.push({
        t: v3(origin.x + c * cellM, origin.y, origin.z + r * cellM),
        half: { ...half },
      })
    }
  }
  const cells = new TileCells(cellSpecs)
  const cellSymbols = new Uint8Array(count)
  const cycleSymbols = new Uint8Array(count * cycles)
  const cycleTargets = new Uint8Array(cycles)
  const markerHalf = v3(cellM * 0.5, 0.1, cellM * 0.5)
  const farX = origin.x + ((cols - 1) * cellM) / 2
  const farZ = origin.z + (rows - 1) * cellM + cellM / 2 + FAR_EDGE_GAP_M
  let firstCorrectTick = new Int32Array(0)
  let target = 0
  let cycle = -1
  let phase: Phase = 'idle'
  let choiceStartTick = 0
  let finalized = false

  const syncSeats = (ctx: FeatureCtx): void => {
    const n = ctx.seats.count
    if (firstCorrectTick.length === n) return
    const next = new Int32Array(n)
    next.fill(-1)
    const keep = Math.min(n, firstCorrectTick.length)
    for (let i = 0; i < keep; i++) next[i] = firstCorrectTick[i]
    firstCorrectTick = next
  }

  const settleCells = (): void => {
    for (let cell = 0; cell < count; cell++) {
      if (cells.state[cell] !== TileState.solid) cells.setSolid(cell)
    }
  }

  const startReveal = (c: number): void => {
    const base = c * count
    for (let cell = 0; cell < count; cell++) cellSymbols[cell] = cycleSymbols[base + cell]
    target = cycleTargets[c]
    for (let cell = 0; cell < count; cell++) cells.setSolid(cell)
    firstCorrectTick.fill(-1)
    finalized = false
    phase = 'reveal'
  }

  const startChoice = (ctx: FeatureCtx): void => {
    for (let cell = 0; cell < count; cell++) {
      if (cellSymbols[cell] !== target) cells.setFalling(cell)
    }
    choiceStartTick = ctx.tick
  }

  const finishChoice = (ctx: FeatureCtx): void => {
    finalized = true
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      const recorded = firstCorrectTick[i]
      if (recorded >= 0) ctx.emit('match', ctx.seats.seat(i), 1, recorded - choiceStartTick)
      else ctx.emit('match', ctx.seats.seat(i), 0, penaltyTicks)
    }
  }

  const recordCrossings = (ctx: FeatureCtx): void => {
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (firstCorrectTick[i] >= 0) continue
      if (ctx.seats.status(i) !== PlayerStatus.alive || !ctx.seats.grounded(i)) continue
      const cell = cells.cellUnder(ctx.seats, i)
      if (cell >= 0 && cellSymbols[cell] === target) firstCorrectTick[i] = ctx.tick
    }
  }

  return {
    id: spec.id,
    kind: 'memoryTiles',
    init(ctx) {
      cells.build(ctx)
      syncSeats(ctx)
      for (let c = 0; c < cycles; c++) {
        const base = c * count
        for (let cell = 0; cell < count; cell++) cycleSymbols[base + cell] = ctx.rng.int(0, symbols - 1)
        cycleTargets[c] = ctx.rng.int(0, symbols - 1)
      }
    },
    preStep(_ctx) {},
    postStep(ctx) {
      syncSeats(ctx)
      const now = ctx.roundTick
      if (now >= 0) {
        const index = Math.floor(now / cycleTicks)
        if (index !== cycle) {
          if (cycle >= 0 && cycle < cycles && !finalized) finishChoice(ctx)
          cycle = index
          finalized = false
          if (cycle < cycles) startReveal(cycle)
          else {
            phase = 'done'
            settleCells()
          }
        }
        if (cycle >= cycles) {
          phase = 'done'
          settleCells()
        } else {
          const offset = now - cycle * cycleTicks
          const next: Phase = offset < revealTicks ? 'reveal' : offset < choiceOffset ? 'hide' : 'choice'
          if (next !== phase) {
            phase = next
            if (next === 'choice') startChoice(ctx)
          }
          if (phase === 'choice') {
            recordCrossings(ctx)
            if (offset === cycleTicks - 1 && !finalized) {
              finishChoice(ctx)
              if (cycle === cycles - 1) settleCells()
            }
          }
        }
      }
      // The pool ages falling cells and keeps the solid ones; the huge decay value
      // means memory tiles never warn or decay from contact, they only fall.
      cells.step(ctx, Number.MAX_SAFE_INTEGER, 1, -1)
    },
    snapshot(w: SnapWriter) {
      cells.snapshot(w)
      for (let cell = 0; cell < count; cell++) w.u8(cellSymbols[cell])
      w.u8(target)
      w.i32(cycle)
      w.u16(firstCorrectTick.length)
      for (let i = 0; i < firstCorrectTick.length; i++) w.i32(firstCorrectTick[i])
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      cells.restore(r, ctx)
      for (let cell = 0; cell < count; cell++) cellSymbols[cell] = r.u8()
      target = r.u8()
      cycle = r.i32()
      const n = r.u16()
      const recorded = new Int32Array(n)
      for (let i = 0; i < n; i++) recorded[i] = r.i32()
      firstCorrectTick = new Int32Array(ctx.seats.count)
      firstCorrectTick.fill(-1)
      const keep = Math.min(n, ctx.seats.count)
      for (let i = 0; i < keep; i++) firstCorrectTick[i] = recorded[i]
      finalized = false
      choiceStartTick = 0
      if (cycle < 0) {
        phase = 'idle'
      } else if (cycle >= cycles) {
        phase = 'done'
        settleCells()
      } else {
        const offset = ctx.roundTick - cycle * cycleTicks
        if (offset >= cycleTicks) {
          phase = 'choice'
          finalized = true
          choiceStartTick = ctx.tick - (offset - choiceOffset)
        } else if (offset < revealTicks) {
          phase = 'reveal'
        } else if (offset < choiceOffset) {
          phase = 'hide'
        } else {
          phase = 'choice'
          choiceStartTick = ctx.tick - (offset - choiceOffset)
          if (offset === cycleTicks - 1) finalized = true
          if (offset === choiceOffset) {
            // A snapshot taken just before the first choice tick still has every
            // cell solid; only this restored tick has to apply the wrong falls.
            let started = false
            for (let cell = 0; cell < count; cell++) {
              if (cellSymbols[cell] !== target && cells.state[cell] === TileState.falling) {
                started = true
                break
              }
            }
            if (!started) startChoice(ctx)
          }
        }
      }
    },
    draw(out) {
      cells.draw(out, 'plan.memory-tile')
      if (phase === 'reveal') {
        for (let cell = 0; cell < count; cell++) {
          const t = cells.centre[cell]
          out.push({
            asset: 'candy.floor-disc',
            t: v3(t.x, t.y + cells.half[cell].y + MARKER_LIFT_M, t.z),
            r: quatIdentity(),
            s: { ...markerHalf },
            visible: true,
            tint: symbolTint(cellSymbols[cell]),
          })
        }
      } else if (phase === 'choice') {
        out.push({
          asset: 'candy.floor-disc',
          t: v3(farX, origin.y + MARKER_LIFT_M, farZ),
          r: quatIdentity(),
          s: { ...markerHalf },
          visible: true,
          tint: symbolTint(target),
        })
      }
    },
    botTarget(seat: number, _pos: Vec3, out: Vec3): boolean {
      if (phase !== 'hide' && phase !== 'choice') return false
      const h = seedGuess(seat, cycle)
      let picked = h % count
      if ((h >>> 8) % 10 < 7) {
        let correctCount = 0
        for (let cell = 0; cell < count; cell++) if (cellSymbols[cell] === target) correctCount++
        if (correctCount > 0) {
          let slot = h % correctCount
          for (let cell = 0; cell < count; cell++) {
            if (cellSymbols[cell] !== target) continue
            if (slot === 0) {
              picked = cell
              break
            }
            slot--
          }
        }
      }
      const t = cells.centre[picked]
      out.x = t.x
      out.y = t.y + cells.half[picked].y
      out.z = t.z
      return true
    },
  }
}
