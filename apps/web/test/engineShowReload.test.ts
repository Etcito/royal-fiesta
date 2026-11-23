import assert from 'node:assert/strict'
import test from 'node:test'
import type { Diagnostic } from '@etcito/game-engine-compile'
import type { EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import { RF_PUBLICATION_EVENT } from '../../../tools/egeScripts.ts'
import type { PublicationEvent, ScriptPublication } from '../../../tools/egeScripts.ts'
import { attachSavedScriptReload, hotPublicationSource, publicationOfEvent, SCRIPT_PUBLICATION_EVENT } from '../src/engineShowDev/reload.ts'
import type { SavedScriptSource, ScriptReloadStatus } from '../src/engineShowDev/reload.ts'
import type { EngineShowPage } from '../src/engineShow/page.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// The reload reacts only to settled promises; a few event-loop turns observe it without a fixed wait.
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

function runtime(moduleKey = 'base-module'): EngineShowRuntime {
  return {
    identity: { backend: 'engine', schemaKey: 7, moduleKey },
    mode: 'local',
  } as unknown as EngineShowRuntime
}

function page(): EngineShowPage {
  return {
    state: () => ({
      screen: 'playing', ready: true, error: null, backend: 'engine', seats: 60, humans: 1, bots: 59,
      round: 2, tick: 120, moduleKey: 'base-module', faults: 0, completedRounds: 0, desyncs: 0,
    }),
  } as unknown as EngineShowPage
}

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    file: 'show/clock.as.ts', line: 3, column: 5, endLine: 3, endColumn: 6,
    severity: 'error', code: 'TS2304', message: 'x', ...overrides,
  }
}

function publication(revision: number, overrides: Partial<ScriptPublication> = {}): ScriptPublication {
  return {
    revision, moduleKey: `m${revision}`, schemaKey: 7,
    wasmUrl: `/ege/rf-scripts.wasm?revision=${revision}`, diagnostics: [], ...overrides,
  }
}

function fakeSource(fetchBytes: (url: string) => Promise<BufferSource>) {
  let listener: ((publication: ScriptPublication) => void) | null = null
  let unsubscribes = 0
  const source: SavedScriptSource = {
    subscribe(next) { listener = next; return () => { unsubscribes++ } },
    fetchBytes,
  }
  return {
    source,
    publish(next: ScriptPublication) { listener?.(next) },
    unsubscribes: () => unsubscribes,
  }
}

function fakeApply(outcome?: (revision: number) => { applied: boolean; generation: number; error: string | null }) {
  const calls: number[] = []
  const apply = async (_runtime: EngineShowRuntime, next: ScriptPublication, _bytes: BufferSource) => {
    calls.push(next.revision)
    return outcome?.(next.revision) ?? { applied: true, generation: calls.length + 1, error: null }
  }
  return { apply, calls }
}

function recorder(): { list: ScriptReloadStatus[]; onStatus: (status: ScriptReloadStatus) => void } {
  const list: ScriptReloadStatus[] = []
  return { list, onStatus: status => { list.push(status) } }
}

test('one publication fetches and applies once with its applied identity', async () => {
  const seen = recorder()
  const { apply, calls } = fakeApply()
  const fetched: string[] = []
  const src = fakeSource(async url => { fetched.push(url); return new Uint8Array([1]) })
  attachSavedScriptReload(page(), runtime(), src.source, { apply, onStatus: seen.onStatus })
  assert.equal(seen.list.length, 1)
  assert.equal(seen.list[0].state, 'idle')
  assert.equal(seen.list[0].generation, 1)
  assert.equal(seen.list[0].moduleKey, 'base-module')
  src.publish(publication(5))
  await settle()
  assert.deepEqual(fetched, ['/ege/rf-scripts.wasm?revision=5'])
  assert.deepEqual(calls, [5])
  const last = seen.list.at(-1)!
  assert.equal(last.state, 'applied')
  assert.equal(last.applies, 1)
  assert.equal(last.generation, 2)
  assert.equal(last.appliedRevision, 5)
  assert.equal(last.revision, 5)
  assert.equal(last.moduleKey, 'm5')
  assert.equal(last.error, null)
})

