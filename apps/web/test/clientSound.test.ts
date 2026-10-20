// Headless checks for the client page's sound wiring: the first gesture opens the engine once, nothing
// opens without a gesture, and a failed manifest load warns once without throwing. The engine and the
// fetch are fakes; the Web Audio objects never exist here.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSound } from '@royal-fiesta/game/audio/context'
import { ClientSound, type RfAudioDebug } from '../src/client/sound.ts'

const MANIFEST = 'http://page.test/audio/manifest.json'

interface Fakes {
  opened: number
  closed: number
  fetched: number
  warnings: string[]
  deps: ConstructorParameters<typeof ClientSound>[0]
}

function fakes(opts: { manifest?: 'ok' | 'missing' | 'no-families'; engine?: 'ok' | 'fail' } = {}): Fakes {
  const f: Fakes = {
    opened: 0, closed: 0, fetched: 0, warnings: [],
    deps: {
      manifestUrl: MANIFEST,
      async open(url: string): Promise<BrowserSound> {
        f.opened++
        if (url !== MANIFEST) throw new Error(`engine got ${url}`)
        if ((opts.engine ?? 'ok') === 'fail') throw new Error('no audio device')
        return {
          audio: { ctx: { state: 'running' } },
          port: { play() { return null }, startBed() { return null } },
          close: async () => { f.closed++ },
        } as unknown as BrowserSound
      },
      async fetchJson(url: string): Promise<unknown> {
        f.fetched++
        if (url !== MANIFEST) throw new Error(`fetched ${url}`)
        if ((opts.manifest ?? 'ok') === 'missing') throw new Error('HTTP 404 for audio/manifest.json')
        if ((opts.manifest ?? 'ok') === 'no-families') return { version: 1 }
        return { version: 1, families: [{ id: 'fiesta.jump' }, { id: 'crowd.aww' }] }
      },
      warn(message: string): void { f.warnings.push(message) },
    },
  }
  return f
}

function gesture(target: EventTarget, type: string): void {
  target.dispatchEvent(new Event(type))
}

function debugOf(sound: ClientSound): RfAudioDebug {
  const page: { __rfAudio?: RfAudioDebug } = {}
  sound.expose(page)
  assert.ok(page.__rfAudio, 'expose sets __rfAudio')
  return page.__rfAudio
}

test('no gesture: nothing is fetched or opened, and the debug hook reads the idle state', async () => {
  const f = fakes()
  const sound = new ClientSound(f.deps)
  sound.arm(new EventTarget())
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.opened, 0)
  assert.equal(f.fetched, 0)
  assert.equal(sound.phase, 'idle')
  const debug = debugOf(sound)
  assert.deepEqual({ state: debug.state, loaded: debug.loaded, familiesLoaded: debug.familiesLoaded }, { state: 'none', loaded: false, familiesLoaded: 0 })
})

test('a pointer gesture opens the engine once; later gestures and keys do not reopen it', async () => {
  const f = fakes()
  const sound = new ClientSound(f.deps)
  const target = new EventTarget()
  sound.arm(target)
  gesture(target, 'pointerdown')
  gesture(target, 'pointerdown')
  gesture(target, 'keydown')
  await sound.open()
  assert.equal(f.opened, 1)
  assert.equal(f.fetched, 1)
  assert.equal(sound.phase, 'on')
  const debug = debugOf(sound)
  assert.equal(debug.state, 'running')
  assert.equal(debug.loaded, true)
  assert.equal(debug.familiesLoaded, 2)
  assert.deepEqual(f.warnings, [])
})

test('a key gesture also opens the engine', async () => {
  const f = fakes()
  const sound = new ClientSound(f.deps)
  const target = new EventTarget()
  sound.arm(target)
  gesture(target, 'keydown')
  await sound.open()
  assert.equal(f.opened, 1)
  assert.equal(sound.phase, 'on')
})

test('a failed manifest load does not throw: one warning, the game carries on silently', async () => {
  const f = fakes({ manifest: 'missing' })
  const sound = new ClientSound(f.deps)
  const target = new EventTarget()
  sound.arm(target)
  gesture(target, 'pointerdown')
  await sound.open()
  gesture(target, 'keydown')
  await sound.open()
  assert.equal(sound.phase, 'off')
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /404/)
  const debug = debugOf(sound)
  assert.equal(debug.loaded, false)
  assert.equal(debug.familiesLoaded, 0)
  sound.frame(null)
})

test('a manifest without a families list counts as a failed load and closes the engine it opened', async () => {
  const f = fakes({ manifest: 'no-families' })
  const sound = new ClientSound(f.deps)
  await sound.open()
  assert.equal(f.opened, 1)
  assert.equal(f.closed, 1)
  assert.equal(f.warnings.length, 1)
  assert.equal(sound.loaded, false)
})

test('a failed engine open warns once and does not throw', async () => {
  const f = fakes({ engine: 'fail' })
  const sound = new ClientSound(f.deps)
  await sound.open()
  assert.equal(sound.phase, 'off')
  assert.deepEqual(f.warnings, ['sound is off: no audio device'])
  assert.equal(sound.state, 'none')
})

test('frame before the engine is up is a no-op, with or without a match', async () => {
  const f = fakes({ engine: 'fail' })
  const sound = new ClientSound(f.deps)
  assert.doesNotThrow(() => sound.frame(null))
  await sound.open()
  assert.doesNotThrow(() => sound.frame(null))
})
