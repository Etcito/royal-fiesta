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
const browser: {
  content?: ShowContent; ready: () => Promise<void>; disposed: number
  configs: { voteMs: number | undefined; intermissionMs: number | undefined }[]
} = {
  ready: () => Promise.resolve(), disposed: 0, configs: [],
}
Object.assign(globalThis, { __showModeTest: browser })
// The real full match, wrapped so a test can see the config ShowMode hands it.
const fullMatch = new URL('../../../packages/game/src/net/zoneFullMatch.ts', import.meta.url).href
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
        '@royal-fiesta/game/net/zoneFullMatch': `import * as real from ${JSON.stringify(fullMatch)}
export const createZoneFullMatch = (R, cfg, net) => {
  globalThis.__showModeTest.configs.push({ voteMs: cfg.voteMs, intermissionMs: cfg.intermissionMs })
  return real.createZoneFullMatch(R, cfg, net)
}`,
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
// Three eligible race maps, so a non-final vote has the three candidates the plan offers.
const season = showMaps(courses)
const race = season.find(map => map.kind === 'race')!
season.push({ ...race, id: 'race-choice-2' }, { ...race, id: 'race-choice-3' })
browser.content = { courses, zones, season, info: () => ({ name: 'Fixture', kind: 'race' }) }

function options(seats = 12) {
  const stage = { style: { display: '' } }
  const canvas = { width: 0, height: 0, dataset: {}, style: { display: '' }, remove() {} }
  const views = {
    clientWidth: 800, clientHeight: 600, querySelectorAll: () => [stage], appendChild() {},
    ownerDocument: { defaultView: { devicePixelRatio: 1 }, createElement: () => canvas },
  } as unknown as HTMLElement
  return { R, views, seats, seed: 3, localName: 'Human' }
}

function neutralInput() {
  const human = { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }
  decodeInput(NEUTRAL_CODE, human)
  return human
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

test('voteMs and intermissionMs reach createZoneFullMatch, and voteMs sets the stepped vote window', async () => {
  browser.configs.length = 0
  const mode = await ShowMode.create({ ...options(), voteMs: 250, intermissionMs: 75 })
  const human = neutralInput()
  try {
    assert.equal(mode.failure, null)
    assert.equal(mode.screen(), 'vote')
    const expected = { voteMs: 250, intermissionMs: 75 }
    assert.deepEqual(browser.configs, [expected, expected, expected])
    mode.frame(0.1, null, human)
    mode.frame(0.1, null, human)
    assert.equal(mode.screen(), 'vote', '200 ms of stepped time is inside the 250 ms vote')
    mode.frame(0.1, null, human)
    assert.notEqual(mode.screen(), 'vote', '300 ms of stepped time closes the 250 ms vote')
  } finally { mode.dispose() }
})

test('without voteMs or intermissionMs the show keeps 5000 ms and 12000 ms', async () => {
  browser.configs.length = 0
  const mode = await ShowMode.create(options())
  const human = neutralInput()
  try {
    assert.equal(mode.failure, null)
    const expected = { voteMs: 5000, intermissionMs: 12000 }
    assert.deepEqual(browser.configs, [expected, expected, expected])
    for (let frame = 0; frame < 49; frame++) mode.frame(0.1, null, human)
    assert.equal(mode.screen(), 'vote', '4900 ms of stepped time is inside the default vote')
    mode.frame(0.1, null, human)
    assert.notEqual(mode.screen(), 'vote', '5000 ms of stepped time closes the default vote')
  } finally { mode.dispose() }
})

test('a full offline show retains early world readiness through results and reaches its winner', async () => {
  const mode = await ShowMode.create({ ...options(), voteMs: 1000, intermissionMs: 0 })
  const human = neutralInput()
  const visited = new Set<string>()
  try {
    for (let frame = 0; frame < 30000 && !mode.finished && mode.failure === null; frame++) {
      mode.frame(3 / 60, null, human)
      visited.add(mode.screen())
      if (frame % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(mode.failure, null)
    assert.ok(mode.finished, JSON.stringify({ screen: mode.screen(), models: mode.models, index: mode['index'],
      peers: mode['fulls'].map(full => ({ done: full.done, alive: full.alive, round: full.round?.plan.index, results: full.show.rounds.length, candidates: full.candidates })) }))
    assert.ok(visited.has('podium'))
    assert.ok(visited.has('endScreen'))
  } finally { mode.dispose() }
})
