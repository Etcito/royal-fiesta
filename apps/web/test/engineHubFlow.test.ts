import assert from 'node:assert/strict'
import test from 'node:test'
import { EngineHubFlow } from '../../../packages/game/src/ege/hubFlow.ts'
import type { HubRuntime } from '../../../packages/game/src/ege/hub.ts'
import type { EngineShowRuntime } from '../../../packages/game/src/ege/showTypes.ts'
import { encodeInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'

const IDLE: PlayerInput = { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }
const WALK: PlayerInput = { moveX: 0.5, moveZ: 0, jump: false, dive: false, grab: true }

function fakeHub() {
  const hub = {
    tick: 0,
    botCount: 0,
    spawn: 3,
    faults: 0,
    steps: 0,
    respawns: [] as number[],
    frees: 0,
    step() {
      hub.steps++
    },
    respawn(spawn: number) {
      hub.respawns.push(spawn)
    },
    free() {
      hub.frees++
    },
  }
  return hub
}

// The screen after frame k is script[min(k, last)]; the initial screen is script[0].
function fakeShow(script: string[]) {
  const show = {
    frames: [] as number[],
    samples: [] as number[],
    disposes: 0,
    index: 0,
    frame(dtS: number, sample: (roomSeat: number) => number) {
      show.frames.push(dtS)
      show.samples.push(sample(0))
      show.index = Math.min(show.frames.length, script.length - 1)
    },
    snapshot() {
      return { screen: script[show.index] }
    },
    dispose() {
      show.disposes++
    },
  }
  return show
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

function flowOf(hub: ReturnType<typeof fakeHub>, startShow: () => Promise<unknown>): EngineHubFlow {
  return new EngineHubFlow(hub as unknown as HubRuntime, startShow as () => Promise<EngineShowRuntime>)
}

test('pending preparation keeps loading, never reports show, steps nothing but the hub and refuses a second start', async () => {
  const hub = fakeHub()
  const never = new Promise<never>(() => {})
  const flow = flowOf(hub, () => never)
  const first = flow.start()
  for (let i = 0; i < 10; i++) flow.frame(1 / 60, IDLE)
  assert.equal(flow.state(), 'loading')
  assert.equal(flow.error(), null)
  assert.equal(hub.steps, 10)
  await assert.rejects(flow.start(), RefusalError)
  assert.equal(flow.state(), 'loading')
  void first
})

test('failed preparation reports the error, keeps stepping the hub and a retry goes back to loading', async () => {
  const hub = fakeHub()
  const failing = Promise.reject(new Error('no scripts'))
  let attempt = 0
  const flow = flowOf(hub, () => {
    attempt++
    return attempt === 1 ? failing : deferred<EngineShowRuntime>().promise
  })
  await flow.start()
  assert.equal(flow.state(), 'failed')
  assert.equal(flow.error(), 'no scripts')
  flow.frame(1 / 60, IDLE)
  assert.equal(hub.steps, 1)
  const retry = flow.start()
  assert.equal(flow.state(), 'loading')
  assert.equal(flow.error(), null)
  void retry
})

test('dispose during pending preparation disposes the late show once, never shows it and frees the hub once', async () => {
  const hub = fakeHub()
  const late = deferred<EngineShowRuntime>()
  const show = fakeShow(['playing'])
  const flow = flowOf(hub, () => late.promise)
  const started = flow.start()
  flow.dispose()
  late.resolve(show as unknown as EngineShowRuntime)
  await started
  assert.equal(show.disposes, 1)
  assert.notEqual(flow.state(), 'show')
  assert.equal(hub.frees, 1)
})

test('a completed show is framed with the input, returns once and respawns the hub at its spawn', async () => {
  const hub = fakeHub()
  const show = fakeShow(['playing', 'playing', 'done'])
  const flow = flowOf(hub, async () => show as unknown as EngineShowRuntime)
  await flow.start()
  assert.equal(flow.state(), 'show')
  flow.frame(1 / 60, WALK)
  assert.deepEqual(show.samples, [encodeInput(WALK)])
  assert.equal(hub.steps, 0)
  flow.frame(1 / 60, WALK)
  assert.equal(flow.state(), 'show')
  assert.equal(show.disposes, 0)
  flow.frame(1 / 60, WALK)
  assert.equal(flow.state(), 'returning')
  assert.equal(show.disposes, 1)
  assert.deepEqual(hub.respawns, [3])
  flow.frame(1 / 60, IDLE)
  assert.equal(flow.state(), 'hub')
  assert.equal(hub.steps, 0)
  flow.frame(1 / 60, IDLE)
  flow.frame(1 / 60, IDLE)
  assert.equal(hub.steps, 2)
  assert.equal(show.disposes, 1)
  assert.deepEqual(hub.respawns, [3])
})

test('a frame of 0.5 s steps the hub at most eight times', () => {
  const hub = fakeHub()
  const flow = flowOf(hub, () => new Promise(() => {}))
  flow.frame(0.5, IDLE)
  assert.equal(hub.steps, 8)
})

test('two frames of 1/120 s give exactly one hub step', () => {
  const hub = fakeHub()
  const flow = flowOf(hub, () => new Promise(() => {}))
  flow.frame(1 / 120, IDLE)
  assert.equal(hub.steps, 0)
  flow.frame(1 / 120, IDLE)
  assert.equal(hub.steps, 1)
})

test('dispose is idempotent and frees the hub once', () => {
  const hub = fakeHub()
  const flow = flowOf(hub, () => new Promise(() => {}))
  flow.dispose()
  flow.dispose()
  assert.equal(hub.frees, 1)
})

// A show runtime that refuses a vote from a seat off its roster, as the real runtime does.
function rosterShow(script: string[], seatOf: number[]) {
  const show = fakeShow(script) as ReturnType<typeof fakeShow> & { votes: number[]; vote(seat: number, c: number): void }
  show.votes = []
  show.vote = (seat: number) => {
    if (!seatOf.includes(seat)) throw new RefusalError('ege-show-runtime', 'vote.roomSeat', `room seat ${seat} is not on the active roster`)
    show.votes.push(seat)
  }
  const base = show.snapshot
  show.snapshot = () => ({ ...base(), seatOf }) as ReturnType<typeof base>
  return show
}

// The caller-side vote the page's host performs: only a seat on the roster casts a vote.
function castLocalVote(show: ReturnType<typeof rosterShow>): void {
  const roster = (show.snapshot() as unknown as { seatOf: number[] }).seatOf
  if (roster.includes(0)) show.vote(0, 0)
}

test('hub -> show -> vote for room seat 0 -> returned to hub -> show again -> vote', async () => {
  const hub = fakeHub()
  const shows = [rosterShow(['vote', 'done', 'done'], [0, 1, 2]), rosterShow(['vote', 'done', 'done'], [0, 1, 2])]
  let next = 0
  const flow = new EngineHubFlow(hub as unknown as HubRuntime, async () => shows[next++] as unknown as EngineShowRuntime)
  for (const show of shows) {
    await flow.start()
    assert.equal(flow.state(), 'show')
    castLocalVote(show)
    assert.deepEqual(show.votes, [0])
    flow.frame(1 / 60, IDLE)
    flow.frame(1 / 60, IDLE)
    assert.equal(flow.state(), 'returning')
    flow.frame(1 / 60, IDLE)
    assert.equal(flow.state(), 'hub')
  }
  // A seat that is off the roster casts no vote instead of reaching the runtime refusal.
  const eliminated = rosterShow(['vote'], [1, 2])
  castLocalVote(eliminated)
  assert.deepEqual(eliminated.votes, [])
  assert.throws(() => eliminated.vote(0, 0), /is not on the active roster/)
})
