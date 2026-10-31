// Headless boot check for the game page's sound driver. A fake BaseAudioContext records every
// AudioParam schedule, so createMixGraph proves the bus trims, the count-go duck and the
// limiter. A recording port and a fixture match prove the lobby cue and the listener fan-out.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import type { BrowserAudioOptions, BrowserSound } from '@royal-fiesta/game/audio/context'
import { soundDef } from '@royal-fiesta/game/audio/catalog'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import type { CourseAudio, SoundPort } from '@royal-fiesta/game/audio/gameAudio'
import { BUS_GAIN_DB, dbToGain, LIMITER_CEILING_DB } from '@royal-fiesta/game/audio/mix/buses'
import {
  AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES, type BusVolumes,
} from '@royal-fiesta/game/audio/mix/volumes'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { createMatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import { createMixGraph } from '../src/audio/mixGraph.ts'
import { SoundDriver } from '../src/play/sound.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8')
const R = await initRapier()

interface ParamCall { kind: 'set' | 'target' | 'ramp' | 'cancel'; value: number; time: number }

class FakeParam {
  value: number
  readonly calls: ParamCall[] = []
  constructor(value = 1) { this.value = value }
  setValueAtTime(value: number, time: number): FakeParam {
    this.value = value
    this.calls.push({ kind: 'set', value, time })
    return this
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): FakeParam {
    void timeConstant
    this.calls.push({ kind: 'target', value, time })
    return this
  }
  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.value = value
    this.calls.push({ kind: 'ramp', value, time })
    return this
  }
  cancelScheduledValues(time: number): FakeParam {
    this.calls.push({ kind: 'cancel', value: this.value, time })
    return this
  }
}

class FakeNode {
  readonly outputs = new Set<FakeNode>()
  connect(dest: FakeNode): FakeNode {
    this.outputs.add(dest)
    return dest
  }
  disconnect(): void { this.outputs.clear() }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1)
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(0)
  readonly knee = new FakeParam(0)
  readonly ratio = new FakeParam(1)
  readonly attack = new FakeParam(0)
  readonly release = new FakeParam(0)
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0)
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null
  loop = false
  onended: (() => void) | null = null
  readonly playbackRate = new FakeParam(1)
  start(): void {}
  stop(): void {}
}

function fakeContext() {
  const destination = new FakeNode()
  const gains: FakeGain[] = []
  const compressors: FakeCompressor[] = []
  const panners: FakePanner[] = []
  const sources: FakeSource[] = []
  let resumed = 0
  let closed = 0
  const ctx = {
    destination,
    currentTime: 0,
    state: 'running' as AudioContextState,
    sampleRate: 48000,
    createGain(): FakeGain { const node = new FakeGain(); gains.push(node); return node },
    createDynamicsCompressor(): FakeCompressor {
      const node = new FakeCompressor()
      compressors.push(node)
      return node
    },
    createStereoPanner(): FakePanner { const node = new FakePanner(); panners.push(node); return node },
    createBufferSource(): FakeSource { const node = new FakeSource(); sources.push(node); return node },
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
      return Promise.resolve({ duration: data.byteLength / 48000 } as AudioBuffer)
    },
    resume(): Promise<void> { resumed++; return Promise.resolve() },
    close(): Promise<void> { closed++; return Promise.resolve() },
  }
  return {
    ctx, gains, compressors, panners, sources,
    get resumed(): number { return resumed },
    get closed(): number { return closed },
  }
}

function recordingPort(duck: (id: string) => void) {
  const played: string[] = []
  const started: string[] = []
  const listeners: ListenerPose[][] = []
  const port: SoundPort = {
    play(id) { played.push(id); duck(id) },
    startLoop(id) {
      started.push(id)
      duck(id)
      return { set() {}, move() {}, stop() {} }
    },
    setListeners(ls) { listeners.push(ls.map(l => ({ ...l }))) },
  }
  return { port, played, started, listeners }
}

