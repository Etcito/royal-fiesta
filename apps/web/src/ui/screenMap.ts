// Pure mapping from a menuModel result to the uaa screen and widget props, and from a uaa
// action string back to the menu command. No DOM, no GPU. Widget ids follow decision Q5:
// lowercase kebab-case (title, hint, line-<i>, row-<i>, act-<kebab action>, back, hud-<name>);
// the button `action` strings stay the nav.ts/menuModel names. Slot ids come from the doc.
import { ACTIONS, type Action, type Screen } from '@royal-fiesta/game/screens/nav'
import type { MenuCmd, MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { hudLines } from '../client/hud.ts'

// The part of a uaa.ui-doc v1 document this module reads (structurally compatible with uaa's UiDoc).
export interface DocWidget {
  id: string
  type: string
  action?: string
  children?: DocWidget[]
}
export interface DocScreen {
  id: string
  widgets: DocWidget[]
}
export interface ScreensDoc {
  screens: DocScreen[]
}

// Same shape as uaa's WidgetProps.
export interface WidgetProps {
  text?: string | Record<string, string>
  value?: number
  disabled?: boolean
  visible?: boolean
}

export interface UaaScreen {
  screen: Screen
  props: Record<string, WidgetProps>
}

export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

export function actionWidgetId(action: Action): string {
  return `act-${kebab(action)}`
}

// The uaa widget id of a menu button.
export function cmdWidgetId(cmd: MenuCmd): string {
  if (cmd.k === 'action') return actionWidgetId(cmd.action)
  if (cmd.k === 'row') return `row-${cmd.row}`
  return 'back'
}

function flatten(widgets: readonly DocWidget[], out: DocWidget[] = []): DocWidget[] {
  for (const w of widgets) {
    out.push(w)
    if (w.children) flatten(w.children, out)
  }
  return out
}

export function docScreen(doc: ScreensDoc, screen: string): DocScreen {
  const s = doc.screens.find((x) => x.id === screen)
  if (s === undefined) throw new Error(`screenMap: ui doc has no screen '${screen}'`)
  return s
}

export function widgetsOf(doc: ScreensDoc, screen: string): DocWidget[] {
  return flatten(docScreen(doc, screen).widgets)
}

const LINE_RE = /^line-(\d+)$/

export function screenProps(doc: ScreensDoc, model: MenuModel): UaaScreen {
  const widgets = widgetsOf(doc, model.screen)
  const ids = new Set(widgets.map((w) => w.id))
  const props: Record<string, WidgetProps> = {}
  if (ids.has('title')) props.title = { text: model.title }
  if (ids.has('hint')) props.hint = { text: model.hint }
  const lineSlots = widgets.filter((w) => LINE_RE.test(w.id)).length
  if (model.lines.length > lineSlots) {
    throw new Error(`screenMap: screen '${model.screen}' has ${model.lines.length} lines but the ui doc has ${lineSlots} line slots`)
  }
  for (const w of widgets) {
    const m = LINE_RE.exec(w.id)
    if (m === null) continue
    const i = Number(m[1])
    props[w.id] = i < model.lines.length ? { text: model.lines[i], visible: true } : { visible: false }
  }
  const shown = new Set<string>()
  for (const b of model.buttons) {
    const id = cmdWidgetId(b.cmd)
    if (!ids.has(id)) throw new Error(`screenMap: screen '${model.screen}' has no widget '${id}' for button '${b.label}'`)
    props[id] = { text: b.label, visible: true }
    shown.add(id)
  }
  for (const w of widgets) {
    if (w.type === 'button' && !shown.has(w.id)) props[w.id] = { visible: false }
  }
  return { screen: model.screen, props }
}

// The menu command of a uaa action string: the button action (nav.ts name) or its widget id.
// Settings rows all share the action 'row'; the row index comes from the widget id row-<i>.
export function actionToCmd(action: string, widgetId?: string): MenuCmd {
  if (action === 'back') return { k: 'back' }
  const row = /^row-(\d+)$/.exec(action === 'row' && widgetId !== undefined ? widgetId : action)
  if (row !== null) return { k: 'row', row: Number(row[1]) }
  for (const a of ACTIONS) {
    if (action === a || action === actionWidgetId(a)) return { k: 'action', action: a }
  }
  throw new Error(`screenMap: unknown uaa action '${action}'`)
}

// The round HUD props. roundTicks is the round's full length, for the time bar (0..1 left).
export function hudProps(state: MatchViewState, names: string[], local: number, roundTicks: number): Record<string, WidgetProps> {
  const lines = hudLines(state, names, local)
  // hudLines has a timer and a qualified line only off the podium: kind, timer, qualified, ..., you.
  const podium = lines.length < 3 || !lines[2].startsWith('Qualified')
  const value = roundTicks > 0 ? Math.min(1, Math.max(0, state.roundTicksLeft / roundTicks)) : 0
  return {
    'hud-kind': { text: lines[0], visible: true },
    'hud-timer': podium ? { visible: false } : { text: lines[1], visible: true },
    'hud-time-bar': podium ? { visible: false } : { value, visible: true },
    'hud-qualified': podium ? { visible: false } : { text: lines[2], visible: true },
    'hud-alive': podium ? { visible: false } : { text: `Alive ${state.alive}`, visible: true },
  }
}
