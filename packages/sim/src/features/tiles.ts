// Shared tile-cell pool for tileField, hexField and memoryTiles. Cells are
// created once in init as fixed bodies with one collider each; every later
// state change only enables or disables that pooled collider.

import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Quat, Vec3 } from '../vec.ts'
import { GRAVITY_Y } from '../world.ts'
import type { FeatureCtx, FeatureDraw, FeatureFactory, FeatureSeats } from './feature.ts'
import { enumParam, listParam, numOf, objOf, ticksParam, vec3Of } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'

const MAX_CELLS = 512
const FALL_TICKS = 30

export const TileState = { solid: 0, warning: 1, falling: 2, gone: 3 } as const

export interface TileCellSpec {
  t: Vec3
  half: Vec3
  r?: Quat
  border?: number
}

type GroundSeats = Pick<FeatureSeats, 'groundCollider'>

export class TileCells {
  readonly count: number
  readonly state: Uint8Array
  readonly timer: Uint16Array
  readonly centre: Vec3[]
  readonly half: Vec3[]
  readonly rot: Quat[]
  readonly body: number[]
  readonly #border: number[]
  readonly #contact: Uint8Array
  #colliderToCell = new Map<number, number>()
  #physics!: RapierWorldSim

  constructor(cells: readonly TileCellSpec[]) {
    if (cells.length > MAX_CELLS) {
      throw new Error(`TileCells holds at most ${MAX_CELLS} cells, got ${cells.length}`)
    }
    this.count = cells.length
    this.state = new Uint8Array(cells.length)
    this.timer = new Uint16Array(cells.length)
    this.centre = cells.map(cell => ({ ...cell.t }))
    this.half = cells.map(cell => ({ ...cell.half }))
    this.rot = cells.map(cell => (cell.r === undefined ? quatIdentity() : { ...cell.r }))
    this.body = new Array<number>(cells.length).fill(-1)
    this.#border = cells.map(cell => cell.border ?? 0)
    this.#contact = new Uint8Array(cells.length)
  }

  build(ctx: FeatureCtx): void {
    this.#physics = ctx.physics
    const map = new Map<number, number>()
    for (let cell = 0; cell < this.count; cell++) {
      const t = this.centre[cell]
      const half = this.half[cell]
      const border = this.#border[cell]
      const collider = border > 0
        ? ctx.R.ColliderDesc.roundCuboid(half.x, half.y, half.z, border)
        : ctx.R.ColliderDesc.cuboid(half.x, half.y, half.z)
      collider.setCollisionGroups(groups(G.STATIC, G.CHAR | G.PROBE | G.DEBRIS))
      const body = ctx.physics.createBody(
        ctx.R.RigidBodyDesc.fixed()
          .setTranslation(t.x, t.y, t.z)
          .setRotation(this.rot[cell]),
        [collider],
      )
      this.body[cell] = body
      map.set(ctx.physics.body(body).collider(0).handle, cell)
    }
    this.#colliderToCell = map
  }

  cellUnder(seats: GroundSeats, i: number): number {
    const cell = this.#colliderToCell.get(seats.groundCollider(i))
    return cell === undefined ? -1 : cell
  }

