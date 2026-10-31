import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { InboxEntry } from '@royal-fiesta/game/economy/contract'
import {
  inboxButtonsLine,
  inboxLines,
  inboxModel,
  inboxStep,
  type InboxModel,
} from '@royal-fiesta/game/flow/inbox'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { mountInbox } from '../src/screens/inbox.ts'
import { screenProps, widgetsOf, type ScreensDoc, type WidgetProps } from '../src/ui/screenMap.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'

const doc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8')) as ScreensDoc

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'entry-1',
    item: 'costume.crown',
    sender: { kind: 'player', id: 'bean' },
    message: 'Enjoy the crown!',
    date: '2026-10-01T00:00:00.000Z',
    claimed: false,
    ...overrides,
  }
}

const ENTRIES: InboxEntry[] = [
  entry({ id: 'a', item: 'costume.crown', date: '2026-10-01T00:00:00.000Z' }),
  entry({ id: 'b', item: null, message: 'Welcome!', sender: { kind: 'system', id: null },
    date: '2026-10-02T00:00:00.000Z' }),
  entry({ id: 'c', item: 'costume.boots', sender: { kind: 'player', id: 'ann' }, claimed: true,
    date: '2026-10-03T00:00:00.000Z' }),
]

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(entries: InboxEntry[], owned: string[] = ['costume.crown', 'costume.boots']) {
  const model = inboxModel(entries, owned)
  const menus: MenuModel[] = []
  const hud: Record<string, WidgetProps>[] = []
  const calls: string[] = []
  const cues: string[] = []
  const noop = () => {}
  const host: UaaHost = {
    present(menu) { menus.push(menu); calls.push('present') },
    setHud(props) { hud.push(props); calls.push('setHud') },
    setLoading: noop, input: noop, frame: noop, resize: noop, widgetRect: () => null,
    currentScreen: () => 'inbox', destroy: noop,
  }
  const view = mountInbox(host, model, { cue(id) { cues.push(id) } })
  return { model, menus, hud, calls, cues, view }
}

function checkPresentation(s: Setup, model: InboxModel): void {
  const menu = s.menus.at(-1)!
  assert.equal(menu.screen, 'inbox')
  assert.equal(menu.title, 'Inbox')
  assert.equal(menu.overlay, false)
  assert.equal(menu.hint, 'Up/Down entry · Left/Right Claim/Gift/Block · Enter')
  assert.equal(menu.lines.length, 6)
  assert.deepEqual(menu.lines, inboxLines(model))
  assert.deepEqual(menu.buttons, [{ label: 'Back', cmd: { k: 'back' } }])
  const ids = new Set(widgetsOf(doc, 'inbox').map(widget => widget.id))
  const mapped = screenProps(doc, menu)
  for (const id of Object.keys(mapped.props)) assert.ok(ids.has(id), `${id} exists in the inbox UI doc`)
  assert.deepEqual(mapped.props.back, { text: 'Back', visible: true })
  const props = s.hud.at(-1)!
  for (const id of Object.keys(props)) assert.ok(ids.has(id), `${id} exists in the inbox UI doc`)
  assert.deepEqual(props['inbox-buttons'], { text: inboxButtonsLine(model), visible: true })
  menu.lines.forEach((text, index) => {
    assert.deepEqual(props[`line-${index}`], { text, visible: true })
    assert.deepEqual(mapped.props[`line-${index}`], { text, visible: true })
  })
}

test('inbox presents inboxLines and the inbox-buttons strip for every button', async () => {
  const s = await setup(ENTRIES)
  checkPresentation(s, s.model)
  assert.equal(s.hud.at(-1)!['inbox-buttons'].text, '[Claim]  Gift  Block')
  const expected = ['[Claim]  Gift  Block', 'Claim  [Gift]  Block', 'Claim  Gift  [Block]']
  for (const [index, button] of (['claim', 'gift', 'block'] as const).entries()) {
    const model: InboxModel = { ...s.model, button }
    s.view.update(model, null)
    checkPresentation(s, model)
    assert.equal(inboxButtonsLine(model), expected[index])
    assert.equal(s.hud.at(-1)!['inbox-buttons'].text, expected[index])
  }
  assert.deepEqual(s.calls, ['present', 'setHud', 'present', 'setHud', 'present', 'setHud', 'present', 'setHud'])
  assert.deepEqual(s.cues, ['ui.inbox'])
  s.view.unmount()
})

test('an empty inbox presents the empty status and cues no inbox ping', async () => {
  const s = await setup([])
  checkPresentation(s, s.model)
  assert.deepEqual(s.menus.at(-1)!.lines, ['', '', '', '', '', 'Inbox is empty'])
  assert.deepEqual(s.cues, [])
  s.view.unmount()
})

test('inbox cues the inbox ping, movement, claim, gift, block and refusal; unmount stops updates', async () => {
  const s = await setup([
    entry({ id: 'gift-1', item: 'costume.crown', sender: { kind: 'player', id: 'bean' } }),
  ])
  assert.deepEqual(s.cues, ['ui.inbox'])
  let model = s.model
  function act(action: Action): void {
    const step = inboxStep(model, action)
    model = step.model
    s.view.update(model, { ...step, action })
  }

  act('down')
  act('up')
  act('left')
  act('right')
  assert.equal(model.button, 'claim')
  assert.deepEqual(s.cues.slice(1), ['ui.hover', 'ui.hover', 'ui.hover', 'ui.hover'])

  act('confirm')
  assert.equal(model.pending, true)
  model = { ...model, pending: false, rows: model.rows.map(row => ({ ...row, claimed: true })) }
  s.view.update(model, null)
  act('confirm')
  assert.equal(model.error, 'Nothing to claim')
  assert.equal(s.menus.at(-1)!.lines[5], 'Nothing to claim')
  assert.deepEqual(s.cues.slice(5), ['ui.click', 'ui.error'])

  act('right')
  assert.equal(model.button, 'gift')
  act('confirm')
  assert.equal(model.picking, true)
  assert.equal(s.menus.at(-1)!.lines[5], 'Gift: costume.crown')
  act('down')
  act('confirm')
  assert.equal(model.picking, false)
  assert.equal(model.pending, true)
  assert.deepEqual(s.cues.slice(7), ['ui.hover', 'ui.click', 'ui.hover', 'ui.click'])

  model = { ...model, pending: false }
  act('right')
  assert.equal(model.button, 'block')
  act('confirm')
  assert.equal(model.pending, true)
  assert.deepEqual(s.cues.slice(-2), ['ui.hover', 'ui.click'])

  const calls = s.calls.length, cues = s.cues.length
  s.view.unmount()
  s.view.unmount()
  act('down')
  assert.equal(s.calls.length, calls)
  assert.equal(s.cues.length, cues)
})