function fixture(raw: string | null = null) {
  const target = new EventTarget()
  let stored = raw
  const context = fakeContext()
  const graph = createMixGraph(context.ctx as unknown as BaseAudioContext)
  const volumes: BusVolumes[] = []
  const mix = { ...graph, setVolumes(v: BusVolumes) { volumes.push(v); graph.setVolumes(v) } }
  const recording = recordingPort(mix.duck)
  const opened: BrowserAudioOptions[] = []
  const wasm: string[] = []
  const courseListeners: ListenerPose[][] = []
  let closed = 0
  let disposed = 0
  const course: CourseAudio = {
    apply() {},
    setListeners(ls) { courseListeners.push(ls.map(l => ({ ...l }))) },
    dispose() { disposed++ },
  }
  const sound: BrowserSound = {
    ctx: context.ctx as unknown as BaseAudioContext,
    mix,
    output: mix.input('sfx'),
    port: recording.port,
    soundsLoaded: 0,
    async close() { closed++; mix.dispose(); await context.ctx.close() },
  }
  const driver = new SoundDriver({
    target,
    baseUrl: 'https://page.test/sub/',
    store: {
      getItem(key) { assert.equal(key, AUDIO_SETTINGS_KEY); return stored },
      setItem() {},
    },
    async open(options) { opened.push(options); return sound },
    async compileWasm(url) { wasm.push(url); return {} as WebAssembly.Module },
    async patches() { return new Map() },
  })
  return {
    driver, target, context, mix, volumes, course, courseListeners,
    ...recording, opened, wasm,
    setRaw(value: string | null) { stored = value },
    get closed(): number { return closed },
    get disposed(): number { return disposed },
  }
}

