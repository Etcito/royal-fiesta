// The screen-to-uaa mapping against the real ui/screens.ui-doc.json: every produced id exists
// in the doc, and the action round-trip holds.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ACTIONS, Nav, SCREENS, type Action, type Screen } from '@royal-fiesta/game/screens/nav'
import { menuModel, type MenuCtx } from '@royal-fiesta/game/screens/menuModel'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import { actionToCmd, cmdWidgetId, hudProps, screenProps, widgetsOf, type ScreensDoc } from '../src/ui/screenMap.ts'

const doc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8')) as ScreensDoc

const ctx = (over: Partial<MenuCtx> = {}): MenuCtx => ({ settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [], ...over })

const CTX: Record<Screen, MenuCtx> = {
  title: ctx(), hub: ctx(), queue: ctx({ info: ['2 / 4 players'] }), countdown: ctx(), round: ctx(), spectate: ctx(),
  result: ctx({ info: ['1st Bean 1', '2nd Bean 2'] }), podium: ctx({ info: ['Bean 1', 'Bean 2', 'Bean 3'] }),
  pause: ctx(), settings: ctx({ error: 'KeyW is bound to forward' }), credits: ctx(),
  error: ctx({ error: 'Connection lost' }), loading: ctx({ info: ['assets 3/10 course.glb'] }),
}

function actionsOf(screen: Screen): readonly Action[] {
  const nav = new Nav()
  nav.screen = screen
  return nav.actions()
}

for (const screen of SCREENS) {
  test(`screenProps(${screen}): the screen and every widget id exist in the ui doc`, () => {
    const model = menuModel(screen, actionsOf(screen), CTX[screen])
    const out = screenProps(doc, model)
    assert.equal(out.screen, screen)
    const ids = new Set(widgetsOf(doc, screen).map((w) => w.id))
    for (const id of Object.keys(out.props)) assert.ok(ids.has(id), `${screen}: ${id} is not in the doc`)
    for (const b of model.buttons) assert.deepEqual(out.props[cmdWidgetId(b.cmd)], { text: b.label, visible: true })
  })
  test(`action round-trip (${screen})`, () => {
    const model = menuModel(screen, actionsOf(screen), CTX[screen])
    const widgets = widgetsOf(doc, screen)
    for (const b of model.buttons) {
      const id = cmdWidgetId(b.cmd)
      assert.deepEqual(actionToCmd(id), b.cmd)
      const w = widgets.find((x) => x.id === id)
      assert.ok(w?.action !== undefined, `${screen}: ${id} has no action`)
      assert.deepEqual(actionToCmd(w.action, w.id), b.cmd)
    }
  })
}

test('every nav action maps to act-<kebab> and back', () => {
  assert.equal(cmdWidgetId({ k: 'action', action: 'playOnline' }), 'act-play-online')
  for (const action of ACTIONS) assert.deepEqual(actionToCmd(cmdWidgetId({ k: 'action', action })), { k: 'action', action })
})

test('settings rows: action row plus the widget id give the row index', () => {
  assert.deepEqual(actionToCmd('row', 'row-3'), { k: 'row', row: 3 })
  assert.throws(() => actionToCmd('row'), /unknown uaa action/)
})

test('unknown action strings are refused', () => {
  for (const s of ['', 'act-nope', 'row-x', 'act.play', 'Back']) assert.throws(() => actionToCmd(s), /unknown uaa action/)
})

test('lines beyond the doc slots are refused', () => {
  const model = menuModel('credits', [], CTX.credits)
  const many = { ...model, lines: Array.from({ length: 40 }, (_, i) => `line ${i}`) }
  assert.throws(() => screenProps(doc, many), /line slots/)
})

test('hudProps: round kind, timer, time bar, qualified, alive', () => {
  const state = { tick: 0, phase: 1, phaseTicksLeft: 0, roundIndex: 0, roundKind: 'race' as const, final: false, courseIndex: 0,
    roundTicksLeft: 1800, alive: 5, target: 3, qualifiedCount: 1, winner: -1, podium: [] }
  const p = hudProps(state, ['A'], 0, 3600)
  assert.equal(p['hud-time-bar'].value, 0.5)
  assert.equal(p['hud-alive'].text, 'Alive 5')
  assert.match(String(p['hud-qualified'].text), /^Qualified 1 \/ 3$/)
})
