// The round results screen: the existing 'result' panel filled with the top rows, points and totals.
import { resultRows, type ResultRow } from '@royal-fiesta/game/flow/roundResults'
import type { ZoneRoundResult } from '@royal-fiesta/game/net/zoneRounds'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { UaaHost } from '../ui/uaaHost.ts'

export interface FlowDeps {
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
}

export interface RoundResultsRowsModel {
  round: number
  rows: readonly ResultRow[]
}

export interface RoundResultsResultModel {
  result: ZoneRoundResult
  earlier?: readonly ZoneRoundResult[]
  round?: number
}

export type RoundResultsModel = readonly ResultRow[] | RoundResultsRowsModel | RoundResultsResultModel

export interface RoundResultsScreen {
  update(model: RoundResultsModel, ms?: number): void
  unmount(): void
}

const TOP = 7

function rowLine(row: ResultRow): string {
  const mark = row.qualified ? 'In' : 'Out'
  return `${row.rank}. ${row.name}  +${row.points}  (${row.total})  ${mark}`
}

function rowsOf(model: RoundResultsModel, deps: FlowDeps): readonly ResultRow[] {
  if (!('rows' in model) && !('result' in model)) return model
  if ('rows' in model) return model.rows
  const names = deps.names ?? ((seat: number) => `Bean ${seat + 1}`)
  return resultRows(model.result, names, model.earlier)
}

function roundOf(model: RoundResultsModel): number {
  if (!('rows' in model) && !('result' in model)) return 1
  if ('round' in model && model.round !== undefined) return model.round
  if ('result' in model) return model.result.index + 1
  return 1
}

function outcomeOf(model: RoundResultsModel, rows: readonly ResultRow[], seat: number): 'qualify' | 'eliminate' | null {
  const row = rows.find(r => r.seat === seat)
  if (row !== undefined) return row.qualified ? 'qualify' : 'eliminate'
  if ('result' in model) {
    if (model.result.qualified.includes(seat)) return 'qualify'
    if (model.result.eliminated.includes(seat)) return 'eliminate'
  }
  return null
}

export function roundResultsLines(model: RoundResultsModel, deps: FlowDeps): string[] {
  const rows = rowsOf(model, deps)
  const top = rows.slice(0, TOP)
  const lines = top.map(rowLine)
  const seat = deps.localSeat
  if (seat !== undefined && !top.some(row => row.seat === seat)) {
    const you = rows.find(row => row.seat === seat)
    if (you !== undefined) lines.push(`You: ${rowLine(you)}`)
  }
  return lines
}

function present(host: UaaHost, model: RoundResultsModel, deps: FlowDeps): void {
  const menu: MenuModel = {
    screen: 'result',
    title: `Round ${roundOf(model)} results`,
    lines: roundResultsLines(model, deps),
    buttons: [{ label: 'Back', cmd: { k: 'back' } }],
    hint: 'Enter continue',
    overlay: false,
  }
  host.present(menu)
}

export function mountRoundResults(host: UaaHost, model: RoundResultsModel, deps: FlowDeps): RoundResultsScreen {
  if (deps.localSeat !== undefined) {
    const outcome = outcomeOf(model, rowsOf(model, deps), deps.localSeat)
    if (outcome !== null) deps.cue(outcome === 'qualify' ? 'flow.qualify' : 'flow.eliminate')
  }
  present(host, model, deps)

  return {
    update(next, _ms) {
      present(host, next, deps)
    },
    unmount() {},
  }
}
