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

function fakes(opts: { manifest?: 'ok' | 'missing' | 'no-sounds'; engine?: 'ok' | 'fail' } = {}): Fakes {
  const f: Fakes = {
    opened: 0, closed: 0, fetched: 0, warnings: [],
    deps: {
      manifestUrl: MANIFEST,
      async open(url: string): Promise<BrowserSound> {
        f.opened++
        if (url !== MANIFEST) throw new Error(`engine got ${url}`)
        if ((opts.engine ?? 'ok') === 'fail') throw new Error('no audio device')
        return {
          ctx: { state: 'running' } as BaseAudioContext,
          mix: { input: () => ({} as AudioNode), setVolumes() {}, duck() {}, dispose() {} },
          output: {} as AudioNode,
          soundsLoaded: 2,
          port: { play() {}, startLoop() { return null }, setListeners() {} },
          close: async () => { f.closed++ },
        }
      },
      async fetchJson(url: string): Promise<unknown> {
        f.fetched++
        if (url !== MANIFEST) throw new Error(`fetched ${url}`)
        if ((opts.manifest ?? 'ok') === 'missing') throw new Error('HTTP 404 for audio/manifest.json')
        if ((opts.manifest ?? 'ok') === 'no-sounds') return { version: 1 }
        return { format: 'royal-fiesta.audio', version: 1, sampleRate: 48000, sounds: [
          { id: 'move.jump', bus: 'sfx', mode: 'oneshot', files: ['move.jump.0.wav'], patch: null },
          { id: 'crowd', bus: 'crowd', mode: 'loop', files: [], patch: 'audio/crowd.haa.json' },
        ] }
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

test('a manifest without a sounds list counts as a failed load and closes the engine it opened', async () => {
  const f = fakes({ manifest: 'no-sounds' })
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

test('browser context caches WAVs, caps voices, spatialises, and cancels pending loops', async () => {
  const { openBrowserAudio, setMixFactory } = await import('@royal-fiesta/game/audio/context')
  const { createMixGraph } = await import('../src/audio/mixGraph.ts')
  const saved = Object.fromEntries(['AudioContext', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const requests: string[] = []
  const sources: FakeNode[] = []
  const gains: FakeNode[] = []
  const pans: FakeNode[] = []
  const ducks: string[] = []
  let decodes = 0
  let closed = 0
  let disposed = 0
  const param = () => ({ value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} })
  class FakeNode {
    gain = param()
    pan = param()
    playbackRate = param()
    loop = false
    buffer: unknown
    onended: (() => void) | null = null
    started = false
    stopped = false
    connect(node: FakeNode) { return node }
    disconnect() {}
    start() { this.started = true }
    stop() { this.stopped = true }
  }
  const output = new FakeNode()
  class FakeContext {
    state = 'suspended'
    currentTime = 0
    createGain() { const node = new FakeNode(); gains.push(node); return node }
    createStereoPanner() { const node = new FakeNode(); pans.push(node); return node }
    createBufferSource() { const node = new FakeNode(); sources.push(node); return node }
    async decodeAudioData(bytes: ArrayBuffer) { decodes++; return { file: new Uint8Array(bytes)[0] } }
    async resume() { this.state = 'running' }
    async close() { closed++; this.state = 'closed' }
  }
  const manifest = {
    format: 'royal-fiesta.audio', version: 1, sounds: [
      { id: 'move.step.candy', bus: 'sfx', mode: 'oneshot', files: ['step.0.wav', 'step.1.wav'], patch: null },
      { id: 'music.candy.lobby', bus: 'music', mode: 'loop', files: ['music.wav'], patch: null },
    ],
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  try {
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://page.test/game/' } })
    globalThis.fetch = async input => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest))
      if (url.endsWith('haa.wasm')) return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      return new Response(new Uint8Array([url.endsWith('step.1.wav') ? 1 : 0]))
    }
    setMixFactory(() => ({ input: () => output as unknown as AudioNode, setVolumes() {}, duck(id) { ducks.push(id) }, dispose() { disposed++ } }))
    const sound = await openBrowserAudio({ manifestUrl: 'audio/manifest.json', processorUrl: 'processor.js' })
    assert.equal(sound.ctx.state, 'running')
    assert.equal(sound.soundsLoaded, 2)
    assert.equal(decodes, 0, 'opening does not decode WAVs')
    assert.ok(requests.includes('https://page.test/game/audio/haa.wasm'))
    sound.port.setListeners([{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
    for (let i = 0; i < 4; i++) {
      sound.port.play('move.step.candy', { pos: { x: 4, y: 0, z: 0 }, strength: 0.5 })
      await tick()
    }
    assert.equal(decodes, 2, 'all variants are decoded once')
    for (let i = 1; i < 4; i++) assert.notEqual(sources[i].buffer, sources[i - 1].buffer)
    assert.equal(gains[0].gain.value, 0.25)
    assert.equal(pans[0].pan.value, 1)
    assert.equal(sources[0].playbackRate.value, 1)
    for (let i = 0; i < 46; i++) sound.port.play('move.step.candy')
    await tick()
    assert.equal(sources.filter(source => source.started && !source.stopped).length, 48)
    assert.equal(sources[0].stopped, true)
    assert.equal(sound.port.startLoop('unknown'), null)
    const cancelled = sound.port.startLoop('music.candy.lobby')!
    cancelled.stop()
    await tick()
    assert.equal(sources.filter(source => source.loop).length, 0)
    const loop = sound.port.startLoop('music.candy.lobby')!
    await tick()
    assert.equal(sources.at(-1)!.loop, true)
    assert.ok(ducks.includes('music.candy.lobby'))
    loop.stop()
    assert.equal(sources.at(-1)!.stopped, true)
    await sound.close()
    await sound.close()
    assert.equal(closed, 1)
    assert.equal(disposed, 1)
    assert.ok(sources.every(source => source.stopped))
  } finally {
    setMixFactory(createMixGraph)
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
