// The elimination show: up to 60 tinted beans on a fixed 10x6 stage, thrown out one at a time.
import { elimShowAt, type ElimShowModel } from '@royal-fiesta/game/flow/elimShow'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { seatTint } from '@royal-fiesta/game/render/palette'
import type { CameraPose, QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { UaaHost } from '../ui/uaaHost.ts'

export interface FlowDeps {
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
}

export type ElimShowInput = ElimShowModel & { roundName?: string }

export interface ElimShowScreen {
  update(model: ElimShowInput, ms?: number): void
  unmount(): void
}

const COLS = 10
const ROWS = 6
const SPACING_X = 2
const SPACING_Y = 2
const BOTTOM_Y = 1
const POP_M = 1.6
const FALL_BELOW = -10
const THROW_MS = 700
const SHRINK_MS = 300
const SPIN_RAD = Math.PI * 6
const IDENTITY: QuatT = [0, 0, 0, 1]
const UNIT: Vec3T = [1, 1, 1]
const CAMERA: CameraPose = {
  eye: [0, 6.2, 16.5], target: [0, 6, 0], fovYDeg: 46, near: 0.1, far: 100,
}

type Phase = 'stay' | 'throw' | 'shrink' | 'hidden'

interface CellView {
  seat: number
  instance: number | null
  base: Vec3T
  phase: Phase
  startMs: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function spot(col: number, row: number): Vec3T {
  const x = (col - (COLS - 1) / 2) * SPACING_X
  const y = BOTTOM_Y + (ROWS - 1 - row) * SPACING_Y
  return [x, y, 0]
}

function yawQuat(angle: number): QuatT {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]
}

function present(host: UaaHost, model: ElimShowInput): void {
  const menu: MenuModel = {
    screen: 'elimShow',
    title: 'Eliminated',
    lines: [model.roundName ?? ''],
    buttons: [],
    hint: 'Enter skip',
    overlay: true,
  }
  host.present(menu)
  host.setHud({
    'elim-counter': { text: `${model.counter.from} to ${model.counter.to}`, visible: true },
    'elim-now': { text: { count: String(model.counter.now) }, visible: true },
  })
}

export function mountElimShow(host: UaaHost, model: ElimShowInput, deps: FlowDeps): ElimShowScreen {
  const reduced = prefersReducedMotion()
  const mountedAt = typeof performance !== 'undefined' ? performance.now() : 0
  let lastMs = 0
  const stage = deps.stage
  const views: CellView[] = []
  let asset: number | null = null

  if (stage !== undefined && deps.character !== undefined) {
    asset = stage.registerAsset(deps.character.id, deps.character)
    stage.setCamera(0, CAMERA)
  }

  for (let i = 0; i < model.grid.length; i++) {
    const cell = model.grid[i]
    const base = spot(cell.col, cell.row)
    const view: CellView = { seat: cell.seat, instance: null, base, phase: 'stay', startMs: 0 }
    if (asset !== null && stage !== undefined) {
      const instance = stage.createInstance(asset, seatTint(cell.seat))
      stage.setTransform(instance, base, IDENTITY, UNIT)
      view.instance = instance
    }
    if (cell.state === 'gone') {
      view.phase = 'hidden'
      if (view.instance !== null && stage !== undefined) stage.setVisible(view.instance, false)
    } else if (cell.state === 'drop') {
      view.phase = reduced ? 'shrink' : 'throw'
    }
    views.push(view)
  }

  const bySeat = new Map<number, CellView>()
  for (const view of views) if (!bySeat.has(view.seat)) bySeat.set(view.seat, view)

  const hide = (view: CellView): void => {
    if (view.phase === 'hidden') return
    view.phase = 'hidden'
    if (view.instance !== null && stage !== undefined) stage.setVisible(view.instance, false)
  }

  present(host, model)

  return {
    update(next, ms) {
      const now = ms !== undefined && Number.isFinite(ms)
        ? Math.max(0, ms)
        : typeof performance !== 'undefined' ? Math.max(0, performance.now() - mountedAt) : lastMs
      lastMs = Math.max(lastMs, now)
      const skipped = next.grid.some(cell => cell.state === 'gone')
      for (let i = 0; i < views.length && i < next.grid.length; i++) {
        if (next.grid[i].state === 'gone') hide(views[i])
      }
      const drops = skipped ? [] : elimShowAt(next, now).drops

      for (const seat of drops) {
        const view = bySeat.get(seat)
        if (view === undefined || view.phase !== 'stay') continue
        deps.cue('flow.elim-drop')
        view.phase = reduced ? 'shrink' : 'throw'
        view.startMs = now
      }

      for (const view of views) {
        if (view.phase !== 'throw' && view.phase !== 'shrink') continue
        const elapsed = Math.max(0, now - view.startMs)
        if (view.phase === 'shrink') {
          if (elapsed >= SHRINK_MS) {
            hide(view)
            continue
          }
          const s = Math.max(0, 1 - elapsed / SHRINK_MS)
          if (view.instance !== null && stage !== undefined) {
            stage.setTransform(view.instance, view.base, IDENTITY, [s, s, s])
          }
          continue
        }
        if (elapsed >= THROW_MS) {
          hide(view)
          continue
        }
        const u = elapsed / THROW_MS
        const pop = Math.min(1, u / 0.25)
        const fall = Math.max(0, (u - 0.25) / 0.75)
        const y = view.base[1] + POP_M * Math.sin((pop * Math.PI) / 2) - (view.base[1] + POP_M - FALL_BELOW) * fall * fall
        if (view.instance !== null && stage !== undefined) {
          stage.setTransform(view.instance, [view.base[0], y, view.base[2]], yawQuat(u * SPIN_RAD), UNIT)
        }
      }

      present(host, next)
    },
    unmount() {
      for (const view of views) {
        if (view.instance !== null && stage !== undefined) stage.destroyInstance(view.instance)
        view.instance = null
      }
      views.length = 0
      bySeat.clear()
    },
  }
}
