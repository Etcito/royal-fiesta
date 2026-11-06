import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// A second boot in the one GPU page (dispose, then a new App and a new uaa GPU device) froze the GPU client in
// requestDevice ("awaiting: UI GPU device", runs 12341 and 12345). settingsPages runs both sizes on one App and
// keeps going past a missed state, so one GPU job lists every failure.
const source = readFileSync(new URL('../src/game/checks/settingsPages.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')

test('settingsPages boots one App, outside any loop and outside the per-size pass', () => {
  assert.equal(source.match(/deps\.boot\(/g)?.length, 1, 'one deps.boot call')
  const runBody = source.slice(source.indexOf('export async function run('))
  assert.ok(runBody.includes('deps.boot('), 'the boot is in run(), not in runSize()')
  const loop = /(for|while)\s*\([^)]*\)\s*\{[^}]*deps\.boot\(/s
  assert.ok(!loop.test(runBody), 'the boot is not repeated per size')
})

test('settingsPages reports a failed section and runs the next one', () => {
  const sections = [...source.matchAll(/await section\('([^']+)'/g)].map(m => m[1])
  assert.deepEqual(sections, ['Audio page', 'Graphics page', 'Controls page', 'Gameplay page', 'Back to start', 'Pause Controls page'])
  assert.match(source, /catch \(error\) \{ report\(/, 'a section catches and reports')
})

test('a UI GPU request that never settles rejects naming the resource, requester and last phase', async () => {
  const { gpuDeadline } = await import('../src/ui/uaaHost.ts')
  await assert.rejects(gpuDeadline('UI GPU device', new Promise(() => {}), 20),
    /UI GPU device: no answer within 0\.02 s \(requester: createUaaHost; last phase: none\)/)
  assert.equal(await gpuDeadline('UI GPU adapter', Promise.resolve(7), 20), 7)
})

// Run 12350: Up from a Controls row reached tab-audio (uaa focus is spatial), one Right opened Graphics and the
// Gameplay wait ran out. The walk goes by the focused tab, wherever Up lands.
test('focusTab reaches the target tab wherever Up lands in the tab row', async () => {
  const { focusTab } = await import('../src/game/checkSupport/settingsTabs.ts')
  const tabs = ['tab-audio', 'tab-graphics', 'tab-controls', 'tab-gameplay']
  for (const landing of tabs) {
    for (const target of ['audio', 'graphics', 'controls', 'gameplay'] as const) {
      let focus: string = 'row-0'
      const press = async (key: string): Promise<void> => {
        const at = tabs.indexOf(focus)
        if (key === 'ArrowUp') focus = at < 0 ? landing : focus
        else if (key === 'ArrowRight') focus = tabs[Math.min(at + 1, 3)]
        else if (key === 'ArrowLeft') focus = tabs[Math.max(at - 1, 0)]
      }
      await focusTab(target, () => focus, press)
      assert.equal(focus, `tab-${target}`, `from ${landing} to ${target}`)
    }
  }
  await assert.rejects(focusTab('gameplay', () => 'row-0', async () => {}, 3), /gameplay: tab row focus: row-0/)
})

// Run 12354: focus on back (above the tab row in landscape); Up stayed on back and every page failed.
test('focusTab goes Down to the tab row when focus is on the header above it', async () => {
  const { focusTab } = await import('../src/game/checkSupport/settingsTabs.ts')
  const tabs = ['tab-audio', 'tab-graphics', 'tab-controls', 'tab-gameplay']
  for (const header of ['back', 'act-credits']) {
    let focus = header
    const press = async (key: string): Promise<void> => {
      const at = tabs.indexOf(focus)
      if (key === 'ArrowDown' && at < 0) focus = 'tab-audio'
      else if (key === 'ArrowRight') focus = tabs[Math.min(at + 1, 3)]
    }
    await focusTab('controls', () => focus, press)
    assert.equal(focus, 'tab-controls', `from ${header}`)
  }
})

test('every settingsPages assertion names what it expected and what the page showed', () => {
  assert.ok(!/\bfail\(/.test(source), 'no bare label assertions')
  assert.match(source, /expected \$\{JSON\.stringify\(expected\)\}, found \$\{JSON\.stringify\(actual \?\? null\)\} \(\$\{state\(\)\}\)/)
  assert.match(source, /not reached within \$\{ms \/ 1000\} s \(\$\{state\(\)\}\)/)
})

test('the App resets the settings page whenever Settings is entered', () => {
  const main = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  assert.match(main, /this\.settingsPage = pageAfterScreen\(this\.drawnScreen, nav\.screen, this\.settingsPage\)\n\s*this\.drawnScreen = nav\.screen/)
})
