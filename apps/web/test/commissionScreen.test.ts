import assert from 'node:assert/strict'
import test from 'node:test'
import { commissionLines, commissionModel, commissionStep, type CommissionModel } from '@royal-fiesta/game/flow/commission'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { mountCommission, type KeyLike, type TextFieldElement } from '../src/screens/commission.ts'
import type { WidgetProps } from '../src/ui/screenMap.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'

function fakeField() {
  const listeners: Record<string, (e: KeyLike) => void> = {}
  const log: string[] = []
  const field: TextFieldElement = {
    value: '',
    style: { left: '', top: '', width: '', height: '', display: '' },
    focus() { log.push('focus') },
    blur() { log.push('blur') },
    remove() { log.push('remove') },
    addEventListener(type, fn) { listeners[type] = fn },
  }
  return { field, listeners, log }
}

function setup(tickets = 10) {
  const menus: MenuModel[] = []
  const hud: Record<string, WidgetProps>[] = []
  const cues: string[] = []
  const texts: string[] = []
  const keys: Action[] = []
  const appended: unknown[] = []
  const noop = () => {}
  const host: UaaHost = {
    present(menu) { menus.push(menu) }, setHud(props) { hud.push(props) },
    setLoading: noop, input: noop, frame: noop, resize: noop,
    widgetRect: (id) => (id === 'line-2' ? { x: 10, y: 20, w: 300, h: 24 } : null),
    currentScreen: () => 'commission', focused: () => null, widget: () => null, destroy: noop,
  }
  const f = fakeField()
  let model = commissionModel(tickets)
  const view = mountCommission(host, model, {
    cue(id) { cues.push(id) }, parent: { appendChild(c) { appended.push(c) } },
    onText(v) { texts.push(v) }, onKey(a) { keys.push(a) }, createField: () => f.field,
  })
  function act(action: Action | { text: string }): void {
    const step = commissionStep(model, action)
    model = step.model
    view.update(model, { ...step, action })
  }
  return { menus, hud, cues, texts, keys, appended, f, view, act, get model(): CommissionModel { return model } }
}

test('presents the commission lines, Back button and hint', () => {
  const s = setup()
  const menu = s.menus.at(-1)!
  assert.equal(menu.screen, 'commission')
  assert.equal(menu.title, 'Commission')
  assert.deepEqual(menu.lines, commissionLines(s.model))
  assert.deepEqual(menu.buttons.map(b => b.label), ['Back'])
  assert.equal(menu.hint, 'Up/Down row · Left/Right change · type the description · Enter submit')
  assert.equal(s.hud.at(-1)!['line-6'].text, menu.lines[6])
  assert.equal(s.appended[0], s.f.field)
})

test('the textarea is shown only on row 2, placed over line-2 and focused', () => {
  const s = setup()
  assert.equal(s.f.field.style.display, 'none')
  s.act('down'); s.act('down')
  assert.equal(s.f.field.style.display, 'block')
  assert.equal(s.f.field.style.left, '10px')
  assert.equal(s.f.field.style.width, '300px')
  assert.equal(s.f.log.at(-1), 'focus')
  s.act('down')
  assert.equal(s.f.field.style.display, 'none')
  s.view.unmount()
  assert.equal(s.f.log.at(-1), 'remove')
})

test('input forwards text; keydown stops propagation; Escape blurs; arrows forwarded', () => {
  const s = setup()
  s.f.field.value = 'a tall hat'
  s.f.listeners.input({})
  assert.deepEqual(s.texts, ['a tall hat'])
  let stopped = 0
  const key = (k: string) => s.f.listeners.keydown({ key: k, stopPropagation() { stopped++ } })
  key('x'); key('Escape'); key('ArrowUp'); key('ArrowDown')
  assert.equal(stopped, 4)
  assert.ok(s.f.log.includes('blur'))
  assert.deepEqual(s.keys, ['up', 'down'])
})

test('cues: hover on moves, error on a refused submit, ticket on submit', () => {
  const s = setup()
  s.act('down'); s.act('down'); s.act('down')
  s.act('confirm')
  assert.deepEqual(s.cues, ['ui.hover', 'ui.hover', 'ui.hover', 'ui.error'])
  s.act({ text: 'a striped candy cane hat' })
  s.act('confirm')
  assert.equal(s.cues.at(-1), 'ui.ticket')
  assert.equal(s.cues.length, 5)
})
