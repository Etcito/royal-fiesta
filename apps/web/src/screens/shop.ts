import { shopLines, type ShopModel, type ShopStep } from '@royal-fiesta/game/flow/shop'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'
import type { FlowDeps } from './startScreen.ts'

// The caller supplies the shopStep result together with the input that produced it.
export interface ShopScreenStep extends ShopStep {
  action: Action
}

export interface ShopView {
  update(model: ShopModel, step: ShopScreenStep | null): void
  unmount(): void
}

const HINT = 'Up/Down slot · Left/Right item · Enter buy · Esc back'

function focused(label: string, focus: boolean): string {
  return focus ? `> ${label} <` : label
}

function present(host: UaaHost, model: ShopModel): void {
  const buttonRow = model.focus[0] === model.slots.length
  const menu: MenuModel = {
    screen: 'shop', title: 'Shop', lines: shopLines(model), hint: HINT, overlay: false,
    buttons: [
      { label: focused('Inbox', buttonRow && model.focus[1] === 0), cmd: { k: 'action', action: 'inbox' } },
      { label: focused('Commission', buttonRow && model.focus[1] === 1), cmd: { k: 'action', action: 'commission' } },
      { label: 'Back', cmd: { k: 'back' } },
    ],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = {}
  menu.lines.forEach((text, index) => { props[`line-${index}`] = { text, visible: index === 0 || index === 6 } })
  const selected = model.slots[model.focus[0]]?.items[model.focus[1]]
  props['line-6'] = { text: model.error ?? (model.pending ? 'Buying…' : selected
    ? `${selected.name} · ${selected.price.coins ?? '—'} coins · ${selected.owned ? 'OWNED' : 'Enter or click to buy'}` : ''), visible: true }
  for (let row = 0; row < 4; row++) {
    const slot = model.slots[row]
    props[`catalog-slot-${row}`] = { text: slot ? `${slot.slot.toUpperCase()} · ${slot.items.length} items` : '', visible: !!slot }
    for (let column = 0; column < 9; column++) {
      const item = slot?.items[column]
      const focused = model.focus[0] === row && model.focus[1] === column
      props[`catalog-item-${row}-${column}`] = {
        text: item ? `${focused ? '> ' : ''}${item.name}${item.owned ? ' [OWNED]' : ''}` : '',
        visible: !!item,
      }
    }
  }
  host.setHud(props)
}

export function mountShop(host: UaaHost, model: ShopModel, deps: FlowDeps): ShopView {
  let mounted = true
  present(host, model)
  return {
    update(next, step) {
      if (!mounted) return
      if (step?.action === 'up' || step?.action === 'down' || step?.action === 'left' || step?.action === 'right') {
        deps.cue('ui.hover')
      } else if (step?.buy) deps.cue('ui.buy')
      else if (step?.model.error) deps.cue('ui.error')
      else if (step?.open) deps.cue('ui.click')
      present(host, next)
    },
    unmount() {
      mounted = false
    },
  }
}