function closeTo(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`)
}

function lastParam(param: FakeParam, kind: ParamCall['kind']): ParamCall {
  const call = param.calls.filter(c => c.kind === kind).at(-1)
  assert.ok(call, `no ${kind} call recorded`)
  return call
}

const fakeSim = {
  setup: { playerCount: 1 }, tick: 0,
  course: () => null,
  phase: () => ({ phase: Phase.intro, roundKind: 'race', final: false }),
  character(_p: number, out: CharacterView) {
    Object.assign(out.pos, { x: 7, y: 8, z: 9 })
    Object.assign(out.facing, { x: -1, z: 0 })
    return out
  },
} as unknown as MatchSim

const poses: ListenerPose[] = Array.from({ length: 4 }, (_, i) => ({ x: i * 3, y: i, z: -i, fx: i % 2, fz: 1 - i % 2 }))

async function fixtureMatch(): Promise<MatchSim> {
  const entries: { path: string; json: unknown }[] = []
  for (const id of ['race-sprint', 'survival-sprint']) {
    const path = `fixtures/courses/${id}.course.json`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
  return createMatchSim(R, netSetup(8, 1, 'sprint', courses))
}

test('the first pointer gesture boots the game page audio without console errors', async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const f = fixture(JSON.stringify({ music: 0.5 }))
  assert.equal(f.opened.length, 0)
  f.target.dispatchEvent(new Event('pointerdown'))
  await assert.doesNotReject(f.driver.open())
  assert.equal(f.opened.length, 1)
  assert.deepEqual(f.opened[0], {
    manifestUrl: 'https://page.test/sub/audio/manifest.json',
    processorUrl: 'https://page.test/sub/audio/haa-processors.js',
    maxListeners: 4,
  })
  assert.deepEqual(f.wasm, ['https://page.test/sub/audio/haa.wasm'])
  f.target.dispatchEvent(new Event('pointerdown'))
  await f.driver.open()
  assert.equal(f.opened.length, 1, 'later gestures reuse the first open')
  assert.deepEqual(errors, [])
  f.driver.setCourseAudio(f.course)
  await f.driver.close()
  assert.equal(f.closed, 1)
  assert.equal(f.context.closed, 1)
  assert.equal(f.disposed, 1)
})

test('lobby music runs on the music bus; the stored music volume scales it; count-go ducks it', async () => {
  const f = fixture(JSON.stringify({ music: 0.5 }))
  f.target.dispatchEvent(new Event('pointerdown'))
  await f.driver.open()
  f.driver.frame(null)
  assert.ok(f.started.includes('music.candy.lobby'), 'the lobby frame starts the lobby cue')
  assert.equal(soundDef('music.candy.lobby').bus, 'music')

  const music = f.mix.input('music') as unknown as FakeGain
  assert.equal(f.volumes.at(-1)?.music, 0.5)
  closeTo(lastParam(music.gain, 'target').value, dbToGain(BUS_GAIN_DB.music) * 0.5, 'music bus gain')

  assert.equal(f.context.compressors.length, 1)
  assert.equal(f.context.compressors[0].threshold.value, -1)
  assert.equal(LIMITER_CEILING_DB, -1)

  const musicDuck = [...music.outputs][0] as FakeGain
  f.port.play('flow.count-go')
  assert.deepEqual(f.played, ['flow.count-go'])
  const ramps = musicDuck.gain.calls.filter(c => c.kind === 'ramp')
  assert.equal(ramps.length, 2)
  closeTo(ramps[0].value, dbToGain(-10), 'count-go ducks music by 10 dB')
  closeTo(ramps[0].time, 0.05, 'duck attack')
  closeTo(ramps[1].value, 1, 'duck release')
  await f.driver.close()
})

test('the listener adapter forwards one or four poses and bounds empty or extra listeners', async () => {
  const f = fixture(null)
  await f.driver.open()
  f.driver.setCourseAudio(f.course)
  for (const input of [poses[0], poses, [...poses, poses[0]]]) {
    f.driver.frame(fakeSim, input)
    const expected = Array.isArray(input) ? input.slice(0, 4) : [input]
    assert.deepEqual(f.listeners.at(-1), expected)
    assert.deepEqual(f.courseListeners.at(-1), expected)
  }
  for (const input of [undefined, []]) {
    f.driver.frame(fakeSim, input)
    const expected = [{ x: 7, y: 8, z: 9, fx: -1, fz: 0 }]
    assert.deepEqual(f.listeners.at(-1), expected)
    assert.deepEqual(f.courseListeners.at(-1), expected)
  }
  await f.driver.close()
})

test('a null sim observes the lobby screen and starts lobby music', async () => {
  const f = fixture(null)
  await f.driver.open()
  f.driver.frame(null)
  assert.deepEqual(f.listeners.at(-1), [{ x: 0, y: 0, z: 0, fx: 0, fz: 1 }])
  assert.deepEqual(f.started, ['music.candy.lobby'])
  f.driver.frame(fakeSim)
  assert.ok(f.started.includes('music.candy.race'))
  f.driver.frame(null)
  assert.equal(f.started.at(-1), 'music.candy.lobby')
  await f.driver.close()
})

test('a fixture match with two listeners does not throw and sets both listener ports', async () => {
  const f = fixture(null)
  f.target.dispatchEvent(new Event('pointerdown'))
  await f.driver.open()
  f.driver.setCourseAudio(f.course)
  const sim = await fixtureMatch()
  const two = [poses[0], poses[1]]
  try {
    assert.doesNotThrow(() => f.driver.frame(sim, two))
  } finally {
    sim.free()
  }
  assert.equal(f.listeners.length + f.courseListeners.length, 2, 'game audio and course audio each get the listeners')
  assert.deepEqual(f.listeners[0], two)
  assert.deepEqual(f.courseListeners[0], two)
  assert.equal(f.disposed, 0)
  await f.driver.close()
  assert.equal(f.disposed, 1)
})

test('volumes update only on storage changes; invalid JSON restores defaults and warns once', async (t) => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  const f = fixture(null)
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
