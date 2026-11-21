import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { drawRoundHud, hudLines } from '../src/engineRound/hud.ts'
import { createReadyGate } from '../src/engineRound/ready.ts'
import { DRAW_TICKS, SETTLE_FRAMES, runOffline, settle } from '../src/engineRound/pace.ts'
import type { RoundFacts } from '../src/engineRound/run.ts'

const turn = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

function pageSource(): string {
  return readFileSync(new URL('../src/engineRound/main.ts', import.meta.url), 'utf8')
}

// Execute the page's tick observer without importing its Vite-only documents.
function observeRoundTickOf(source: string) {
  const text = source.match(/export (function observeRoundTick\([\s\S]*?\n\})/)![1]
  return new Function(`${stripTypeScriptTypes(text)}; return observeRoundTick`)() as
    (sim: { tick: number; refresh(round: { tick: number }): void }, view: { observeTick(seen: { tick: number }): void },
      round: { tick: number }, observed: number) => number
}

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

test('the engine page observes each executed round tick and never casts the adapter to MatchSim', () => {
  const source = pageSource()
  assert.equal(/as unknown as MatchSim/.test(source), false, 'the page presents the read view, not a MatchSim')
  assert.equal(source.includes("sim/match/matchSim"), false, 'the page imports no MatchSim')
  assert.match(source, /view\.observeTick\(sim\)/, 'the page observes the adapter explicitly')
  const live = source.match(/const frame = \(now: number\) => \{[\s\S]*?\n  \}/)![0]
  const step = live.indexOf('page.round.step(')
  const observe = live.indexOf('page.observe()')
  const draw = live.indexOf('page.drawFrame(')
  assert.ok(step >= 0 && observe > step, 'a live tick is observed before the next tick')
  assert.ok(draw > observe, 'the live frame draws only after its executed ticks were observed')
  assert.match(source, /while \(run\.step\(\)\) page\.observe\(\)/, 'the boot fast-forward observes each executed tick too')
})

test('a presentation-only settle repeats the final tick without observing it again', async () => {
  const observe = observeRoundTickOf(pageSource())
  const observed: number[] = []
  let refreshes = 0
  const sim = { tick: 0, refresh(round: { tick: number }) { refreshes++; sim.tick = round.tick } }
  const view = { observeTick(seen: { tick: number }) { observed.push(seen.tick) } }
  let observedTick = -1
  let steps = 0
  let done = false
  const run = {
    get done() { return done },
    step() { if (done) return false; steps++; if (steps >= 5) done = true; return true },
  }
  const page = {
    advance() { observedTick = observe(sim, view, { tick: steps }, observedTick) },
    render() {},
  }
  const hooks = { tick: () => {}, firstFrame: async () => {}, device: () => undefined, phase: () => {} }
  assert.equal(await runOffline(run, page, hooks, 5), 5)
  assert.deepEqual(observed, [1, 2, 3, 4, 5], 'each executed tick is observed once and in order')
  assert.equal(refreshes, 5)
  await settle(page, undefined)
  assert.deepEqual(observed, [1, 2, 3, 4, 5], 'settle frames draw the final tick without observing it again')
  assert.equal(refreshes, 5, 'a repeated presentation tick does not refresh the adapter')
})

test('runOffline advances every tick but draws only the first, every DRAW_TICKS-th and the capture tick', async () => {
  // m4-race-sprint-gates: 1200 ticks to the end. Each drawn frame cost the GPU client ~0.65 s at 1920x1080 once the field
  // pipelines were compiled, so drawing all 1200 ticks ran past the 295 s page limit (run 16017).
  const frames = 1200
  let steps = 0
  const run = { done: false, step() { if (this.done) return false; steps++; if (steps >= frames) this.done = true; return true } }
  let advanced = 0
  const drawn: number[] = []
  const clock: number[] = []
  const phases: string[] = []
  let gpuWaits = 0
  let firstFrames = 0
  const page = { advance: () => { advanced++ }, render: () => { drawn.push(advanced) } }
  const device = { queue: { onSubmittedWorkDone: async () => { gpuWaits++ } } }
  const ticks = await runOffline(run, page, {
    tick: done => { clock.push(done) }, firstFrame: async () => { firstFrames++ }, device: () => device, phase: text => { phases.push(text) },
  }, frames)
  assert.equal(ticks, frames)
  assert.equal(advanced, frames)
  assert.deepEqual(clock, Array.from({ length: frames }, (_, k) => k))
  assert.deepEqual(drawn, [1, ...Array.from({ length: frames / DRAW_TICKS }, (_, k) => (k + 1) * DRAW_TICKS)])
  assert.equal(gpuWaits, drawn.length)
  assert.equal(firstFrames, 1)
  assert.equal(phases.at(-1), `engine-round: tick ${frames}/${frames}`)
  // An event capture (dive, firstFinish, respawned) ends between two drawn ticks: its tick is drawn.
  let n = 0
  const early = { done: false, step() { if (this.done) return false; n++; if (n >= 77) this.done = true; return true } }
  const late: number[] = []
  let count = 0
  await runOffline(early, { advance: () => { count++ }, render: () => { late.push(count) } }, {
    tick: () => {}, firstFrame: async () => {}, device: () => undefined, phase: () => {},
  }, frames)
  assert.deepEqual(late, [1, 60, 77])
  const settled: string[] = []
  await settle({ advance: dt => { settled.push(`a${dt}`) }, render: () => { settled.push('r') } }, device)
  assert.equal(settled.length, 2 * SETTLE_FRAMES)
  assert.equal(settled.at(-1), 'r')
})