  #setEnabled(cell: number, enabled: boolean): void {
    const id = this.body[cell]
    if (id < 0) return
    const collider = this.#physics.body(id).collider(0)
    if (collider.isEnabled() !== enabled) collider.setEnabled(enabled)
  }

  setGone(cell: number): void {
    this.state[cell] = TileState.gone
    this.timer[cell] = 0
    this.#setEnabled(cell, false)
  }

  setSolid(cell: number): void {
    this.state[cell] = TileState.solid
    this.timer[cell] = 0
    this.#setEnabled(cell, true)
  }

  setFalling(cell: number): void {
    this.state[cell] = TileState.falling
    this.timer[cell] = 0
    this.#setEnabled(cell, false)
  }

  step(ctx: FeatureCtx, decayTicks: number, warnTicks: number, resetTicks: number): void {
    this.#contact.fill(0)
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive || !ctx.seats.grounded(i)) continue
      const cell = this.cellUnder(ctx.seats, i)
      if (cell >= 0 && this.state[cell] === TileState.solid) this.#contact[cell] = 1
    }
    const rate = ctx.overtime ? 2 : 1
    for (let cell = 0; cell < this.count; cell++) {
      const state = this.state[cell]
      if (state === TileState.solid) {
        if (this.#contact[cell] === 0) continue
        const next = this.timer[cell] + rate
        if (next < decayTicks) {
          this.timer[cell] = next
          continue
        }
        this.state[cell] = TileState.warning
        this.timer[cell] = warnTicks
        ctx.sound('mech.tile-warn', this.centre[cell], 1)
      } else if (state === TileState.warning) {
        if (this.timer[cell] > 1) {
          this.timer[cell]--
          continue
        }
        this.setFalling(cell)
        ctx.sound('mech.tile-fall', this.centre[cell], 1)
      } else if (state === TileState.falling) {
        const age = this.timer[cell] + 1
        if (age < FALL_TICKS) {
          this.timer[cell] = age
          continue
        }
        this.setGone(cell)
      } else if (resetTicks >= 0) {
        const age = this.timer[cell] + 1
        if (age < resetTicks) {
          this.timer[cell] = age
          continue
        }
        this.setSolid(cell)
      }
    }
  }

  snapshot(w: SnapWriter): void {
    for (let cell = 0; cell < this.count; cell++) {
      w.u8(this.state[cell])
      w.u16(this.timer[cell])
    }
  }

  restore(r: SnapReader, ctx: FeatureCtx): void {
    this.#physics = ctx.physics
    const map = new Map<number, number>()
    for (let cell = 0; cell < this.count; cell++) {
      const state = r.u8()
      this.state[cell] = state
      this.timer[cell] = r.u16()
      const collider = ctx.physics.body(this.body[cell]).collider(0)
      const enabled = state === TileState.solid || state === TileState.warning
      if (collider.isEnabled() !== enabled) collider.setEnabled(enabled)
      map.set(collider.handle, cell)
    }
    this.#colliderToCell = map
  }

  draw(out: FeatureDraw[], asset: string): void {
    for (let cell = 0; cell < this.count; cell++) {
      const state = this.state[cell]
      if (state === TileState.gone) continue
      const t = this.centre[cell]
      const half = this.half[cell]
      let y = t.y
      if (state === TileState.falling) {
        const seconds = this.timer[cell] / 60
        y += 0.5 * GRAVITY_Y * seconds * seconds
      }
      out.push({
        asset,
        t: v3(t.x, y, t.z),
        r: { ...this.rot[cell] },
        s: v3(half.x * 2, half.y * 2, half.z * 2),
        visible: true,
        tint: state === TileState.warning ? 1 : 0,
      })
    }
  }

  nearestSolid(pos: Vec3, out: Vec3): boolean {
    let best = -1
    let bestD = Infinity
    for (let cell = 0; cell < this.count; cell++) {
      if (this.state[cell] !== TileState.solid) continue
      const t = this.centre[cell]
      const dx = t.x - pos.x
      const dz = t.z - pos.z
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = cell
      }
    }
    if (best < 0) return false
    const t = this.centre[best]
    out.x = t.x
    out.y = t.y + this.half[best].y
    out.z = t.z
    return true
  }
}

export const tileFieldFeature: FeatureFactory = (spec, path) => {
  const cells = new TileCells(listParam(spec, path, 'tiles', 1, MAX_CELLS).map((value, index) => {
    const ptr = `${path}/tiles/${index}`
    const tile = objOf(value, ptr)
    const t = vec3Of(tile.t, `${ptr}/t`)
    const size = vec3Of(tile.size, `${ptr}/size`)
    const w = numOf(size.x, `${ptr}/size/0`, 0.05, 100)
    const d = numOf(size.y, `${ptr}/size/1`, 0.05, 100)
    const h = numOf(size.z, `${ptr}/size/2`, 0.05, 100)
    return { t, half: v3(w / 2, h / 2, d / 2) }
  }))
  const decayTicks = ticksParam(spec, path, 'decayS', 0, 600)
  const warnTicks = ticksParam(spec, path, 'warnS', 0, 600)
  const mode = enumParam(spec, path, 'mode', ['reset', 'permanent'] as const)
  const resetTicks = mode === 'reset' ? ticksParam(spec, path, 'resetS', 0, 600) : -1

  return {
    id: spec.id,
    kind: 'tileField',
    init(ctx) { cells.build(ctx) },
    preStep(_ctx) {},
    postStep(ctx) { cells.step(ctx, decayTicks, warnTicks, resetTicks) },
    snapshot(w) { cells.snapshot(w) },
    restore(r, ctx) { cells.restore(r, ctx) },
    draw(out) { cells.draw(out, 'plan.trap-tile') },
    botTarget(_seat, position, out) { return cells.nearestSolid(position, out) },
  }
}
