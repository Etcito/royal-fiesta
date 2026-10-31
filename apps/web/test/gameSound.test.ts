import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSound } from '@royal-fiesta/game/audio/context'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES, type BusVolumes } from '@royal-fiesta/game/audio/mix/volumes'
import { Phase, type CharacterView, type MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { SoundDriver } from '../src/play/sound.ts'

function fixture() {
  const target = new EventTarget()
  const listeners: ListenerPose[][] = []
  const courseListeners: ListenerPose[][] = []
  const loops: string[] = []
  const volumes: BusVolumes[] = []
  const urls: string[] = []
  let raw: string | null = null
  let opened = 0
  let closed = 0
  let disposed = 0
  const sound: BrowserSound = {
    ctx: {} as BaseAudioContext, output: {} as AudioNode, soundsLoaded: 0,
    mix: { input(bus) { assert.equal(bus, 'sfx'); return {} as AudioNode },
      setVolumes(v) { volumes.push(v) }, duck() {}, dispose() {} },
    port: {
      play() {},
      startLoop(id) { loops.push(id); return { set() {}, move() {}, stop() {} } },
      setListeners(ls) { listeners.push(ls.map(l => ({ ...l }))) },
    },
    async close() { closed++ },
  }
  const driver = new SoundDriver({
    target, baseUrl: 'https://page.test/sub/',
    store: { getItem(key) { assert.equal(key, AUDIO_SETTINGS_KEY); return raw }, setItem() {} },
    async open(options) {
      opened++
      assert.deepEqual(options, {
        manifestUrl: 'https://page.test/sub/audio/manifest.json',
        processorUrl: 'https://page.test/sub/audio/haa-processors.js', maxListeners: 4,
      })
      return sound
    },
    async compileWasm(url) { urls.push(url); return {} as WebAssembly.Module },
    async patches() { return new Map() },
  })
  return {
    driver, target, listeners, courseListeners, loops, volumes, urls,
    get opened() { return opened }, get closed() { return closed }, get disposed() { return disposed },
    setRaw(value: string | null) { raw = value },
    course() {
      driver.setCourseAudio({ apply() {}, dispose() { disposed++ },
        setListeners(ls) { courseListeners.push(ls.map(l => ({ ...l }))) } })
    },
  }
}

const poses: ListenerPose[] = Array.from({ length: 4 }, (_, i) => ({ x: i * 3, y: i, z: -i, fx: i % 2, fz: 1 - i % 2 }))
const sim = {
  setup: { playerCount: 1 }, tick: 0,
  course: () => null,
  phase: () => ({ phase: Phase.intro, roundKind: 'race', final: false }),
  character(_p: number, out: CharacterView) {
    Object.assign(out.pos, { x: 7, y: 8, z: 9 })
    Object.assign(out.facing, { x: -1, z: 0 })
    return out
  },
} as unknown as MatchSim

test('first pointer or key opens once, using baked URLs, and close disposes', async () => {
  for (const gesture of ['pointerdown', 'keydown']) {
    const f = fixture()
    f.driver.frame(null)
    assert.equal(f.opened, 0)
    f.target.dispatchEvent(new Event(gesture))
    await f.driver.open()
    f.target.dispatchEvent(new Event('keydown'))
    assert.equal(f.opened, 1)
    assert.deepEqual(f.urls, ['https://page.test/sub/audio/haa.wasm'])
    f.course()
    await f.driver.close()
    assert.equal(f.closed, 1)
    assert.equal(f.disposed, 1)
  }
})

test('adapter forwards one or four poses to both ports and bounds empty/extra listeners', async () => {
  const f = fixture()
  await f.driver.open()
  f.course()
  for (const input of [poses[0], poses, [...poses, poses[0]]]) {
    f.driver.frame(sim, input)
    const expected = Array.isArray(input) ? input.slice(0, 4) : [input]
    assert.deepEqual(f.listeners.at(-1), expected)
    assert.deepEqual(f.courseListeners.at(-1), expected)
  }
  for (const input of [undefined, []]) {
    f.driver.frame(sim, input)
    const expected = [{ x: 7, y: 8, z: 9, fx: -1, fz: 0 }]
    assert.deepEqual(f.listeners.at(-1), expected)
    assert.deepEqual(f.courseListeners.at(-1), expected)
  }
  await f.driver.close()
})

test('null sim observes the lobby screen and starts lobby music', async () => {
  const f = fixture()
  await f.driver.open()
  f.driver.frame(null)
  assert.deepEqual(f.listeners.at(-1), [{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
  assert.deepEqual(f.loops, ['music.candy.lobby'])
  f.driver.frame(sim)
  assert.ok(f.loops.includes('music.candy.race'))
  f.driver.frame(null)
  assert.equal(f.loops.at(-1), 'music.candy.lobby')
  await f.driver.close()
})

test('volumes update only on storage changes; invalid JSON restores defaults and warns once', async t => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  const f = fixture()
  await f.driver.open()
  f.driver.frame(null)
  f.driver.frame(null)
  assert.deepEqual(f.volumes, [DEFAULT_BUS_VOLUMES])
  f.setRaw(JSON.stringify({ music: 0.2 }))
  f.driver.frame(null)
  assert.equal(f.volumes.at(-1)?.music, 0.2)
  f.setRaw('{')
  f.driver.frame(null)
  f.driver.frame(null)
  assert.equal(f.volumes.length, 3)
  assert.deepEqual(f.volumes.at(-1), DEFAULT_BUS_VOLUMES)
  f.setRaw('invalid')
  f.driver.frame(null)
  assert.equal(warnings.length, 1)
  f.setRaw(null)
  f.driver.frame(null)
  assert.deepEqual(f.volumes.at(-1), DEFAULT_BUS_VOLUMES)
  await f.driver.close()
})
