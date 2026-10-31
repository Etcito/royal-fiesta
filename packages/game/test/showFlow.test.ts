// The show flow's cross-model test: every screen model driven by a keyboard script and a pad
// script through flowAction, so both devices reach the same actions (and the same model/effects).
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { COUNTDOWN_MS, countdownAt } from '../src/flow/countdown.ts'
import { ELIM_SHOW, elimShow, elimSkip } from '../src/flow/elimShow.ts'
import type { ElimShowModel } from '../src/flow/elimShow.ts'
import { endScreen } from '../src/flow/endScreen.ts'
import { LOCAL_COSMETICS, startScreen, startStep } from '../src/flow/startScreen.ts'
import type { StartScreenModel } from '../src/flow/startScreen.ts'
import { VOTE_MS, voteStep } from '../src/flow/vote.ts'
import type { VoteModel } from '../src/flow/vote.ts'
import { newShow } from '../src/net/zoneRounds.ts'
import type { ShowState, ZoneRoundResult } from '../src/net/zoneRounds.ts'
import { flowAction } from '../src/screens/nav.ts'
import type { Action } from '../src/screens/nav.ts'

// The UiEvent shapes flowAction takes (apps/web input produces these for keys and pads).
type FlowUiEvent = Parameters<typeof flowAction>[0]

// Keyboard: ArrowLeft/Right -> adjust, ArrowUp/Down -> focus, Enter -> select.
const KEY_EVENTS: Readonly<Record<string, FlowUiEvent>> = {
  ArrowLeft: { k: 'adjust', dir: -1 },
  ArrowRight: { k: 'adjust', dir: 1 },
  ArrowUp: { k: 'focus', dir: -1 },
  ArrowDown: { k: 'focus', dir: 1 },
  Enter: { k: 'select' },
}

// Pad: d-pad 14/15/12/13 and button 0 -> the same UiEvent kinds (padMenu.ts).
const PAD_EVENTS: Readonly<Record<number, FlowUiEvent>> = {
  14: { k: 'adjust', dir: -1 },
  15: { k: 'adjust', dir: 1 },
  12: { k: 'focus', dir: -1 },
  13: { k: 'focus', dir: 1 },
  0: { k: 'select' },
}

function keyEvents(codes: readonly string[]): FlowUiEvent[] {
  return codes.map((code) => {
    const ev = KEY_EVENTS[code]
    assert.notEqual(ev, undefined, `unbound key ${code}`)
    return ev
  })
}

function padEvents(buttons: readonly number[]): FlowUiEvent[] {
  return buttons.map((button) => {
    const ev = PAD_EVENTS[button]
    assert.notEqual(ev, undefined, `unbound pad button ${button}`)
    return ev
  })
}

function actionsOf(events: readonly FlowUiEvent[]): Action[] {
  return events.map((ev) => {
    const action = flowAction(ev)
    assert.notEqual(action, null, `no flow action for ${JSON.stringify(ev)}`)
    return action as Action
  })
}

function result(overrides: Partial<ZoneRoundResult> = {}): ZoneRoundResult {
  return {
    index: 0, map: 'A', course: 'course-a', kind: 'race', final: false, playoff: false,
    endTick: 100, reason: 'target', ranking: [], qualified: [], eliminated: [],
    points: [], teamScores: [], champion: -1, ...overrides,
  }
}

// --- vote -------------------------------------------------------------------------------------

const VOTE_CANDIDATES: VoteModel['candidates'] = [
  { map: 'E', name: 'Sugar Sprint', kind: 'race' },
  { map: 'P', name: 'Sugar Signals', kind: 'logic' },
  { map: 'H', name: 'Wafer Wipeout', kind: 'survival' },
]

interface VoteRun { model: VoteModel; sends: (number | null)[]; sounds: (string | null)[] }

function runVote(events: readonly FlowUiEvent[]): VoteRun {
  let model: VoteModel = { candidates: VOTE_CANDIDATES, focus: 0, chosen: null, msLeft: VOTE_MS }
  const sends: (number | null)[] = []
  const sounds: (string | null)[] = []
  for (const action of actionsOf(events)) {
    const step = voteStep(model, action, 0)
    model = step.model
    sends.push(step.send)
    sounds.push(step.sound)
  }
  return { model, sends, sounds }
}

test('vote: right twice, confirm, then more moves/confirms give one send and no cancel', () => {
  const keyboard = runVote(keyEvents(['ArrowRight', 'ArrowRight', 'Enter', 'ArrowLeft', 'Enter']))
  const pad = runVote(padEvents([15, 15, 0, 14, 0]))
  assert.deepEqual(keyboard, pad)
  assert.deepEqual(keyboard.sends, [null, null, 2, null, null])
  assert.deepEqual(keyboard.sounds, ['ui.hover', 'ui.hover', 'flow.vote-confirm', null, null])
  assert.equal(keyboard.sends.filter(send => send !== null).length, 1)
  assert.equal(keyboard.model.focus, 2)
  assert.equal(keyboard.model.chosen, 2)
  assert.equal(keyboard.model.msLeft, VOTE_MS)
  const confirmed = runVote(keyEvents(['ArrowRight', 'ArrowRight', 'Enter']))
  assert.deepEqual(keyboard.model, confirmed.model)
})

// --- start screen -----------------------------------------------------------------------------

const OWNED = LOCAL_COSMETICS.map(item => item.id)

function runStart(events: readonly FlowUiEvent[]): {
  model: StartScreenModel
  effects: (ReturnType<typeof startStep>['effect'])[]
} {
  let model = startScreen(OWNED, LOCAL_COSMETICS, 3, { colour: 0, worn: {} })
  const effects: (ReturnType<typeof startStep>['effect'])[] = []
  for (const action of actionsOf(events)) {
    const step = startStep(model, action)
    model = step.model
    effects.push(step.effect)
  }
  return { model, effects }
}

