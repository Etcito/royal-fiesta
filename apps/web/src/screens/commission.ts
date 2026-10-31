import { commissionLines, type CommissionModel } from '@royal-fiesta/game/flow/commission'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'
import type { FlowDeps } from './startScreen.ts'

// The few DOM members the view touches, so tests can pass a plain object.
export interface TextFieldElement {
  value: string
  style: { left: string; top: string; width: string; height: string; display: string }
  focus(): void
  blur(): void
  remove(): void
  addEventListener(type: 'input' | 'keydown', listener: (event: KeyLike) => void): void
}

export interface KeyLike {
  key?: string
  stopPropagation?(): void
  preventDefault?(): void
}

export interface TextFieldParent {
  appendChild(child: TextFieldElement): unknown
}

export interface CommissionDeps extends FlowDeps {
  parent: TextFieldParent
  onText(value: string): void
  // ArrowUp/ArrowDown typed inside the field.
  onKey(action: Action): void
  // Defaults to document.createElement('textarea').
  createField?(): TextFieldElement
}

// The caller supplies the commissionStep result together with the input that produced it.
export interface CommissionScreenStep {
  action: Action | { text: string }
  model: CommissionModel
  submit: { slot: string; rarity: string; description: string } | null
}

export interface CommissionView {
  update(model: CommissionModel, step: CommissionScreenStep | null): void
  unmount(): void
}

const HINT = 'Up/Down row · Left/Right change · type the description · Enter submit'
const TEXT_ROW = 2

function createTextarea(): TextFieldElement {
  const el = document.createElement('textarea')
  el.id = 'commission-text'
  el.maxLength = 280
  el.style.position = 'absolute'
  return el as unknown as TextFieldElement
}

function present(host: UaaHost, model: CommissionModel): void {
  const menu: MenuModel = {
    screen: 'commission', title: 'Commission', lines: commissionLines(model), hint: HINT, overlay: false,
    buttons: [{ label: 'Back', cmd: { k: 'back' } }],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = {}
  menu.lines.forEach((text, index) => { props[`line-${index}`] = { text, visible: true } })
  host.setHud(props)
}

// Takes DOM focus only when the row is entered, so Escape can hand the keys back to the game.
export function placeField(field: TextFieldElement, host: UaaHost, model: CommissionModel, entered: boolean): boolean {
  const rect = host.widgetRect(`line-${TEXT_ROW}`)
  const show = model.focus === TEXT_ROW && rect !== null
  if (rect) {
    field.style.left = `${rect.x}px`
    field.style.top = `${rect.y}px`
    field.style.width = `${rect.w}px`
    field.style.height = `${rect.h}px`
  }
  field.style.display = show ? 'block' : 'none'
  if (show) {
    if (field.value !== model.description) field.value = model.description
    if (entered) field.focus()
  }
  return show
}

export function mountCommission(host: UaaHost, model: CommissionModel, deps: CommissionDeps): CommissionView {
  let mounted = true
  const field = (deps.createField ?? createTextarea)()
  field.addEventListener('input', () => deps.onText(field.value))
  field.addEventListener('keydown', (event) => {
    event.stopPropagation?.()
    if (event.key === 'Escape') {
      event.preventDefault?.()
      field.blur()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault?.()
      deps.onKey(event.key === 'ArrowUp' ? 'up' : 'down')
    }
  })
  deps.parent.appendChild(field)
  present(host, model)
  let focus = model.focus
  placeField(field, host, model, true)
  return {
    update(next, step) {
      if (!mounted) return
      const action = step?.action
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') deps.cue('ui.hover')
      else if (step?.submit) deps.cue('ui.ticket')
      else if (action === 'confirm' && step?.model.problem) deps.cue('ui.error')
      present(host, next)
      placeField(field, host, next, next.focus !== focus)
      focus = next.focus
    },
    unmount() {
      if (!mounted) return
      mounted = false
      field.remove()
    },
  }
}
