import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { loadCourse } from '@royal-fiesta/game/course'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'
import { DEFAULT_LOBBY_BOTS } from '@royal-fiesta/game/hub/hubBots'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { neutralInput } from '@royal-fiesta/sim/input'
import { refuse, RefusalError } from '@royal-fiesta/sim/refusal'
import { HubView } from '../src/play/hubView.ts'

// Execute the page's query parser without importing its Vite-only UI documents.
test('offline page defaults to one lobby bot; URL accepts every integer 0..8', () => {
  const source = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  const intParam = source.match(/function intParam\([\s\S]*?\n\}/)![0]
  const parseQuery = source.match(/function parseQuery\([\s\S]*?\n\}/)![0]
  const parse = new Function('refuse', 'DEFAULT_LOBBY_BOTS', 'LOCAL_LOBBY_WAIT_LOCAL_S', 'LOCAL_LOBBY_WAIT_S',
    stripTypeScriptTypes(intParam + '\n' + parseQuery) + '; return parseQuery')(refuse, DEFAULT_LOBBY_BOTS, 2, 60)
  assert.equal(parse('').lobbybots, 1)
  for (let n = 0; n <= 8; n++) assert.equal(parse(`?lobbybots=${n}`).lobbybots, n)
  for (const value of ['-1', '9', '1.5', 'abc', '']) assert.throws(() => parse(`?lobbybots=${value}`), RefusalError)
})

test('HubView mounts and moves the offline physics bots through the normal player render path', async () => {
  const root = new URL('../../../', import.meta.url)
  const resolver = fixtureResolver(async path => readFileSync(new URL(path, root), 'utf8'))
  const path = 'fixtures/courses/hub-plaza.course.json'
  const plaza = await loadCourse(JSON.parse(readFileSync(new URL(path, root), 'utf8')), path, resolver)
  const bean = (await resolver.resolve('bean')).asset
  const assets = new Map()
  for (const obstacle of plaza.obstacles) assets.set(obstacle.asset, (await resolver.resolve(obstacle.asset)).asset)
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 64, height: 64, viewports: [{ x: 0, y: 0, width: 64, height: 64 }] })
  const R = await initRapier()
  const hub = new HubWorld(R, plaza, 0, DEFAULT_LOBBY_BOTS, 42)
  const view = new HubView(port, 0, id => assets.get(id)!, bean, plaza)
  const local = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 }
  try {
    for (let tick = 0; tick < 180; tick++) {
      hub.step(neutralInput())
      view.update(hub.state(local), 0, hub.botViews(), hub.tick, 1 / 60)
    }
    assert.equal(view.remoteCount, 1)
    assert.equal(port.render().instances, plaza.obstacles.length + 2)
    const tag = view.tags('Player').find(tag => !tag.own)!
    assert.equal(tag.name, 'Bot 1')
    assert.equal(tag.pos.x, hub.botViews()[0].pos.x)
    assert.equal(tag.pos.z, hub.botViews()[0].pos.z)
  } finally { view.dispose(); hub.free(); assert.equal(port.render().instances, 0); port.dispose() }
})
