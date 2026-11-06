import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

// present() alone writes a screen's title, hint and buttons (screenMap.screenProps); setHud() writes HUD, shop-line
// and settings-row widgets. A check that spies on setHud and waits for a present()-only widget waits forever
// (settingsPages waited 120 s for act-settings on the start screen). Such reads go through host.widget(id).
const PRESENT_ONLY = /^(title|hint|back|act-[\w-]+)$/
const READ = /props\[['"]([\w-]+)['"]\]|props\??\.([\w]+)|propText\(props, ['"]([\w-]+)['"]\)/g

export function presentOnlyHudReads(source: string): string[] {
  if (!/host\.setHud\s*=/.test(source) || /host\.present\s*=/.test(source)) return []
  return [...source.matchAll(READ)].map(m => m[1] ?? m[2] ?? m[3]).filter(id => PRESENT_ONLY.test(id))
}

test('checks never read a present()-only widget from a setHud spy', () => {
  const dir = new URL('../src/game/checks/', import.meta.url)
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    assert.deepEqual(presentOnlyHudReads(readFileSync(new URL(file, dir), 'utf8')), [], file)
  }
})

test('the guard catches a setHud spy waiting for the start screen act-settings', () => {
  const source = `live.host.setHud = values => { props = values }
    await waitFor(() => props['act-settings']?.visible === true && !!props.title?.text, 'start screen')`
  assert.deepEqual(presentOnlyHudReads(source), ['act-settings', 'title'])
})
