import assert from 'node:assert/strict'
import test from 'node:test'
import { endScreen } from '../src/flow/endScreen.ts'
import { LOCAL_COSMETICS, LOCAL_OWNED, startScreen, startStep } from '../src/flow/startScreen.ts'
import type { StartScreenModel } from '../src/flow/startScreen.ts'
import { flowAction } from '../src/screens/nav.ts'
import type { Action } from '../src/screens/nav.ts'
import type { ShowState, ZoneRoundResult } from '../src/net/zoneRounds.ts'

const CATALOG = Object.freeze([
  ...LOCAL_COSMETICS,
  { id: 'costume.crown', slot: 'head' },
  { id: 'costume.boots', slot: 'bottom' },
])

const allIds = LOCAL_COSMETICS.map(item => item.id)

function result(overrides: Partial<ZoneRoundResult> = {}): ZoneRoundResult {
  return {
    index: 0,
    map: 'A',
    course: 'course-a',
    kind: 'race',
    final: false,
    playoff: false,
    endTick: 100,
    reason: 'target',
    ranking: [],
    qualified: [],
    eliminated: [],
    points: [],
    teamScores: [],
    champion: -1,
    ...overrides,
  }
}

function show(rounds: ZoneRoundResult[]): ShowState {
  return {
    cursor: { plan: [rounds.length + 1, 1], step: rounds.length, alive: 1, teamRounds: 0, roundIndex: rounds.length },
    schedule: { finalMap: null, used: [], lastKind: null, previous: null, rngState: 0 },
    rounds,
    openingRanks: new Uint16Array(8),
  }
}

type Ui = { k: 'focus' | 'adjust'; dir: -1 | 1 } | { k: 'select' } | { k: string }

function drive(
  m: StartScreenModel,
  events: readonly Ui[],
): { model: StartScreenModel; effect: 'play' | 'shop' | 'wear' | null } {
  let current = m
  let effect: 'play' | 'shop' | 'wear' | null = null
  for (const ev of events) {
    const action = flowAction(ev)
    assert.notEqual(action, null)
    const step = startStep(current, action as Action)
    current = step.model
    effect = step.effect
  }
  return { model: current, effect }
}

const focusEvents = (dir: -1 | 1, times: number): Ui[] =>
  Array.from({ length: times }, () => ({ k: 'focus', dir }) as Ui)

