import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Diagnostic } from '@etcito/game-engine-compile'
import { rfEgeScripts } from '../../apps/web/src/engineRound/scriptsPlugin.ts'
import {
  RF_PUBLICATION_EVENT,
  createRfPublicationManager,
  readRfPublication,
  type PublicationEvent,
  type RfCompileResult,
  type RfPublicationManager,
} from '../egeScripts.ts'

const error: Diagnostic = { file: 'x.as.ts', line: 2, column: 3, endLine: 2, endColumn: 4, severity: 'error', code: 'EGE1001', message: 'bad' }
const warning: Diagnostic = { ...error, severity: 'warning', code: 'W1', message: 'careful' }

const ok = (bytes: number[], cacheKey: string, extra: Partial<RfCompileResult> = {}): RfCompileResult =>
  ({ wasm: Uint8Array.from(bytes), diagnostics: [warning], files: ['a.as.ts'], cacheKey, fromCache: false, schemaKey: 7, ...extra })
const bad = (): RfCompileResult => ({ wasm: null, diagnostics: [error], files: ['a.as.ts'], cacheKey: '', fromCache: false, schemaKey: null })

/** A compile whose results are handed out by the test, one per call, in call order. */
function scripted() {
  const calls: Array<(result: RfCompileResult | Error) => void> = []
  const compile = () => new Promise<RfCompileResult>((resolve, reject) => {
    calls.push(value => (value instanceof Error ? reject(value) : resolve(value)))
  })
  return { compile, calls }
}

function collect(manager: RfPublicationManager): PublicationEvent[] {
  const events: PublicationEvent[] = []
  manager.onPublication(event => events.push(event))
  return events
}

const settle = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)) }

test('fixed event name is rf:script-publication', () => {
  assert.equal(RF_PUBLICATION_EVENT, 'rf:script-publication')
})

test('success publishes the exact identity, revision, URL and bytes', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const events = collect(manager)
  const pending = manager.request()
  calls[0](ok([1, 2, 3], 'k1'))
  const event = await pending
  assert.equal(event?.revision, 1)
  assert.equal(event?.status, 'success')
  const publication = event?.publication
  assert.ok(publication)
  assert.equal(publication.revision, 1)
  assert.equal(publication.schemaKey, 7)
  assert.equal(typeof publication.moduleKey, 'string')
  assert.ok(publication.moduleKey.length > 0)
  assert.equal(publication.wasmUrl, '/ege/rf-scripts.wasm?revision=1')
  assert.deepEqual(publication.diagnostics, [warning])
  assert.deepEqual(event?.diagnostics, [warning])
  assert.deepEqual([...manager.wasmFor(1) ?? []], [1, 2, 3])
  assert.deepEqual(events, [event])
  assert.deepEqual(await manager.read(), publication)
  assert.deepEqual(await readRfPublication(manager), publication)
})

test('unchanged cached results retain identity and distinct edits get a new one; old URLs keep their bytes', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const run = async (result: RfCompileResult) => {
    const pending = manager.request()
    calls[calls.length - 1](result)
    return (await pending)!.publication!
  }
  const first = await run(ok([1], 'A'))
  const same = await run(ok([1], 'A', { fromCache: true }))
  const edited = await run(ok([2], 'B'))
  const back = await run(ok([1], 'A', { fromCache: true }))
  assert.equal(same.moduleKey, first.moduleKey)
  assert.notEqual(same.revision, first.revision)
  assert.notEqual(edited.moduleKey, first.moduleKey)
  assert.equal(back.moduleKey, first.moduleKey)
  assert.deepEqual([first.revision, same.revision, edited.revision, back.revision], [1, 2, 3, 4])
  assert.deepEqual([...manager.wasmFor(3) ?? []], [2])
  assert.deepEqual([...manager.wasmFor(1) ?? []], [1])
  assert.deepEqual([...manager.wasmFor(4) ?? []], [1])
  assert.equal(manager.wasmFor(99), null)
})

test('failed-first request publishes null and readRfPublication rejects with the diagnostics', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const events = collect(manager)
  const pending = manager.request()
  calls[0](bad())
  const event = await pending
  assert.deepEqual(event, { revision: 1, status: 'failure', publication: null, diagnostics: [error] })
  assert.deepEqual(events, [event])
  await assert.rejects(readRfPublication(manager), /no runnable script publication.*scripts\/ege\/x\.as\.ts:2:3 EGE1001 bad/s)
})

test('a thrown compile is a failure with a diagnostic, not a rejection', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const pending = manager.request()
  calls[0](new Error('boom'))
  const event = await pending
  assert.equal(event?.status, 'failure')
  assert.equal(event?.publication, null)
  assert.match(event?.diagnostics[0].message ?? '', /boom/)
})

