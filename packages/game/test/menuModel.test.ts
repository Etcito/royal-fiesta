import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Nav } from '../src/screens/nav.ts'
import type { NavEvent } from '../src/screens/nav.ts'
import { CREDITS, HINTS, controlLines, hitTest, layoutButtons, menuModel, moveFocus, progressLine } from '../src/screens/menuModel.ts'
import type { MenuCtx } from '../src/screens/menuModel.ts'
import { DEFAULT_SETTINGS, SETTINGS_ROWS, rebind } from '../src/screens/settings.ts'

function ctx(over: Partial<MenuCtx> = {}): MenuCtx {
  return { settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [], ...over }
}

function modelAt(c: MenuCtx, ...events: NavEvent[]) {
  const nav = new Nav()
  for (const ev of events) nav.dispatch(ev)
  return menuModel(nav.screen, nav.actions(), c)
}

test('title has 4 buttons in nav order', () => {
  const m = modelAt(ctx())
  assert.equal(m.overlay, false)
  assert.deepEqual(m.buttons.map((b) => b.label), ['Play', 'Play online', 'Settings', 'Credits'])
  assert.deepEqual(m.buttons.map((b) => b.cmd), new Nav().actions().map((action) => ({ k: 'action', action })))
})

test('settings has one button per row plus Back, and shows a rebind refusal', () => {
  let message = ''
  try {
    rebind(DEFAULT_SETTINGS, 'jump', 'KeyW')
  } catch (e) {
    message = (e as Error).message
  }
  assert.match(message, /forward/)
  const m = modelAt(ctx({ rebinding: 'jump', error: message }), { kind: 'action', action: 'settings' })
  assert.equal(m.screen, 'settings')
  assert.equal(m.buttons.length, SETTINGS_ROWS.length + 1)
  assert.deepEqual(m.buttons[0].cmd, { k: 'row', row: 0 })
  assert.equal(m.buttons[0].label, 'Volume 80%')
  assert.deepEqual(m.buttons.at(-1)!.cmd, { k: 'back' })
  assert.ok(m.lines.includes('Press a key for jump - Esc cancels'))
  assert.ok(m.lines.includes(message))
})

test('the error model shows the message', () => {
  const m = modelAt(ctx({ error: 'relay unreachable' }), { kind: 'error', message: 'relay unreachable' })
  assert.equal(m.title, 'Disconnected / error')
  assert.equal(m.lines[0], 'relay unreachable')
  assert.deepEqual(m.buttons.map((b) => b.label), ['Retry', 'Back to title', 'Back'])
})

test('credits, HUD and hub models', () => {
  const credits = modelAt(ctx(), { kind: 'action', action: 'credits' })
  assert.equal(credits.title, 'Credits')
  assert.deepEqual(credits.lines, [...CREDITS])
  const hub = modelAt(ctx({ info: ['3 players'] }), { kind: 'action', action: 'play' })
  assert.equal(hub.overlay, true)
  assert.equal(hub.buttons.length, 0)
  assert.match(hub.hint, /WASD/)
  const round = menuModel('round', [], ctx())
  assert.equal(round.hint, 'Esc pause')
})

test('layoutButtons gives non-overlapping rects in frame, hitTest finds each', () => {
  const m = modelAt(ctx({ error: 'x' }), { kind: 'action', action: 'settings' })
  const rects = layoutButtons(m, 1920, 1080)
  assert.equal(rects.length, m.buttons.length)
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080, `rect ${i} in frame`)
    assert.equal(r.w, 520)
    assert.ok(r.h > 0 && r.h <= 64)
    for (let j = i + 1; j < rects.length; j++) {
      const o = rects[j]
      const overlap: boolean = r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h
      assert.equal(overlap, false, `rects ${i} and ${j} overlap`)
    }
    assert.equal(hitTest(rects, r.x + r.w / 2, r.y + r.h / 2), i)
  }
  assert.equal(hitTest(rects, 0, 0), -1)
  const half = layoutButtons(m, 960, 540)
  assert.equal(half[0].w, 260)
  assert.equal(half[0].h, rects[0].h / 2)
  assert.equal(layoutButtons(modelAt(ctx()), 1920, 1080)[0].h, 64)
})

test('moveFocus wraps both ways', () => {
  assert.equal(moveFocus(0, -1, 4), 3)
  assert.equal(moveFocus(3, 1, 4), 0)
  assert.equal(moveFocus(1, 1, 4), 2)
  assert.equal(moveFocus(0, 1, 0), -1)
})


test('pause lists all controls with current key bindings', () => {
  assert.deepEqual(controlLines(DEFAULT_SETTINGS), [
    'Move: KeyW/KeyZ KeyA/KeyQ KeyS KeyD or arrows or left stick',
    'Camera: mouse (click the game to capture, Esc releases) or right stick',
    'Jump: Space / pad button 0',
    'Dive: ShiftLeft / pad button 1',
    'Grab: KeyE / pad button 2',
    'Emotes: 1-4',
    'Pause: Esc / pad Start',
  ])
  let settings = rebind(DEFAULT_SETTINGS, 'jump', 'KeyJ')
  settings = rebind(settings, 'dive', 'KeyV')
  settings = rebind(settings, 'grab', 'KeyQ')
  settings = rebind(settings, 'forward', 'KeyF')
  settings = rebind(settings, 'back', 'KeyB')
  settings = rebind(settings, 'right', 'KeyR')
  const lines = controlLines(settings)
  assert.equal(lines[0], 'Move: KeyF/KeyZ KeyA KeyB KeyR or arrows or left stick')
  assert.equal(lines[2], 'Jump: KeyJ / pad button 0')
  assert.equal(lines[3], 'Dive: KeyV / pad button 1')
  assert.equal(lines[4], 'Grab: KeyQ / pad button 2')
  const pause = modelAt(ctx({ settings }), { kind: 'action', action: 'play' }, { kind: 'back' })
  assert.equal(pause.screen, 'pause')
  assert.deepEqual(pause.lines, lines)
  assert.equal(HINTS.hub, 'WASD/ZQSD move - mouse or right stick: camera - 1-4 emote - the round starts by itself - Esc menu')
})

test('loading shows its progress line and has no button', () => {
  const nav = new Nav()
  nav.dispatch({ kind: 'load', next: 'title' })
  const ctx: MenuCtx = { settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [progressLine(nav.progress)] }
  assert.deepEqual(menuModel(nav.screen, nav.actions(), ctx).buttons, [])
  assert.deepEqual(menuModel(nav.screen, nav.actions(), ctx).lines, ['Starting...'])
  nav.dispatch({ kind: 'progress', progress: { phase: 'meshing', done: 2, total: 7, label: 'candy.spinner-bar' } })
  assert.equal(progressLine(nav.progress), 'meshing 2/7 candy.spinner-bar')
})