test('bins list only owned cosmetics, in head, body, bottom order', () => {
  const m = startScreen(['costume.propeller-hat', 'costume.fish-scarf'], CATALOG, 4, { colour: 1, worn: {} })

  assert.deepEqual(m.bins.map(bin => bin.slot), ['head', 'body', 'bottom'])
  assert.deepEqual(m.bins[0].items, ['costume.propeller-hat'])
  assert.deepEqual(m.bins[1].items, [])
  assert.deepEqual(m.bins[2].items, ['costume.fish-scarf'])
  assert.ok(!m.bins.some(bin => bin.items.includes('costume.crown')))
  assert.ok(!m.bins.some(bin => bin.items.includes('costume.boots')))
  assert.ok(m.bins.every(bin => bin.selected === -1))
  assert.deepEqual(m.palette, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(m.colour, 1)
  assert.equal(m.focus, 'bins')
  assert.equal(m.bin, 0)
  assert.equal(m.badge, 4)
  assert.equal(m.background, 'candy')
})

test('an owned slot with no catalog match is empty, and nothing of another slot leaks in', () => {
  const m = startScreen(['costume.pineapple-suit'], CATALOG, 0, { colour: 0, worn: {} })
  assert.deepEqual(m.bins.map(bin => bin.items), [[], ['costume.pineapple-suit'], []])
  assert.ok(m.bins.every(bin => bin.selected === -1))

  const empty = startScreen([], CATALOG, 0, { colour: 0, worn: {} })
  assert.deepEqual(empty.bins.map(bin => bin.items), [[], [], []])
  assert.deepEqual(empty.bins.map(bin => bin.selected), [-1, -1, -1])
  const stepped = startStep(empty, 'right')
  assert.deepEqual(stepped.model.bins.map(bin => bin.selected), [-1, -1, -1])
  assert.equal(stepped.effect, 'wear')
})

test('saved worn and colour are restored', () => {
  const saved = {
    colour: 3,
    worn: {
      head: 'costume.propeller-hat',
      body: 'costume.pineapple-suit',
      bottom: 'costume.fish-scarf',
    },
  }
  const m = startScreen(allIds, LOCAL_COSMETICS, 2, saved)
  assert.deepEqual(m.bins.map(bin => bin.selected), [0, 0, 0])
  assert.equal(m.colour, 3)

  // The selection is the item's index in the filtered bin, not its catalog index.
  const shifted = startScreen(
    ['costume.crown', 'costume.propeller-hat'],
    [
      { id: 'costume.crown', slot: 'head' },
      { id: 'costume.propeller-hat', slot: 'head' },
      { id: 'costume.pineapple-suit', slot: 'body' },
    ],
    0,
    { colour: 99, worn: { head: 'costume.propeller-hat', body: 'costume.pineapple-suit' } },
  )
  assert.deepEqual(shifted.bins[0].items, ['costume.crown', 'costume.propeller-hat'])
  assert.equal(shifted.bins[0].selected, 1)
  assert.equal(shifted.bins[1].selected, -1)
  assert.equal(shifted.colour, 7)

  const low = startScreen([], LOCAL_COSMETICS, 0, { colour: -2, worn: {} })
  assert.equal(low.colour, 0)
})

test('LOCAL_OWNED resolves to the three local costume ids', async () => {
  assert.deepEqual(await LOCAL_OWNED.owned(), allIds)
  assert.deepEqual(allIds, ['costume.propeller-hat', 'costume.pineapple-suit', 'costume.fish-scarf'])
  assert.deepEqual(LOCAL_COSMETICS.map(item => item.slot), ['head', 'body', 'bottom'])
})

test('keyboard actions reach Play', () => {
  const m = startScreen(allIds, LOCAL_COSMETICS, 0, { colour: 0, worn: {} })
  const played = drive(m, [...focusEvents(1, 4), { k: 'select' }])
  assert.equal(played.model.focus, 'play')
  assert.equal(played.effect, 'play')
})

test('pad actions reach Play and Shop', () => {
  const m = startScreen(allIds, LOCAL_COSMETICS, 0, { colour: 0, worn: {} })
  const played = drive(m, [...focusEvents(1, 4), { k: 'select' }])
  assert.equal(played.effect, 'play')

  const shopped = drive(m, [{ k: 'focus', dir: -1 }, { k: 'select' }])
  assert.equal(shopped.model.focus, 'shop')
  assert.equal(shopped.effect, 'shop')

  const swapped = drive(m, [...focusEvents(1, 4), { k: 'adjust', dir: 1 }, { k: 'select' }])
  assert.equal(swapped.model.focus, 'shop')
  assert.equal(swapped.effect, 'shop')
})

test('up and down walk the bins, palette, play and shop ring with wrapping', () => {
  const m = startScreen(allIds, LOCAL_COSMETICS, 0, { colour: 0, worn: {} })
  let model = m
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'bins')
  assert.equal(model.bin, 1)
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'bins')
  assert.equal(model.bin, 2)
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'palette')
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'play')
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'shop')
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'bins')
  assert.equal(model.bin, 0)
  model = startStep(model, 'up').model
  assert.equal(model.focus, 'shop')
})

test('left and right cycle the bin selection over -1..items-1 and return wear', () => {
  let model = startScreen(['costume.propeller-hat', 'costume.crown'], CATALOG, 0, {
    colour: 0,
    worn: { head: 'costume.propeller-hat' },
  })
  assert.equal(model.bins[0].selected, 0)

  let step = startStep(model, 'right')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.bins[0].selected, 1)
  step = startStep(step.model, 'right')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.bins[0].selected, -1)
  step = startStep(step.model, 'right')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.bins[0].selected, 0)
  step = startStep(step.model, 'left')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.bins[0].selected, -1)

  const empty = startScreen(['costume.propeller-hat'], CATALOG, 0, { colour: 0, worn: {} })
  assert.equal(startStep(empty, 'left').effect, 'wear')
  assert.equal(startStep(empty, 'right').effect, 'wear')
})

