import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { showMaps } from '@royal-fiesta/game/net/zoneRounds'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { ShowContent } from '../src/game/showContent.ts'

// Replace only browser content/render boundaries; transport, full matches and bots are real.
const browser: { content?: ShowContent; ready: () => Promise<void>; disposed: number } = {
  ready: () => Promise.resolve(), disposed: 0,
}
Object.assign(globalThis, { __showModeTest: browser })
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/game/showMode.ts')) {
      const stubs: Record<string, string> = {
        './showContent.ts': 'export const loadShowContent = async () => globalThis.__showModeTest.content',
        '../zone/zoneContent.ts': 'export const zoneContent = async () => ({ assets: () => ({}), bean: {}, character: {}, skinned: undefined, dressing: {}, createPort: async () => ({}) })',
        '../zone/zoneNetScene.ts': `export const prepareZoneNetScene = async () => ({
          attach: () => ({ feed: { far() {}, sleep() {} }, update() {}, render() {},
            ready: () => globalThis.__showModeTest.ready(),
            dispose: () => { globalThis.__showModeTest.disposed++ } }), dispose() {}
        })`,
      }
      if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
const { ShowMode } = await import('../src/game/showMode.ts')
hooks.deregister()
const R = await initRapier()
const root = new URL('../../../', import.meta.url)
const read = (path: string) => readFile(new URL(path.replace(/^courses\//, 'fixtures/test-courses/'), root), 'utf8')
const entries = await Promise.all(['test-flat-race', 'test-flat-survival'].map(async id => {
  const path = `courses/${id}.course.json`
  return { path, json: JSON.parse(await read(path)) as unknown }
}))
const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
const zones = new Map(await Promise.all(courses.map(async course =>
  [course.id, await loadZonesFile(course.id, course, read)] as const)))
browser.content = { courses, zones, season: showMaps(courses), info: () => ({ name: 'Fixture', kind: 'race' }) }

function options(seats = 12) {
  const stage = { style: { display: '' } }
  const canvas = { width: 0, height: 0, dataset: {}, style: { display: '' }, remove() {} }
  const views = {
    clientWidth: 800, clientHeight: 600, querySelectorAll: () => [stage], appendChild() {},
    ownerDocument: { defaultView: { devicePixelRatio: 1 }, createElement: () => canvas },
  } as unknown as HTMLElement
  return { R, views, seats, seed: 3, localName: 'Human' }
}

test('60-seat show builds 15 peers with at most four seats, preserving human seat 0', async () => {
  const mode = await ShowMode.create(options(60))
  try {
    assert.equal(mode.failure, null)
    const roster = mode['roster']!
    assert.equal(roster.peers.length, 15)
    assert.ok(roster.peers.every(peer => peer.seats.length <= 4))
    assert.deepEqual(roster.peers[0].seats, [0, 15, 30, 45])
    assert.equal(new Set(roster.peers.flatMap(peer => peer.seats)).size, 60)
    assert.equal(mode['fulls'].length, 15)
  } finally { mode.dispose() }
  assert.equal(mode['loopback'], null)
})

test('default 12-seat show holds for loading then plays to its first result without refusal', async () => {
  let release!: () => void
  browser.ready = () => new Promise<void>(resolve => { release = resolve })
  const mode = await ShowMode.create(options())
  const human = { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }
  decodeInput(NEUTRAL_CODE, human)
  try {
    // Smallest simulation probe before running the round.
    mode.frame(1 / 60, null, human)
    assert.equal(mode.failure, null)
    for (let frame = 0; frame < 400 && mode.screen() === 'vote'; frame++) mode.frame(1 / 60, null, human)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(mode.screen(), 'countdown')
    assert.equal(mode.models?.hold, true)
    const clock = mode['loopback']!.now()
    mode.frame(10, null, human)
    assert.equal(mode['loopback']!.now(), clock)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    mode.frame(0, null, human)
    assert.equal(mode.models?.countdown?.label, '3')
    assert.equal(mode.hud()?.view.alive, 12)
    for (let frame = 0; frame < 12000 && mode.screen() !== 'result' && mode.failure === null; frame++) {
      mode.frame(1 / 60, null, human)
    }
    assert.equal(mode.failure, null)
    assert.equal(mode.screen(), 'result')
    assert.equal(mode.models?.results?.length, 12)
    assert.equal(mode.models?.hold, true)
  } finally {
    mode.dispose()
    browser.ready = () => Promise.resolve()
  }
  assert.ok(browser.disposed > 0)
})
