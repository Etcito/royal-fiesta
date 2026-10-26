import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoundLoad, observeRoundLoad, startup, courseFrame, renderFrame, roundReady, attachRoundReport } from '../../../packages/game/src/render/roundLoad.ts'

test('spans retain start/end, record failures, and print only once', () => {
  let clock = 10
  const trace = new RoundLoad('test', () => clock)
  const labels: (string | null)[] = []
  const report = {}
  observeRoundLoad(label => labels.push(label), report)
  assert.throws(() => trace.measure('refused upload', () => { clock = 25; throw Error('failed') }))
  assert.deepEqual(trace.spans, [{ step: 'refused upload', start: 10, end: 25, ms: 15 }])
  trace.finish()
  trace.finish()
  assert.deepEqual(labels, ['refused upload', null])
  assert.equal((report as { roundTimeline: string[] }).roundTimeline.length, 1)
})

test('each port finishes its own round and the report retains previous rounds', () => {
  const report: Record<string, number | string | readonly string[]> = {}
  observeRoundLoad(() => {}, report)
  const a = startup('a', () => ({}))
  const b = startup('b', () => ({}))
  const pa = {}, pb = {}
  courseFrame(a, pa, 'race', () => {})
  courseFrame(b, pb, 'survival', () => {})
  renderFrame(pa, () => {})
  renderFrame(pb, () => {})
  const rows = (report.roundTimeline as string[]).map(s => JSON.parse(s))
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(r => r.round), ['a', 'a', 'a', 'b', 'b', 'b'])
  renderFrame(pa, () => {})
  assert.equal((report.roundTimeline as string[]).length, 6)
})


test('a new course waits for a loading paint and disposal removes the observer', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  let paint: (() => void) | null = null
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (f: () => void) => { paint = f; return 1 } })
  const labels: (string | null)[] = []
  const stop = observeRoundLoad(label => labels.push(label), {})
  try {
    const port = {}
    assert.equal(roundReady(port, 'race'), false)
    assert.equal(roundReady(port, 'race'), false)
    assert.deepEqual(labels, ['Preparing course: race'])
    ;(paint as unknown as () => void)()
    assert.equal(roundReady(port, 'race'), true)
    stop()
    assert.equal(roundReady({}, 'survival'), true)
    assert.equal(labels.length, 1)
  } finally {
    stop()
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original)
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  }
})

test('nested render wrappers finish once and retain the port report', () => {
  const globalReport = {}
  const portReport: Record<string, number | string | readonly string[]> = {}
  const stop = observeRoundLoad(() => {}, globalReport)
  const sim = startup('nested', () => ({}))
  const port = {}
  attachRoundReport(port, portReport)
  courseFrame(sim, port, 'race', () => {})
  renderFrame(port, () => renderFrame(port, () => {}))
  assert.equal((portReport.roundTimeline as string[]).length, 3)
  assert.deepEqual(globalReport, {})
  stop()
})
