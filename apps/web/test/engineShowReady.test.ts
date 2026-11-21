import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineShowReady } from '../src/engineShow/ready.ts'
import { engineShowTestMode } from '../src/engineShow/testMode.ts'

type State = 'loading' | 'ready' | 'error'
type Shown = Array<[State, string | undefined]>

function recorder(): { shown: Shown; show: (state: State, message?: string) => void } {
  const shown: Shown = []
  return { shown, show: (state, message) => { shown.push([state, message]) } }
}

// The gate reacts only to settled promises, so a few event-loop turns are enough to observe it; there is no fixed wait.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}

function actionable(cause: string): string {
  return `Engine show could not be prepared: ${cause}. Fix this cause, then reload the page.`
}

const CAUSE = 'the compiled script was not admitted'

test('a pending preparation reports loading at once, never ready, and holds the gated action', async () => {
  const { shown, show } = recorder()
  let calls = 0
  let release = (): void => undefined
  const pending = new Promise<void>(resolve => { release = () => { resolve() } })
  const gate = createEngineShowReady(() => { calls++; return pending }, show)
  assert.deepEqual(shown, [['loading', undefined]])
  let acted = false
  const gated = gate.ready.then(() => { acted = true })
  await settle()
  assert.equal(calls, 1)
  assert.equal(acted, false)
  assert.deepEqual(shown, [['loading', undefined]])
  release()
  await gated
  assert.equal(acted, true)
  assert.deepEqual(shown, [['loading', undefined], ['ready', undefined]])
})

test('a rejected preparation keeps an actionable error visible and rejects ready with the original error', async () => {
  const { shown, show } = recorder()
  const failure = new Error(CAUSE)
  const gate = createEngineShowReady(() => Promise.reject(failure), show)
  assert.deepEqual(shown, [['loading', undefined]])
  let acted = false
  const gated = gate.ready.then(() => { acted = true }, () => undefined)
  await assert.rejects(gate.ready, error => error === failure)
  await gated
  await settle()
  assert.equal(acted, false)
  assert.deepEqual(shown, [['loading', undefined], ['error', actionable(CAUSE)]])
})

test('a synchronous throw from the preparation takes the failed path', async () => {
  const { shown, show } = recorder()
  const failure = new TypeError(CAUSE)
  const gate = createEngineShowReady(() => { throw failure }, show)
  assert.deepEqual(shown, [['loading', undefined]])
  await assert.rejects(gate.ready, error => error === failure)
  assert.deepEqual(shown, [['loading', undefined], ['error', actionable(CAUSE)]])
  assert.equal(shown.some(([state]) => state === 'ready'), false)
})

test('a successful preparation reports ready once and releases the gated action', async () => {
  const { shown, show } = recorder()
  const gate = createEngineShowReady(() => Promise.resolve(), show)
  let acted = false
  const gated = gate.ready.then(() => { acted = true })
  await gated
  assert.equal(acted, true)
  assert.deepEqual(shown, [['loading', undefined], ['ready', undefined]])
})

test('rejections without an Error message still name their cause', async () => {
  const plain = recorder()
  const plainGate = createEngineShowReady(() => Promise.reject('module key mismatch'), plain.show)
  await assert.rejects(plainGate.ready, error => error === 'module key mismatch')
  assert.deepEqual(plain.shown, [['loading', undefined], ['error', actionable('module key mismatch')]])
  const empty = recorder()
  const emptyGate = createEngineShowReady(() => Promise.reject(new Error('')), empty.show)
  await assert.rejects(emptyGate.ready, error => error instanceof Error && error.message === '')
  assert.deepEqual(empty.shown, [['loading', undefined], ['error', actionable('no error message was given')]])
})

test('test mode carries presentation flags only, never gameplay settings', () => {
  const on = engineShowTestMode(true)
  assert.deepEqual(on, { enabled: true, skipDecorativeTransitions: true })
  assert.deepEqual(Object.keys(on).sort(), ['enabled', 'skipDecorativeTransitions'])
  assert.equal(Object.isFrozen(on), true)
  assert.throws(() => { (on as { enabled: boolean }).enabled = false }, TypeError)
  assert.equal(on.enabled, true)
  assert.deepEqual(engineShowTestMode(false), { enabled: false, skipDecorativeTransitions: false })
})

test('test mode refuses a flag that is not a boolean', () => {
  const text: unknown = 'false'
  assert.throws(() => engineShowTestMode(text as boolean), /\[engine-show\] testMode: must be a boolean/)
})
