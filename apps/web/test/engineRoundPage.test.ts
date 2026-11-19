import assert from 'node:assert/strict'
import test from 'node:test'
import { drawRoundHud, hudLines } from '../src/engineRound/hud.ts'
import { createReadyGate } from '../src/engineRound/ready.ts'
import type { RoundFacts } from '../src/engineRound/run.ts'

const turn = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

test('a pending load keeps the gate loading', async () => {
  const shown: Array<[string, string | undefined]> = []
  let loaded = false
  const gate = createReadyGate(() => new Promise<void>(() => { loaded = true }),
    (state, message) => shown.push([state, message]))
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await turn()
  }
  assert.equal(loaded, true)
  assert.deepEqual(shown, [['loading', undefined]])
  let settled = false
  gate.ready.then(() => { settled = true }, () => { settled = true })
  await turn()
  assert.equal(settled, false)
})

test('a rejecting load shows the error and never ready', async () => {
  const shown: Array<[string, string | undefined]> = []
  const gate = createReadyGate(() => Promise.reject(new Error('boom')),
    (state, message) => shown.push([state, message]))
  await assert.rejects(gate.ready, /boom/)
  assert.deepEqual(shown, [['loading', undefined], ['error', 'boom']])
  assert.equal(shown.some(([state]) => state === 'ready'), false)
})

function sampleFacts(overrides: Partial<RoundFacts> = {}): RoundFacts {
  return {
    course: 'race-sprint', kind: 'race', profile: 'sprint', tick: 120, capturedAt: 120, phase: 'playing',
    seats: 8, entities: 80, bodies: 72, faults: 0, alive: 8, qualified: 0, eliminated: 0,
    events: {}, local: { mode: 1, status: 1, pos: [0, 0, 0], travelZ: 1 }, botsMoved: 7, upright: true,
    features: {}, focus: null, ...overrides,
  }
}

test('hudLines gives the five E7 lines', () => {
  assert.deepEqual(hudLines(sampleFacts(), 'Sprint Dash'), [
    'Sprint Dash (race)',
    'tick 120  phase playing',
    'alive 8  qualified 0  eliminated 0',
    'you: air',
    'scripts: faults 0',
  ])
  assert.equal(hudLines(sampleFacts({ local: { mode: 42, status: 1, pos: [0, 0, 0], travelZ: 0 } }), 'Sprint Dash')[3], 'you: mode 42')
})

function fakeContext() {
  const rects: number[][] = []
  const texts: Array<[string, number, number]> = []
  const context = {
    font: '', fillStyle: '', textBaseline: '',
    measureText: (line: string) => ({ width: line.length * 10 }),
    fillRect: (...args: number[]) => { rects.push(args) },
    fillText: (text: string, x: number, y: number) => { texts.push([text, x, y]) },
  }
  return { ctx: context as unknown as CanvasRenderingContext2D, rects, texts }
}

test('drawRoundHud records one band and five text lines', () => {
  const { ctx, rects, texts } = fakeContext()
  const lines = hudLines(sampleFacts(), 'Sprint Dash')
  drawRoundHud(ctx, lines, 1920, 1080)
  assert.deepEqual(rects, [[24, 24, 388, 212]])
  assert.deepEqual(texts, lines.map((line, k) => [line, 48, 40 + 36 * k]))
})