test('start: change the head bin, change colour twice, go to play and confirm', () => {
  const keyboard = runStart(keyEvents([
    'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'Enter',
  ]))
  const pad = runStart(padEvents([15, 13, 13, 13, 15, 15, 13, 0]))
  assert.deepEqual(keyboard, pad)
  assert.deepEqual(keyboard.effects, ['wear', null, null, null, 'wear', 'wear', null, 'play'])
  assert.equal(keyboard.model.bins[0].selected, 0)
  assert.equal(keyboard.model.colour, 2)
  assert.equal(keyboard.model.focus, 'play')
})

test('start: reach shop and confirm', () => {
  const keyboard = runStart(keyEvents(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']))
  const pad = runStart(padEvents([13, 13, 13, 13, 13, 0]))
  assert.deepEqual(keyboard, pad)
  assert.deepEqual(keyboard.effects, [null, null, null, null, null, 'shop'])
  assert.equal(keyboard.model.focus, 'shop')
})

// --- elimination show -------------------------------------------------------------------------

const ENTRANTS = [0, 1, 2, 3, 4, 5]
const ELIMINATED = [4, 1]

function elimResult(): ZoneRoundResult {
  const qualified = [0, 2, 3, 5]
  return result({
    ranking: [...qualified, ...ELIMINATED], qualified, eliminated: ELIMINATED,
    points: [6, 5, 4, 3, 0, 0], endTick: 120,
  })
}

function runElimSkip(events: readonly FlowUiEvent[]): ElimShowModel {
  let model = elimShow(ENTRANTS, elimResult())
  for (const action of actionsOf(events)) {
    assert.equal(action, 'confirm')
    model = elimSkip(model, ELIM_SHOW.skipAfterMs + 100)
  }
  return model
}

test('elimShow: confirm is the skip at 1600 ms and every eliminated seat is gone', () => {
  const fresh = elimShow(ENTRANTS, elimResult())
  assert.equal(elimSkip(fresh, ELIM_SHOW.skipAfterMs - 1), fresh)
  const keyboard = runElimSkip(keyEvents(['Enter']))
  const pad = runElimSkip(padEvents([0]))
  assert.deepEqual(keyboard, pad)
  const gone = new Set(ELIMINATED)
  for (const cell of keyboard.grid) {
    assert.equal(cell.state, gone.has(cell.seat) ? 'gone' : 'stay')
  }
  assert.equal(keyboard.counter.now, keyboard.counter.to)
  assert.equal(keyboard.counter.now, ENTRANTS.length - ELIMINATED.length)
  assert.equal(keyboard.doneAtMs, ELIM_SHOW.skipAfterMs + 100)
})

// --- end screen -------------------------------------------------------------------------------

const SEASON_MAPS: SchedMap[] = [
  { id: 'opening', course: 0, kind: 'race', finalRule: null, stages: ['R1', 'R2', 'R3', 'R4'], team: false, cut: true },
  { id: 'crown', course: 1, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
]

function fixtureShow(): ShowState {
  const show = newShow(SEASON_MAPS, 6, 7)
  show.rounds.push(
    result({
      index: 0, map: 'opening', course: 'course-opening', ranking: [2, 1, 0, 3, 4, 5],
      qualified: [2, 1, 0, 3, 4], eliminated: [5], points: [6, 5, 4, 3, 2, 0], endTick: 900,
    }),
    result({
      index: 1, map: 'crown', course: 'course-crown', kind: 'final', final: true,
      ranking: [3, 0, 5, 1, 4, 2], qualified: [3], eliminated: [0, 5, 1, 4, 2],
      points: [6, 0, 0, 0, 0, 0], endTick: 1500, champion: 3, reason: 'crown',
    }),
  )
  return show
}

test('endScreen crowns gold, silver and bronze from the fixture final', () => {
  const keyboard = endScreen(fixtureShow())
  const pad = endScreen(fixtureShow())
  assert.deepEqual(keyboard, pad)
  assert.deepEqual(keyboard.podium, [
    { seat: 3, crown: 'gold' },
    { seat: 0, crown: 'silver' },
    { seat: 5, crown: 'bronze' },
  ])
  assert.equal(keyboard.winner, 3)
  assert.equal(keyboard.goldenTicketTo, 3)
  assert.equal(keyboard.showWinnerMs, 4000)
  // Continue reaches the same confirm action from both devices.
  assert.deepEqual(actionsOf(keyEvents(['Enter'])), actionsOf(padEvents([0])))
  assert.deepEqual(actionsOf(keyEvents(['Enter'])), ['confirm'])
})

// --- countdown --------------------------------------------------------------------------------

test('countdown: a 16 ms frame walk reaches 3, 2, 1, GO exactly once each', () => {
  const labels: string[] = []
  const sounds: string[] = []
  let previous: string | null = null
  for (let ms = 0; ms < COUNTDOWN_MS; ms += 16) {
    const frame = countdownAt(ms)
    assert.notEqual(frame.label, null)
    if (frame.label !== previous) {
      labels.push(frame.label as string)
      sounds.push(frame.sound as string)
      previous = frame.label
    }
  }
  assert.deepEqual(labels, ['3', '2', '1', 'GO'])
  assert.deepEqual(sounds, ['flow.count-tick', 'flow.count-tick', 'flow.count-tick', 'flow.count-go'])
  assert.deepEqual(countdownAt(COUNTDOWN_MS), { label: null, sound: null })
})
