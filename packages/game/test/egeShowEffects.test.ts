import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineRoundResult, EngineShowObservation, EngineShowRuntime } from '../src/ege/showTypes.ts'
import { EngineShowEffects } from '../src/ege/showEffects.ts'

const LAYOUT = {
  format: 'ege.layout',
  version: 1,
  key: 1,
  components: [],
  resources: [],
  events: [
    {
      id: 0,
      name: 'finish',
      lane: 'presentation',
      size: 8,
      fields: [
        { name: 'seat', type: 'u32', count: 1, offset: 0 },
        { name: 'crossing', type: 'u32', count: 1, offset: 4 },
      ],
    },
  ],
  input: { axes: [], buttons: [], button_shift: 16 },
  collision_groups: [],
  world_kinds: [],
}

interface FakeEngine {
  exports: { ege_schema_layout: () => number }
  check: (status: number) => void
  resultBytes: () => Uint8Array
  events: (world: number, from: number, confirmed: number) => { dropped: number; records: unknown[] }
  scripted: { dropped: number; records: unknown[] }
}

/** A fake engine: the layout JSON and a scripted event ring returned for every read. */
function fakeEngine(): FakeEngine {
  const bytes = new TextEncoder().encode(JSON.stringify(LAYOUT))
  const engine: FakeEngine = {
    exports: { ege_schema_layout: () => 0 },
    check: () => undefined,
    resultBytes: () => bytes,
    scripted: { dropped: 0, records: [] },
    events: () => engine.scripted,
  }
  return engine
}

function finishPayload(seat: number, crossing: number): Uint8Array {
  const payload = new Uint8Array(8)
  const view = new DataView(payload.buffer)
  view.setUint32(0, seat, true)
  view.setUint32(4, crossing, true)
  return payload
}

function record(tick: number, confirmed: boolean, entity: number, seat: number): unknown {
  return { tick, kind: 0, confirmed, repeat: false, entity, payload: finishPayload(seat, 9) }
}

interface FakeWorld {
  ref: {
    domain: number
    kind: string
    world: number
    binding: { resimulating: boolean }
    timeline: { module: { engine: FakeEngine } }
    confirmedTick: number
    resimulating: boolean
  }
  incarnation: number
  publishers: Map<number, string>
}

/** One physics world whose binding resimulation flag and confirmed tick the test controls. */
function fakeWorld(engine: FakeEngine, world: number, incarnation: number, publisher: string): FakeWorld {
  const binding = { resimulating: false }
  return {
    ref: {
      domain: 1,
      kind: 'seat',
      world,
      binding,
      timeline: { module: { engine } },
      confirmedTick: 100,
      resimulating: false,
    },
    incarnation,
    publishers: new Map([[4, publisher]]),
  }
}

function result(endTick: number): EngineRoundResult {
  return {
    index: 0,
    map: 'm',
    course: 'c',
    kind: 'race',
    final: false,
    playoff: false,
    endTick,
    reason: 'target',
    ranking: [],
    qualified: [],
    eliminated: [],
    points: [],
    teamScores: [],
    champion: -1,
  } as unknown as EngineRoundResult
}

/** A runtime double with a scripted presentation, snapshot results and synchronous observation. */
class FakeRuntime {
  showId = 'show-a'
  worldsList: FakeWorld[] = []
  results: EngineRoundResult[] = []
  globalConfirmed = 0
  listeners: Array<(observation: EngineShowObservation) => void> = []

  onPresentation(listener: (observation: EngineShowObservation) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener)
    }
  }

  presentation() {
    return {
      showId: this.showId,
      tick: 0,
      round: 1,
      map: null,
      course: null,
      worlds: this.worldsList,
    }
  }

  snapshot() {
    return { tick: 0, round: 1, screen: 'results', seatOf: [], alive: [], candidates: [], results: this.results, champion: null, faults: 0 }
  }

  worlds() {
    const physics = this.worldsList.map((item) => item.ref)
    return [...physics, { kind: 'global', domain: 0, world: 1, confirmedTick: this.globalConfirmed, resimulating: false, binding: { resimulating: false } }]
  }

  notify(kind: 'post-tick' | 'before-release'): void {
    const observation = { kind, tick: 0, snapshot: this.snapshot(), presentation: this.presentation() }
    for (const listener of [...this.listeners]) listener(observation as unknown as EngineShowObservation)
  }

  asRuntime(): EngineShowRuntime {
    return this as unknown as EngineShowRuntime
  }
}

