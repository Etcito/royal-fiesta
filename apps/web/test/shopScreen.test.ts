import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { loadUiDoc } from '@etcito/uaa'
import { createEconomyStub } from '@royal-fiesta/game/economy/stub'
import { shopLines, shopModel, shopStep, type ShopModel } from '@royal-fiesta/game/flow/shop'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { loadAssets } from '../src/ui/uaaHost.ts'
import { mountShop } from '../src/screens/shop.ts'
import { screenProps, widgetsOf, type ScreensDoc, type WidgetProps } from '../src/ui/screenMap.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'

const doc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8')) as ScreensDoc

test('catalog UI document passes the runtime schema', () => {
  assert.doesNotThrow(() => loadUiDoc(doc, loadAssets(Object.fromEntries(readdirSync(new URL('../../../ui', import.meta.url)).filter(f => f.endsWith('.ui.json')).map(f => [f, readFileSync(new URL('../../../ui/' + f, import.meta.url), 'utf8')])))))
})

async function setup() {
  const economy = createEconomyStub({ me: { coins: 1000, tickets: 10, owned: [] } })
  const model = shopModel((await economy.catalog()).items, await economy.me())
  const menus: MenuModel[] = []
  const hud: Record<string, WidgetProps>[] = []
  const calls: string[] = []
  const cues: string[] = []
  const noop = () => {}
  const host: UaaHost = {
    present(menu) { menus.push(menu); calls.push('present') },
    setHud(props) { hud.push(props); calls.push('setHud') },
    setLoading: noop, input: noop, frame: noop, resize: noop, widgetRect: () => null,
    currentScreen: () => 'shop', destroy: noop,
  }
  const view = mountShop(host, model, { cue(id) { cues.push(id) } })
  return { model, menus, hud, calls, cues, view }
}

test('shop presents shopLines and maps all three buttons to the real UI doc', async () => {
  const s = await setup()
  function check(model: ShopModel, labels: string[]): void {
    const menu = s.menus.at(-1)!
    assert.equal(menu.screen, 'shop')
    assert.equal(menu.title, 'The Fiesta Shop')
    assert.equal(menu.overlay, false)
    assert.equal(menu.hint, 'Up/Down Grid / Tabs   Left/Right Browse   A / Enter Select   Esc Back')
    assert.equal(menu.lines.length, 7)
    assert.deepEqual(menu.lines, shopLines(model))
    assert.deepEqual(menu.buttons, [
      { label: labels[0], cmd: { k: 'action', action: 'inbox' } },
      { label: labels[1], cmd: { k: 'action', action: 'commission' } },
      { label: 'Back', cmd: { k: 'back' } },
    ])
    const mapped = screenProps(doc, menu)
    const ids = new Set(widgetsOf(doc, 'shop').map(widget => widget.id))
    for (const [index, id] of ['act-inbox', 'act-commission', 'back'].entries()) {
      assert.ok(ids.has(id), `${id} exists in the shop UI doc`)
      assert.deepEqual(mapped.props[id], { text: labels[index], visible: true })
    }
    menu.lines.forEach((text, index) => {
      assert.deepEqual(mapped.props[`line-${index}`], { text, visible: true })
      if (index !== 6) assert.deepEqual(s.hud.at(-1)![`line-${index}`], { text, visible: index === 0 })
    })
    const hud = s.hud.at(-1)!
    const visible = Object.entries(hud).filter(([id, props]) => id.startsWith('catalog-item-') && props.visible)
    assert.equal(visible.length, (model.slots[model.focus[0]]?.items.length ?? 0))
    for (const [id] of visible) assert.ok(ids.has(id), `${id} is rendered by the UI doc`)
    assert.equal(hud['line-6'].visible, true)
  }
  check(s.model, ['Inbox', 'Commission', 'Back'])
  for (const column of [0, 1]) {
    const model: ShopModel = { ...s.model, focus: [s.model.slots.length, column] }
    s.view.update(model, null)
    check(model, column === 0 ? ['> Inbox <', 'Commission', 'Back'] : ['Inbox', '> Commission <', 'Back'])
  }
  assert.deepEqual(s.calls, ['present', 'setHud', 'present', 'setHud', 'present', 'setHud'])
  assert.deepEqual(s.cues, [])
  s.view.unmount()
})

test('shop cues move, buy, refusal and open; unmount stops updates', async () => {
  const s = await setup()
  let model = s.model
  function act(action: Action): void {
    const step = shopStep(model, action)
    model = step.model
    s.view.update(model, { ...step, action })
  }
  assert.deepEqual(s.cues, [])
  act('down')
  act('confirm')
  assert.ok(model.confirm)
  act('confirm')
  assert.equal(model.pending, true)
  assert.equal(s.menus.at(-1)!.lines[6], 'Buying…')
  // A wallet refresh ends the pending purchase; the next purchase is refused.
  model = { ...model, pending: false, coins: 0, tickets: 0 }
  s.view.update(model, null)
  act('confirm')
  assert.equal(model.error, 'Not enough coins or tickets')
  assert.equal(s.menus.at(-1)!.lines[6], model.error)
  assert.deepEqual(s.cues, ['ui.hover', 'ui.buy', 'ui.error'])

  for (const action of ['up', 'left', 'right'] as const) act(action)
  assert.deepEqual(s.cues.slice(3), ['ui.hover', 'ui.hover', 'ui.hover'])
  for (const column of [0, 1]) {
    model = { ...model, focus: [model.slots.length, column], zone: 'buttons', error: null }
    act('confirm')
  }
  assert.deepEqual(s.cues.slice(-2), ['ui.click', 'ui.click'])
  const calls = s.calls.length, cues = s.cues.length
  s.view.unmount()
  s.view.unmount()
  act('down')
  assert.equal(s.calls.length, calls)
  assert.equal(s.cues.length, cues)
})
