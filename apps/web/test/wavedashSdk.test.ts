// The Wavedash loader contract (apps/web/src/platform/wavedash.ts): the shell keeps the frame hidden until init().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BootStages, onWavedashOrigin, wavedashProgress, wavedashReady } from '../src/platform/wavedash.ts'
import { probeLine, probeWanted } from '../src/platform/probe.ts'
import { bootFraction } from '../src/content/loading.ts'

function fakeSdk(): { calls: string[]; sdk: object } {
  const calls: string[] = []
  const sdk = {
    init(this: unknown, config: unknown) {
      assert.equal(this, sdk)
      calls.push(`init ${JSON.stringify(config)}`)
      return true
    },
    updateLoadProgressZeroToOne(this: unknown, p: number) {
      assert.equal(this, sdk)
      calls.push(`progress ${p}`)
    },
  }
  return { calls, sdk }
}

test('init() is called once, after a final progress of 1, and progress never goes back or follows init', () => {
  const { calls, sdk } = fakeSdk()
  const g = { Wavedash: sdk, location: { hostname: 'abc.builds.wavedashcdn.com' } }
  wavedashProgress(0, g)
  wavedashProgress(0.3, g)
  wavedashProgress(0.2, g)
  wavedashProgress(Number.NaN, g)
  wavedashProgress(7, g)
  assert.equal(wavedashReady(g), 'called')
  assert.equal(wavedashReady(g), 'called')
  wavedashProgress(0.5, g)
  assert.deepEqual(calls, ['progress 0', 'progress 0.3', 'progress 1', 'init {"debug":false}'])
})

test('off Wavedash there is no SDK: every call is a no-op and nothing throws', () => {
  const g = { location: { hostname: 'localhost' } }
  wavedashProgress(0.5, g)
  assert.equal(wavedashReady(g), 'absent')
  assert.equal(wavedashReady({ Wavedash: { init: 3 } }), 'absent')
})

test('a throwing SDK never stops the game', () => {
  const g = { Wavedash: { init() { throw new Error('sdk down') }, updateLoadProgressZeroToOne() { throw new Error('bar down') } } }
  assert.doesNotThrow(() => wavedashProgress(0.4, g))
  assert.equal(wavedashReady(g), 'failed')
  assert.equal(wavedashReady(g), 'failed')
})

test('an SDK without the progress call still gets init()', () => {
  let inits = 0
  const g = { Wavedash: { init() { inits++ } } }
  wavedashProgress(0.5, g)
  assert.equal(wavedashReady(g), 'called')
  assert.equal(inits, 1)
})

test('onWavedashOrigin is builds.wavedashcdn.com and its subdomains only (R9)', () => {
  assert.equal(onWavedashOrigin('x-1.builds.wavedashcdn.com'), true)
  assert.equal(onWavedashOrigin('evilbuilds.wavedashcdn.com'), false)
  assert.equal(onWavedashOrigin('builds.wavedashcdn.com.example.org'), false)
})

test('BootStages logs each stage and names a stage that lasts past the stall limit, once per check', () => {
  let now = 0
  const lines: string[] = []
  const stalls: string[] = []
  const boot = new BootStages((stage, s) => stalls.push(`${stage} ${s}`), () => now, 10_000, line => lines.push(line))
  now = 1500
  boot.enter('content')
  now = 9000
  boot.check()
  assert.deepEqual(stalls, [])
  now = 12_000
  boot.check()
  boot.check()
  assert.deepEqual(stalls, ['content 11', 'content 11'])
  boot.enter('renderer')
  boot.check()
  boot.done()
  now = 99_000
  boot.check()
  assert.equal(stalls.length, 2)
  assert.equal(boot.current, 'done')
  assert.deepEqual(lines, [
    '[boot] +1.5s content (after page: 1.5s)',
    "[boot] stage 'content' has taken 11s",
    '[boot] +12.0s renderer (after content: 10.5s)',
    '[boot] +12.0s done (after renderer: 0.0s)',
  ])
})

test('the frame probe is off by default: ?probe=1 or a VITE_RF_PROBE=1 build, and ?probe=0 overrides the build', () => {
  assert.equal(probeWanted('', undefined), false)
  assert.equal(probeWanted('?entrypoint=game.html&engine=CUSTOM', undefined), false)
  assert.equal(probeWanted('?probe=1', undefined), true)
  assert.equal(probeWanted('', '1'), true)
  assert.equal(probeWanted('?probe=0', '1'), false)
  assert.match(probeLine('ws', { s: 'x'.repeat(500) }), /^ws: \{"s":"x+\.\.\.$/)
})

test('bootFraction rises through the content phases and stays below the renderer steps', () => {
  const order = [
    bootFraction({ phase: 'courses', done: 0, total: 10, label: '' }),
    bootFraction({ phase: 'courses', done: 10, total: 10, label: '' }),
    bootFraction({ phase: 'assets', done: 5, total: 10, label: '' }),
    bootFraction({ phase: 'meshing', done: 1, total: 0, label: '' }),
    bootFraction({ phase: 'meshing', done: 10, total: 10, label: '' }),
    bootFraction({ phase: 'upload', done: 10, total: 10, label: '' }),
    bootFraction({ phase: 'done', done: 0, total: 0, label: '' }),
  ]
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], `${order}`)
  assert.equal(order[0], 0.05)
  assert.equal(order.at(-1), 0.85)
})