function setup() {
  const engine = fakeEngine()
  const runtime = new FakeRuntime()
  const sounds: Array<{ name: string; payload: Record<string, number> }> = []
  const grants: Array<{ receipt: string; result: EngineRoundResult }> = []
  const effects = new EngineShowEffects(runtime.asRuntime(), {
    sound: (name, payload) => sounds.push({ name, payload: { ...payload } }),
    grant: (receipt, value) => grants.push({ receipt, result: value }),
  })
  runtime.worldsList = [fakeWorld(engine, 7, 1, 'pub-a')]
  return { engine, runtime, sounds, grants, effects }
}

test('confirmed events play sound once with decoded payload', () => {
  const { engine, runtime, sounds, effects } = setup()
  engine.scripted = { dropped: 0, records: [record(3, false, 4, 2), record(3, true, 4, 5)] }
  effects.pump()
  assert.deepEqual(sounds, [{ name: 'finish', payload: { seat: 5, crossing: 9 } }])
  assert.equal(effects.deliveryStats().repeatedSoundDeliveries, 0)
  runtime.notify('post-tick')
  assert.equal(sounds.length, 1)
  effects.dispose()
})

test('replay is silent and the drain resumes after it', () => {
  const { engine, runtime, sounds, effects } = setup()
  engine.scripted = { dropped: 0, records: [record(3, true, 4, 1)] }
  runtime.worldsList[0].ref.binding.resimulating = true
  effects.pump()
  assert.equal(sounds.length, 0)
  runtime.worldsList[0].ref.binding.resimulating = false
  effects.pump()
  assert.equal(sounds.length, 1)
  effects.dispose()
})

test('repeated pumps and repeated notifications deliver each receipt once', () => {
  const { engine, runtime, sounds, effects } = setup()
  engine.scripted = { dropped: 0, records: [record(2, true, 4, 1), record(5, true, 4, 1)] }
  effects.pump()
  effects.pump()
  runtime.notify('post-tick')
  runtime.notify('before-release')
  assert.equal(sounds.length, 2)
  assert.deepEqual(effects.deliveryStats(), { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 })
  effects.dispose()
})

test('the same publisher after world replacement keeps its receipt', () => {
  const { engine, runtime, sounds, effects } = setup()
  engine.scripted = { dropped: 0, records: [record(4, true, 4, 1)] }
  runtime.notify('post-tick')
  runtime.notify('before-release')
  runtime.worldsList = [fakeWorld(engine, 8, 2, 'pub-a')]
  runtime.notify('post-tick')
  assert.equal(sounds.length, 1)
  effects.dispose()
})

test('a terminal event inside an eight-tick frame is delivered before release', () => {
  const { engine, runtime, sounds, effects } = setup()
  for (let tick = 1; tick <= 8; tick++) {
    const records = tick === 8 ? [record(8, true, 4, 3)] : []
    engine.scripted = { dropped: 0, records }
    runtime.worldsList[0].ref.confirmedTick = tick
    runtime.notify('post-tick')
  }
  runtime.notify('before-release')
  assert.deepEqual(sounds.map((item) => item.payload.seat), [3])
  effects.dispose()
})

test('a changed show identity clears receipts and diagnostics', () => {
  const { engine, runtime, sounds, effects } = setup()
  engine.scripted = { dropped: 0, records: [record(2, true, 4, 1)] }
  effects.pump()
  runtime.showId = 'show-b'
  effects.pump()
  assert.equal(sounds.length, 2)
  effects.dispose()
})

test('dropped records surface as a failure and are counted', () => {
  const { engine, sounds, effects } = setup()
  engine.scripted = { dropped: 2, records: [] }
  assert.throws(() => effects.pump(), /dropped/)
  assert.equal(effects.deliveryStats().droppedRecords, 2)
  assert.equal(sounds.length, 0)
  effects.dispose()
})

test('grants come only from confirmed results and never during resimulation', () => {
  const { runtime, grants, effects } = setup()
  runtime.results = [result(50)]
  runtime.globalConfirmed = 50
  effects.pump()
  assert.equal(grants.length, 0)
  runtime.globalConfirmed = 51
  effects.pump()
  effects.pump()
  assert.equal(grants.length, 1)
  assert.equal(grants[0].receipt.endsWith('|50|grant'), true)
  effects.dispose()
})

test('dispose unsubscribes and then refuses further pumps', () => {
  const { runtime, sounds, effects } = setup()
  effects.dispose()
  effects.dispose()
  assert.equal(runtime.listeners.length, 0)
  assert.throws(() => effects.pump(), /disposed/)
  assert.equal(sounds.length, 0)
})
