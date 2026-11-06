import { SETTINGS_PAGES, type SettingsPage } from '@royal-fiesta/game/screens/settingsPages'

// uaa moves focus spatially: Up from a row lands on the nearest tab, not on the open page's tab (run 12350: Up
// from Controls row-0 reached tab-audio, Right opened Graphics, and the Gameplay page never came). Reach the tab
// row, then walk Left/Right by the focused tab until the target page's tab has the focus. Presses are bounded, so a
// focus that never arrives fails at once with the widget it stopped on.
export async function focusTab(
  page: SettingsPage, focused: () => string | null, press: (key: string) => Promise<void>, maxPresses = 32
): Promise<void> {
  const tabIndex = (): number => SETTINGS_PAGES.findIndex(p => focused() === `tab-${p}`)
  // Back and Credits sit above the tab row (run 12354: focus on back, Up stayed there for every page). When Up no
  // longer moves the focus, the tab row is below it: go Down from there.
  let key: 'ArrowUp' | 'ArrowDown' = 'ArrowUp'
  for (let presses = 0; tabIndex() < 0; presses++) {
    if (presses >= maxPresses) throw new Error(`${page}: tab row focus: ${focused()} (${presses} presses, last ${key})`)
    const before = focused()
    await press(key)
    if (key === 'ArrowUp' && focused() === before) key = 'ArrowDown'
  }
  const target = SETTINGS_PAGES.indexOf(page)
  const walk = tabIndex() < target ? 'ArrowRight' : 'ArrowLeft'
  for (let presses = 0; tabIndex() !== target; presses++) {
    if (tabIndex() < 0 || presses >= SETTINGS_PAGES.length) throw new Error(`${page}: tab-${page} focus: ${focused()}`)
    await press(walk)
  }
}
