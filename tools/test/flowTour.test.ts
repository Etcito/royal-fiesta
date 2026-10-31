import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { flowTourInput } from '../flowTour.ts'

test('flow tour render input matches the game op and its ordered seven screens', () => {
  const screens = ['start', 'vote', 'countdown', 'round', 'result', 'elimShow', 'endScreen']
  assert.deepEqual(flowTourInput(), {
    page: 'game', op: 'flowTour', input: { width: 1920, height: 1080 }, screens,
  })
  // Node cannot import uiTour: its UI document import uses Vite's ?raw loader.
  const tour = readFileSync(new URL('../../apps/web/src/game/uiTour.ts', import.meta.url), 'utf8')
  const list = tour.match(/export const FLOW_TOUR_SCREENS[^=]*=\s*(\[[^\]]*\])/)?.[1]
  assert.ok(list, 'FLOW_TOUR_SCREENS declaration missing')
  assert.deepEqual(JSON.parse(list.replaceAll("'", '"')), screens)
  const ops = readFileSync(new URL('../../apps/web/src/game/ops.ts', import.meta.url), 'utf8')
  assert.match(ops, /onlyKeys\('flowTour', 'input', o, \['width', 'height'\]\)/)
  assert.match(ops, /FLOW_TOUR_WIDTH\s*=\s*1920/)
  assert.match(ops, /FLOW_TOUR_HEIGHT\s*=\s*1080/)
  assert.match(ops, /tourScreens\(FLOW_TOUR_SCREENS, deps\)/)
  assert.match(ops, /gpu\.ops\.flowTour\s*=/)
})
