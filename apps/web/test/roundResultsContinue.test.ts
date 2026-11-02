import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountRoundResults } from '../src/screens/roundResults.ts'
import { screenProps } from '../src/ui/screenMap.ts'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { UaaHost } from '../src/ui/uaaHost.ts'
import { Nav } from '@royal-fiesta/game/screens/nav'

test('results present Continue as confirm, while Escape still pauses explicitly', () => {
  let menu!: MenuModel
  const host = { present(model: MenuModel) { menu = model } } as UaaHost
  mountRoundResults(host, { round: 1, rows: [] }, { cue() {} })
  assert.deepEqual(menu.buttons, [{ label: 'Continue', cmd: { k: 'action', action: 'confirm' } }])
  const doc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8'))
  const mapped = screenProps(doc, menu)
  assert.equal(mapped.props['act-confirm'].visible, true)
  assert.equal(mapped.props.back.visible, false)
  const nav = new Nav()
  nav.dispatch({ kind: 'action', action: 'play' })
  nav.dispatch({ kind: 'action', action: 'play' })
  nav.dispatch({ kind: 'game', screen: 'result' })
  assert.equal(nav.screen, 'result')
  nav.dispatch({ kind: 'back' })
  assert.equal(nav.screen, 'pause')
  nav.dispatch({ kind: 'back' })
  assert.equal(nav.screen, 'result')
})