test('coalescing fetches and applies only the first and the newest revision', async () => {
  const fetch1 = deferred<BufferSource>()
  const fetched: number[] = []
  const src = fakeSource(url => {
    const revision = Number(new URL(url, 'http://x').searchParams.get('revision'))
    fetched.push(revision)
    return revision === 1 ? fetch1.promise : Promise.resolve(new Uint8Array([revision]))
  })
  const { apply, calls } = fakeApply()
  attachSavedScriptReload(page(), runtime(), src.source, { apply })
  src.publish(publication(1))
  await settle(2)
  assert.deepEqual(fetched, [1])
  src.publish(publication(2))
  src.publish(publication(3))
  src.publish(publication(4))
  await settle(2)
  assert.deepEqual(fetched, [1])
  fetch1.resolve(new Uint8Array([1]))
  await settle()
  assert.deepEqual(fetched, [1, 4])
  assert.deepEqual(calls, [1, 4])
})

test('a stale fetch completion never applies its revision', async () => {
  const fetch1 = deferred<BufferSource>()
  const src = fakeSource(url => {
    const revision = Number(new URL(url, 'http://x').searchParams.get('revision'))
    return revision === 1 ? fetch1.promise : Promise.resolve(new Uint8Array([revision]))
  })
  const { apply, calls } = fakeApply()
  const seen = recorder()
  attachSavedScriptReload(page(), runtime(), src.source, { apply, onStatus: seen.onStatus })
  src.publish(publication(2))
  await settle()
  assert.deepEqual(calls, [2])
  src.publish(publication(1))
  await settle(2)
  assert.equal(seen.list.at(-1)?.state, 'loading')
  fetch1.resolve(new Uint8Array([1]))
  await settle()
  assert.deepEqual(calls, [2])
  assert.equal(seen.list.some(status => status.appliedRevision === 1), false)
  assert.equal(seen.list.at(-1)?.appliedRevision, 2)
  assert.equal(seen.list.at(-1)?.state, 'applied')
})

test('an error diagnostic rejects without fetching and keeps the applied module', async () => {
  const fetched: string[] = []
  const { apply } = fakeApply()
  const seen = recorder()
  const src = fakeSource(async url => { fetched.push(url); return new Uint8Array([1]) })
  attachSavedScriptReload(page(), runtime(), src.source, { apply, onStatus: seen.onStatus })
  src.publish(publication(2))
  await settle()
  src.publish(publication(3, { diagnostics: [diagnostic()] }))
  await settle(2)
  assert.deepEqual(fetched, ['/ege/rf-scripts.wasm?revision=2'])
  const last = seen.list.at(-1)!
  assert.equal(last.state, 'rejected')
  assert.deepEqual(last.diagnostics, ['scripts/ege/show/clock.as.ts:3:5 TS2304 x'])
  assert.equal(last.moduleKey, 'm2')
  assert.equal(last.generation, 2)
  assert.equal(last.appliedRevision, 2)
})

test('disposal while a fetch is pending never applies, unsubscribes once and ends disposed', async () => {
  const fetch1 = deferred<BufferSource>()
  const { apply, calls } = fakeApply()
  const seen = recorder()
  const src = fakeSource(() => fetch1.promise)
  const dispose = attachSavedScriptReload(page(), runtime(), src.source, { apply, onStatus: seen.onStatus })
  src.publish(publication(1))
  await settle(2)
  assert.equal(seen.list.at(-1)?.state, 'loading')
  assert.equal(seen.list.some(status => status.state === 'applied'), false)
  dispose()
  dispose()
  assert.equal(src.unsubscribes(), 1)
  assert.equal(seen.list.at(-1)?.state, 'disposed')
  fetch1.resolve(new Uint8Array([1]))
  await settle()
  assert.deepEqual(calls, [])
  assert.equal(seen.list.at(-1)?.state, 'disposed')
})