test('left and right wrap the palette and return wear; play and shop swap', () => {
  let model = startScreen(allIds, LOCAL_COSMETICS, 0, { colour: 0, worn: {} })
  model = startStep(model, 'down').model
  model = startStep(model, 'down').model
  model = startStep(model, 'down').model
  assert.equal(model.focus, 'palette')

  let step = startStep(model, 'right')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.colour, 1)
  step = startStep(step.model, 'left')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.colour, 0)
  step = startStep(step.model, 'left')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.colour, 7)
  step = startStep(step.model, 'right')
  assert.equal(step.effect, 'wear')
  assert.equal(step.model.colour, 0)

  const play = startStep(model, 'down').model
  assert.equal(play.focus, 'play')
  const swapped = startStep(play, 'right')
  assert.equal(swapped.model.focus, 'shop')
  assert.equal(swapped.effect, null)
  assert.equal(startStep(swapped.model, 'left').model.focus, 'play')

  // Confirm only acts on a button.
  assert.equal(startStep(model, 'confirm').effect, null)
  assert.equal(startStep(model, 'confirm').model.focus, 'palette')
})

test('endScreen crowns the top three of a six-entrant final', () => {
  const final = result({
    index: 3,
    kind: 'final',
    final: true,
    ranking: [3, 0, 6, 1, 2, 5],
    qualified: [3],
    eliminated: [0, 6, 1, 2, 5],
    points: [6, 0, 0, 0, 0, 0],
    champion: 3,
  })
  const m = endScreen(show([final]))

  assert.deepEqual(m.podium, [
    { seat: 3, crown: 'gold' },
    { seat: 0, crown: 'silver' },
    { seat: 6, crown: 'bronze' },
  ])
  assert.equal(m.winner, 3)
  assert.equal(m.goldenTicketTo, 3)
  assert.equal(m.showWinnerMs, 4000)
  assert.equal('popup' in m, false)
})

test('a two-entrant final fills the podium from the earlier rounds, latest first', () => {
  const first = result({ index: 0, ranking: [5, 3, 0, 6, 2, 1], points: [6, 5, 4, 0, 0, 0] })
  const second = result({ index: 1, ranking: [4, 2, 1, 6, 0, 3], points: [6, 5, 4, 0, 0, 0] })
  const final = result({
    index: 2,
    kind: 'final',
    final: true,
    ranking: [1, 4],
    qualified: [1],
    eliminated: [4],
    points: [2, 0],
    champion: 1,
  })
  const m = endScreen(show([first, second, final]))

  assert.deepEqual(m.podium, [
    { seat: 1, crown: 'gold' },
    { seat: 4, crown: 'silver' },
    { seat: 2, crown: 'bronze' },
  ])
  assert.equal(m.winner, 1)
  assert.equal(m.goldenTicketTo, 1)
})

test('the golden ticket goes to the champion, and the winner falls back to the podium head', () => {
  const champion = result({
    final: true, kind: 'final', ranking: [4, 1], qualified: [4], eliminated: [1], points: [2, 0], champion: 1,
  })
  const m = endScreen(show([champion]))
  assert.deepEqual(m.podium.map(entry => entry.seat), [4, 1])
  assert.equal(m.winner, 1)
  assert.equal(m.goldenTicketTo, 1)

  const noChampion = result({
    final: true, kind: 'final', ranking: [2, 7], qualified: [2], eliminated: [7], points: [2, 0], champion: -1,
  })
  const fallback = endScreen(show([noChampion]))
  assert.equal(fallback.winner, 2)
  assert.equal(fallback.goldenTicketTo, 2)
})
