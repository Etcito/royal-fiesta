import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { levelOf, type ResolvedCourse } from '@royal-fiesta/sim/course'
// The screen-to-uaa mapping against the real ui/screens.ui-doc.json: every produced id exists
// in the doc, and the action round-trip holds.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ACTIONS, Nav, SCREENS, type Action, type Screen } from '@royal-fiesta/game/screens/nav'
import { menuModel, type MenuCtx } from '@royal-fiesta/game/screens/menuModel'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import { SETTINGS_PAGES } from '@royal-fiesta/game/screens/settingsPages'
import { actionToCmd, cmdWidgetId, hudProps, screenProps, widgetsOf, type ScreensDoc } from '../src/ui/screenMap.ts'

const doc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8')) as ScreensDoc

const ctx = (over: Partial<MenuCtx> = {}): MenuCtx => ({ settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [], ...over })

const CTX: Record<Screen, MenuCtx> = {
  hub: ctx(), queue: ctx({ info: ['2 / 4 players'] }), countdown: ctx(), round: ctx(), spectate: ctx(),
  result: ctx({ info: ['1st Bean 1', '2nd Bean 2'] }), podium: ctx({ info: ['Bean 1', 'Bean 2', 'Bean 3'] }),
  pause: ctx(), settings: ctx({ error: 'KeyW is bound to forward' }), credits: ctx(),
  error: ctx({ error: 'Connection lost' }), loading: ctx({ info: ['assets 3/10 course.glb'] }),
  lobbyChoice: ctx({ info: ['A lobby is open: 2/4 players, round in 40 s', 'Ann, Bob', 'Joining it in 8 s'] }),
  lobbyLive: ctx({ info: ['A round is being played: Ann, Bob', 'New lobby in 8 s'] }),
  start: ctx({ info: ['Season 1'] }), vote: ctx({ info: ['Round 2'] }),
  elimShow: ctx({ info: ['Bean 2'] }), endScreen: ctx({ info: ['Champion: Bean 1'] }),
  shop: ctx({ info: ['Coins 120', 'Tickets 3', 'Common: none', 'Rare: none', 'Legendary: none',
    'Epic: none', 'Enter to buy'] }),
  inbox: ctx({ info: ['From: system', 'Candy crown', 'From: Ann', 'Golden ticket', 'Claimed: 2',
    'Enter to claim'] }),
  commission: ctx({ info: ['Tickets: 3', 'Slot: head', 'Rarity: rare', 'Cost: 4 tickets',
    'Describe the item', '10-280 characters', 'Enter to submit'] }),
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
  assert.equal(cmdWidgetId({ k: 'action', action: 'newLobby' }), 'act-new-lobby')
  for (const action of ACTIONS) assert.deepEqual(actionToCmd(cmdWidgetId({ k: 'action', action })), { k: 'action', action })
})

test('settings rows: action row plus the widget id give the row index', () => {
  assert.deepEqual(actionToCmd('row', 'row-3'), { k: 'row', row: 3 })
  assert.throws(() => actionToCmd('row'), /unknown uaa action/)
})

test('settings tabs map to and from their widget ids', () => {
  for (const page of SETTINGS_PAGES) {
    assert.equal(cmdWidgetId({ k: 'tab', page }), `tab-${page}`)
    assert.deepEqual(actionToCmd(`tab-${page}`), { k: 'tab', page })
    assert.deepEqual(actionToCmd(`tab-${page}`, `tab-${page}`), { k: 'tab', page })
  }
  assert.deepEqual(actionToCmd('tab-graphics'), { k: 'tab', page: 'graphics' })
})

test('screenProps on every settings page model finds all its widgets', () => {
  for (const page of SETTINGS_PAGES) {
    const model = menuModel('settings', actionsOf('settings'), ctx({ page }))
    const out = screenProps(doc, model)
    for (const b of model.buttons) {
      assert.deepEqual(out.props[cmdWidgetId(b.cmd)], { text: b.label, visible: true })
    }
  }
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

test('HUD time bar uses the authored level duration beyond 20 seconds', () => {
  const course = { kind: 'race', timeLimitS: 120, checkpoints: [] } as unknown as ResolvedCourse
  course.level = { ...levelOf(course), timeCapTicks: 330 * 60 }
  const duration = roundTicks(course, PROFILES.sprint)
  const state = { tick: 0, phaseTicksLeft: 0, roundKind: 'race', phase: 2, roundIndex: 0, kind: 'race', final: false, courseIndex: 0,
    roundTicksLeft: duration * 0.6, alive: 5, target: 3, qualifiedCount: 1, winner: -1, podium: [] } as const
  assert.equal(hudProps({ ...state, podium: [] }, ['A'], 0, duration)['hud-time-bar'].value, 0.6)
})