test('readiness stays loading while an apply is still pending', async () => {
  const applying = deferred<{ applied: boolean; generation: number; error: string | null }>()
  const seen = recorder()
  const src = fakeSource(async () => new Uint8Array([1]))
  attachSavedScriptReload(page(), runtime(), src.source, { apply: () => applying.promise, onStatus: seen.onStatus })
  src.publish(publication(2))
  await settle(2)
  assert.equal(seen.list.at(-1)?.state, 'loading')
  assert.equal(seen.list.some(status => status.state === 'applied'), false)
  applying.resolve({ applied: true, generation: 2, error: null })
  await settle()
  assert.equal(seen.list.at(-1)?.state, 'applied')
})

test('a refused apply rejects with its error and never reports applied', async () => {
  const { apply } = fakeApply(() => ({ applied: false, generation: 1, error: 'x' }))
  const seen = recorder()
  const src = fakeSource(async () => new Uint8Array([1]))
  attachSavedScriptReload(page(), runtime(), src.source, { apply, onStatus: seen.onStatus })
  src.publish(publication(2))
  await settle()
  const last = seen.list.at(-1)!
  assert.equal(last.state, 'rejected')
  assert.equal(last.error, 'x')
  assert.equal(last.generation, 1)
  assert.equal(seen.list.some(status => status.state === 'applied'), false)
})

test('a fetch failure rejects with the revision and url in its message', async () => {
  const seen = recorder()
  const src = fakeSource(async () => { throw new Error('boom') })
  attachSavedScriptReload(page(), runtime(), src.source, { apply: fakeApply().apply, onStatus: seen.onStatus })
  src.publish(publication(6))
  await settle()
  const last = seen.list.at(-1)!
  assert.equal(last.state, 'rejected')
  assert.equal(last.error, 'ege-dev-swap: revision 6 bytes could not be fetched from /ege/rf-scripts.wasm?revision=6: boom')
  assert.equal(seen.list.some(status => status.state === 'applied'), false)
})

test('publicationOfEvent keeps a success publication and fills a null failure', () => {
  const success = publication(3)
  const successEvent: PublicationEvent = { revision: 3, status: 'success', publication: success, diagnostics: [] }
  assert.equal(publicationOfEvent(successEvent), success)
  const failureEvent: PublicationEvent = {
    revision: 4, status: 'failure', publication: null,
    diagnostics: [diagnostic({ message: 'broken' })],
  }
  assert.deepEqual(publicationOfEvent(failureEvent), {
    moduleKey: '', schemaKey: 0, wasmUrl: '', revision: 4, diagnostics: failureEvent.diagnostics,
  })
})

test('hotPublicationSource registers and removes its listener and refuses a non-ok fetch', async () => {
  const events: string[] = []
  let registered: (data: PublicationEvent) => void = () => undefined
  const hot = {
    on(event: string, listener: (data: PublicationEvent) => void) { events.push(event); registered = listener },
    off(event: string) { events.push(`off:${event}`) },
  }
  const source = hotPublicationSource(hot, 'http://localhost:5173/')
  const received: ScriptPublication[] = []
  const unsubscribe = source.subscribe(next => received.push(next))
  assert.equal(SCRIPT_PUBLICATION_EVENT, RF_PUBLICATION_EVENT)
  assert.deepEqual(events, [SCRIPT_PUBLICATION_EVENT])
  const event: PublicationEvent = { revision: 2, status: 'success', publication: publication(2), diagnostics: [] }
  registered(event)
  assert.deepEqual(received, [publication(2)])
  unsubscribe()
  assert.deepEqual(events, [SCRIPT_PUBLICATION_EVENT, `off:${SCRIPT_PUBLICATION_EVENT}`])
  const original = globalThis.fetch
  const call: { href?: string; cache?: RequestCache } = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    call.href = String(input)
    call.cache = init?.cache
    return { ok: false, status: 503, statusText: 'Service Unavailable' } as Response
  }) as typeof fetch
  try {
    await assert.rejects(source.fetchBytes('/ege/rf-scripts.wasm?revision=2'))
  } finally {
    globalThis.fetch = original
  }
  assert.equal(call.href, 'http://localhost:5173/ege/rf-scripts.wasm?revision=2')
  assert.equal(call.cache, 'no-cache')
})