test('failed-after-success retains the prior publication and exposes the failed diagnostics', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const first = manager.request()
  calls[0](ok([5, 6], 'A'))
  const success = (await first)!.publication!
  const second = manager.request()
  calls[1](bad())
  const event = (await second)!
  assert.equal(event.revision, 2)
  assert.equal(event.status, 'failure')
  assert.deepEqual(event.publication, success)
  assert.equal(event.publication?.revision, 1)
  assert.deepEqual(event.diagnostics, [error])
  assert.deepEqual([...manager.wasmFor(1) ?? []], [5, 6])
  const read = await manager.read()
  assert.equal(read.revision, 1)
  assert.equal(read.moduleKey, success.moduleKey)
  assert.equal(read.wasmUrl, success.wasmUrl)
  assert.deepEqual(read.diagnostics, [error])
  // a later success republishes under a newer revision with fresh diagnostics
  const third = manager.request()
  calls[2](ok([5, 6], 'A', { fromCache: true }))
  const again = (await third)!
  assert.equal(again.publication?.revision, 3)
  assert.equal(again.publication?.moduleKey, success.moduleKey)
})

test('reversed asynchronous completion: the latest request wins and the older emits nothing', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const events = collect(manager)
  const older = manager.request()
  const newer = manager.request()
  assert.equal(manager.revision, 2)
  calls[1](ok([2], 'NEW'))
  const newest = (await newer)!
  assert.equal(newest.revision, 2)
  calls[0](ok([1], 'OLD'))
  assert.equal(await older, null)
  assert.deepEqual(events, [newest])
  const read = await manager.read()
  assert.equal(read.revision, 2)
  assert.deepEqual([...manager.wasmFor(2) ?? []], [2])
  assert.equal(manager.wasmFor(1), null)
})

test('reversed completion with a late older failure does not override a newer success', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const events = collect(manager)
  const older = manager.request()
  const newer = manager.request()
  calls[1](ok([2], 'NEW'))
  await newer
  calls[0](bad())
  assert.equal(await older, null)
  assert.equal(events.length, 1)
  assert.equal((await manager.read()).revision, 2)
})

test('a pending latest request emits nothing and read waits for it', async () => {
  const { compile, calls } = scripted()
  const manager = createRfPublicationManager({ compile })
  const events = collect(manager)
  const first = manager.request()
  const second = manager.request()
  calls[0](ok([1], 'A'))
  await first
  await settle()
  assert.deepEqual(events, [])
  let readSettled = false
  const read = manager.read().then(value => { readSettled = true; return value })
  await settle()
  assert.equal(readSettled, false)
  calls[1](ok([2], 'B'))
  await second
  assert.equal((await read).revision, 2)
})

test('absent publication rejects with an actionable error', async () => {
  const manager = createRfPublicationManager({ compile: scripted().compile })
  await assert.rejects(manager.read(), /no runnable script publication exists; request a build/)
})

