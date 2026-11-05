// The Wavedash loader contract (apps/web/src/platform/wavedash.ts): the shell keeps the frame hidden until init().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BootStages, onWavedashOrigin, wavedashReady, wavedashUsername } from '../src/platform/wavedash.ts'
import { probeLine, probeWanted } from '../src/platform/probe.ts'

function fakeSdk(): { calls: string[]; sdk: object } {
  const calls: string[] = []
  const sdk = {
    init(this: unknown, config: unknown) {
      assert.equal(this, sdk)
      calls.push(`init ${JSON.stringify(config)}`)
      return true
    },
  }
  return { calls, sdk }
}

test('init() is called once per page', () => {
  const { calls, sdk } = fakeSdk()
  const g = { Wavedash: sdk, location: { hostname: 'abc.builds.wavedashcdn.com' } }
  assert.equal(wavedashReady(g), 'called')
  assert.equal(wavedashReady(g), 'called')
  assert.deepEqual(calls, ['init {"debug":false}'])
})

test('off Wavedash there is no SDK: every call is a no-op and nothing throws', () => {
  const g = { location: { hostname: 'localhost' } }
  assert.equal(wavedashReady(g), 'absent')
  assert.equal(wavedashReady({ Wavedash: { init: 3 } }), 'absent')
})

test('a throwing SDK never stops the game', () => {
  const g = { Wavedash: { init() { throw new Error('sdk down') } } }
  assert.equal(wavedashReady(g), 'failed')
  assert.equal(wavedashReady(g), 'failed')
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

test('player name: getUsername(), else getUser().username, cleaned; null off Wavedash or on a failing SDK; never the user id', () => {
  const init = () => true
  assert.equal(wavedashUsername({}), null)
  let idRead = false
  const sdk = { init, getUsername: () => '  Kev\u0007in  ', getUserId: () => { idRead = true; return 'u-123' } }
  assert.equal(wavedashUsername({ Wavedash: sdk }), 'Kevin')
  assert.equal(idRead, false)
  assert.equal(wavedashUsername({ Wavedash: { init, getUsername: () => null, getUser: () => ({ username: 'Ann', id: 'u-9' }) } }), 'Ann')
  assert.equal(wavedashUsername({ Wavedash: { init, getUser: () => ({ username: 'y'.repeat(40) }) } }), 'y'.repeat(24))
  assert.equal(wavedashUsername({ Wavedash: { init, getUsername: () => '' } }), null)
  assert.equal(wavedashUsername({ Wavedash: { init, getUsername: () => { throw new Error('not signed in') } } }), null)
})
