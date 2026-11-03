import { shopLines, type ShopModel, type ShopStep } from '@royal-fiesta/game/flow/shop'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { thumbnailUrl } from '../ui/cosmeticThumbnails.ts'
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

const HINT = 'Up/Down Grid / Tabs   Left/Right Browse   A / Enter Select   Esc Back'

function focused(label: string, focus: boolean): string {
  return focus ? `> ${label} <` : label
}

function present(host: UaaHost, model: ShopModel): void {
  const buttonRow = model.zone === 'buttons' || model.focus[0] === model.slots.length
  const menu: MenuModel = {
    screen: 'shop', title: 'The Fiesta Shop', lines: shopLines(model), hint: HINT, overlay: false,
    buttons: [
      { label: focused('Inbox', buttonRow && model.focus[1] === 0), cmd: { k: 'action', action: 'inbox' } },
      { label: focused('Commission', buttonRow && model.focus[1] === 1), cmd: { k: 'action', action: 'commission' } },
      { label: 'Back', cmd: { k: 'back' } },
    ],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = { wallet: { visible: true }, hint: { visible: false }, 'wallet-coins': { text: String(model.coins) }, 'wallet-tickets': { text: String(model.tickets) } }
  menu.lines.forEach((text, index) => { props[`line-${index}`] = { text, visible: index === 6 } })
  const selected = model.slots[model.focus[0]]?.items[model.focus[1]]
  props['line-6'] = { text: model.error ?? (model.pending ? 'Buying…' : selected
    ? `${selected.owned ? 'In your wardrobe' : selected.remaining <= 0 ? 'Locked · Sold out' : 'Find your next party look'}` : ''), visible: true }
  for (let row = 0; row < 4; row++) {
    props[`catalog-slot-${row}`] = { text: ['Hat', 'Outfit', 'Extra', 'Special'][row], visible: true }
    props[`tab-focus-${row}`] = { visible: model.focus[0] === row }
  }
  {
    const row = model.focus[0]
    const slot = model.slots[row]
    // A moving nine-card window also supports future, larger catalogs.
    const offset = model.focus[0] === row ? Math.floor(model.focus[1] / 9) * 9 : 0
    for (let column = 0; column < 9; column++) {
      const item = slot?.items[offset + column]
      const shown = !!item && model.focus[0] === row && !model.confirm
      props[`catalog-card-0-${column}`] = { visible: shown }
      props[`catalog-focus-0-${column}`] = { visible: shown && model.zone !== 'tabs' && model.zone !== 'buttons' && model.focus[1] === offset + column }
      props[`thumb-shop-0-${column}`] = { thumbnail: item?.id ?? '', visible: shown && !!thumbnailUrl(item!.id) }
      props[`catalog-item-0-${column}`] = { text: item?.name.replace('Golden Crown', 'Crown').replace(/ (Hat|Suit|Jacket|Scarf|Sneakers|Skirt|Wand|Aura)(?= (Rose|Teal)$)/, '').replace(/ (Rose|Teal)$/, ' · $1') ?? '', visible: shown }
      props[`catalog-price-0-${column}`] = { text: item ? item.owned ? 'OWNED' : item.remaining <= 0 ? 'LOCKED' : [item.price.coins === undefined ? '' : `${item.price.coins} coins`, item.price.tickets === undefined ? '' : `${item.price.tickets} tickets`].filter(Boolean).join(' / ') : '', visible: shown }
      props[`catalog-rarity-0-${column}`] = { text: item?.rarity.toUpperCase() ?? '', visible: shown }
    }
  }
  props['purchase-confirm'] = { visible: !!model.confirm }
  const purchase = model.slots.flatMap(s => s.items).find(i => i.id === model.confirm?.itemId)
  props['purchase-item'] = { text: purchase ? `${purchase.name} · ${purchase.price[model.confirm!.currency]} ${model.confirm!.currency}` : '' }
  props['purchase-buy'] = { text: 'BUY' }
  props['purchase-cancel'] = { text: 'Cancel' }
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