test('persisted manager resumes above its latest revision and keeps identity beside the bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-publication-'))
  try {
    const one = scripted()
    const first = createRfPublicationManager({ compile: one.compile, dir })
    const pending = first.request()
    one.calls[0](ok([9, 8, 7], 'A'))
    const success = (await pending)!.publication!
    const failing = first.request()
    one.calls[1](bad())
    await failing
    assert.deepEqual([...readFileSync(join(dir, 'rf-scripts.wasm'))], [9, 8, 7])

    const two = scripted()
    const resumed = createRfPublicationManager({ compile: two.compile, dir })
    assert.equal(resumed.revision, 2)
    const read = await readRfPublication(resumed)
    assert.equal(read.revision, 1)
    assert.equal(read.moduleKey, success.moduleKey)
    assert.deepEqual(read.diagnostics, [error])
    assert.deepEqual([...resumed.wasmFor(1) ?? []], [9, 8, 7])
    const next = resumed.request()
    two.calls[0](ok([9, 8, 7], 'A', { fromCache: true }))
    const event = (await next)!
    assert.equal(event.revision, 3)
    assert.equal(event.publication?.moduleKey, success.moduleKey)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a persisted failed-first record resumes without a runnable publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-publication-'))
  try {
    const one = scripted()
    const first = createRfPublicationManager({ compile: one.compile, dir })
    const pending = first.request()
    one.calls[0](bad())
    await pending
    const resumed = createRfPublicationManager({ compile: scripted().compile, dir })
    assert.equal(resumed.revision, 1)
    await assert.rejects(resumed.read(), /no runnable script publication/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface FakeResponse {
  statusCode: number
  body: Buffer | null
  headers: Record<string, string>
}

type Middleware = (
  request: { url?: string },
  response: { statusCode: number; setHeader(name: string, value: string): void; end(data?: string | Buffer): void },
  next: () => void,
) => unknown

interface FakeServer {
  middlewares: { use(handler: Middleware): void }
  watcher: { add(paths: string[]): void; on(event: string, listener: (event: string, file: string) => void): void }
  ws: { send(payload: unknown): void }
}

function harness() {
  let middleware: Middleware | null = null
  let listener: ((event: string, file: string) => void) | null = null
  const sent: Array<{ type: string; event: string; data: PublicationEvent }> = []
  const watched: string[][] = []
  const server: FakeServer = {
    middlewares: { use: handler => { middleware = handler } },
    watcher: {
      add: paths => { watched.push(paths) },
      on: (_event, next) => { listener = next },
    },
    ws: { send: payload => { sent.push(payload as typeof sent[number]) } },
  }
  return {
    server,
    sent,
    watched,
    emit: (file: string): void => {
      assert.ok(listener)
      listener('change', file)
    },
    request: async (url: string): Promise<FakeResponse> => {
      assert.ok(middleware)
      const result: FakeResponse = { statusCode: 200, body: null, headers: {} }
      const response = {
        statusCode: 200,
        setHeader(name: string, value: string): void { result.headers[name.toLowerCase()] = value },
        end(data?: string | Buffer): void {
          result.statusCode = this.statusCode
          if (data !== undefined) result.body = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
        },
      }
      await middleware({ url }, response, () => { result.statusCode = 404 })
      return result
    },
  }
}

function configure(plugin: ReturnType<typeof rfEgeScripts>, server: FakeServer): void {
  (plugin.configureServer as unknown as (server: FakeServer) => void)(server)
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await settle()
  assert.ok(check())
}

test('the dev plugin emits the exact custom event and serves the accepted publication beside the wasm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-plugin-'))
  try {
    const { compile, calls } = scripted()
    const fake = harness()
    configure(rfEgeScripts({ root: dir, dir, compile }), fake.server)
    await until(() => calls.length === 1)
    calls[0](ok([1, 2, 3], 'A'))
    await until(() => fake.sent.length === 1)
    const event = fake.sent[0].data
    assert.equal(event.revision, 1)
    assert.equal(event.status, 'success')
    assert.deepEqual(fake.sent[0], { type: 'custom', event: 'rf:script-publication', data: event })
    assert.deepEqual(fake.watched, [[join(dir, 'ege.schema.json'), join(dir, 'scripts', 'ege')]])
    const current = await fake.request('/ege/rf-scripts.wasm')
    assert.equal(current.statusCode, 200)
    assert.equal(current.headers['content-type'], 'application/wasm')
    assert.deepEqual([...(current.body ?? [])], [1, 2, 3])
    assert.deepEqual([...((await fake.request('/ege/rf-scripts.wasm?revision=1')).body ?? [])], [1, 2, 3])
    assert.equal((await fake.request('/ege/rf-scripts.wasm?revision=9')).statusCode, 404)
    const metadata = await fake.request('/ege/rf-publication.json')
    assert.equal(metadata.statusCode, 200)
    assert.deepEqual(JSON.parse(metadata.body?.toString() ?? ''), event.publication)
    assert.deepEqual([...readFileSync(join(dir, 'rf-scripts.wasm'))], [1, 2, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed saved edit publishes diagnostics and keeps the runnable bytes and revision URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-plugin-'))
  try {
    const { compile, calls } = scripted()
    const fake = harness()
    configure(rfEgeScripts({ root: dir, dir, compile }), fake.server)
    await until(() => calls.length === 1)
    calls[0](ok([5, 6], 'A'))
    await until(() => fake.sent.length === 1)
    fake.emit(join(dir, 'scripts', 'ege', 'a.as.ts'))
    await until(() => calls.length === 2)
    calls[1](bad())
    await until(() => fake.sent.length === 2)
    const failure = fake.sent[1].data
    assert.equal(failure.status, 'failure')
    assert.equal(failure.revision, 2)
    assert.equal(failure.publication?.revision, 1)
    assert.deepEqual(failure.diagnostics, [error])
    assert.deepEqual([...((await fake.request('/ege/rf-scripts.wasm')).body ?? [])], [5, 6])
    assert.deepEqual([...((await fake.request('/ege/rf-scripts.wasm?revision=1')).body ?? [])], [5, 6])
    const metadata = JSON.parse((await fake.request('/ege/rf-publication.json')).body?.toString() ?? '')
    assert.equal(metadata.revision, 1)
    assert.deepEqual(metadata.diagnostics, [error])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saved script and schema changes coalesce into one in-flight compile and one follow-up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-plugin-'))
  try {
    const { compile, calls } = scripted()
    const fake = harness()
    configure(rfEgeScripts({ root: dir, dir, compile, initial: false }), fake.server)
    const script = join(dir, 'scripts', 'ege', 'a.as.ts')
    fake.emit(script)
    fake.emit(script)
    fake.emit(join(dir, 'ege.schema.json'))
    await until(() => calls.length === 1)
    await settle()
    assert.equal(calls.length, 1)
    calls[0](ok([1], 'A'))
    await until(() => calls.length === 2)
    await settle()
    assert.equal(calls.length, 2)
    calls[1](ok([2], 'B'))
    await until(() => fake.sent.length === 2)
    assert.deepEqual(fake.sent.map(entry => entry.data.revision), [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watcher changes outside the schema and saved scripts never compile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-plugin-'))
  try {
    const { compile, calls } = scripted()
    const fake = harness()
    configure(rfEgeScripts({ root: dir, dir, compile, initial: false }), fake.server)
    fake.emit(join(dir, 'README.md'))
    fake.emit(join(dir, 'scripts', 'ege', 'notes.txt'))
    await settle()
    await settle()
    assert.equal(calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
