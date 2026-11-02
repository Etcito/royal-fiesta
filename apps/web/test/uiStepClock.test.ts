import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { createFontRegistry, createUi, loadUiDoc, parseUiAssetText } from '@etcito/uaa'

const uiDir = new URL('../../../ui/', import.meta.url)
const assets = new Map(readdirSync(uiDir).filter(n => n.endsWith('.ui.json')).map(n => {
  const asset = parseUiAssetText(readFileSync(new URL(n, uiDir), 'utf8'))
  return [asset.id, asset] as const
}))
const doc = loadUiDoc(JSON.parse(readFileSync(new URL('screens.ui-doc.json', uiDir), 'utf8')), assets)
const DT_MS = 1000 / 60
const TEST_VOTE_FRAMES = 60

// The show's screens as an op steps them: hub, the round's load hold, the 1 s test vote, the next load.
// `clock(frame)` is the time handed to ui.update after each frame; the screens a check would see are returned.
function stepShow(clock: (frame: number) => number): string[] {
  const ui = createUi({ doc, assets, fonts: createFontRegistry([]), renderer: null,
    viewport: { width: 1280, height: 720, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }, nowMs: 0 })
  const seen: string[] = []
  ui.on('screen', e => seen.push(e.to))
  try {
    ui.show('hub', { animate: false })
    const plan = [...Array(3).fill('loading'), ...Array(TEST_VOTE_FRAMES).fill('vote'), ...Array(30).fill('loading')]
    plan.forEach((screen, frame) => {
      ui.show(screen)
      ui.update(clock(frame + 1))
    })
  } finally { ui.destroy() }
  return seen
}

test('screens stepped on the frames clock enter the 1 s test vote', () => {
  assert.ok(stepShow(frame => frame * DT_MS).includes('vote'))
})

test('on a wall clock slower than the stepped frames, the exit fade swallows the vote (lobbyUnload, run 11348)', () => {
  // 60 stepped frames in ~60 ms of real time: the 150 ms hub exit fade outlives the whole vote.
  assert.ok(!stepShow(frame => frame).includes('vote'))
})

test('the App presents uaa frames on its frames clock, not performance.now()', () => {
  const main = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  assert.equal(main.match(/host\.frame\(performance\.now\(\)\)/g), null)
  assert.ok((main.match(/host\.frame\(this\.uiNowMs\)/g) ?? []).length >= 4)
  assert.match(main, /this\.uiNowMs \+= Math\.max\(0, dt\) \* 1000/)
})
