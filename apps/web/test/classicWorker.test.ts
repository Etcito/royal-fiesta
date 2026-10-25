import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import { classicWorker, workerBootstrap } from '../src/sdf/classicWorker.ts'

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

// Run the bootstrap with real dynamic imports; only the browser message API is shimmed.
function boot(module: string): NodeWorker {
  return new NodeWorker(`
    const { parentPort, workerData } = require('node:worker_threads')
    globalThis.self = globalThis
    globalThis.postMessage = message => parentPort.postMessage(message)
    eval(workerData)
    self.onmessage({ data: 'first' })
    self.onmessage({ data: 'second' })
    parentPort.on('message', data => self.onmessage({ data }))
  `, { eval: true, workerData: workerBootstrap(module) })
}

test('classic bootstrap replays requests queued during import and receives later requests', async () => {
  const worker = boot(moduleUrl('self.onmessage = event => self.postMessage(event.data)'))
  try {
    const messages: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', message => {
        messages.push(message)
        if (messages.length === 2) worker.postMessage('third')
        if (messages.length === 3) resolve()
      })
    })
    assert.deepEqual(messages, ['first', 'second', 'third'])
  } finally {
    await worker.terminate()
  }
})

for (const [source, message] of [
  ['throw new Error("mesh import failed")', /mesh import failed/],
  ['export const noHandler = true', /did not install its message handler/],
] as const) {
  test(`classic bootstrap reports startup failure: ${message}`, async () => {
    const worker = boot(moduleUrl(source))
    try {
      const [error] = await once(worker, 'error')
      assert.match(error.message, message)
    } finally {
      await worker.terminate()
    }
  })
}

test('worker uses classic mode and releases blob URLs on completion, crash, close or constructor failure', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original)
    else Reflect.deleteProperty(globalThis, 'Worker')
  })
  const revoked: string[] = []
  let nextUrl = 0
  t.mock.method(URL, 'createObjectURL', () => `blob:test-${++nextUrl}`)
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  class FakeWorker {
    listeners = new Map<string, () => void>()
    stopped = false
    constructor(url: string, options?: WorkerOptions) {
      assert.equal(url, `blob:test-${nextUrl}`)
      assert.equal(options, undefined)
    }
    addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener) }
    terminate(): void { this.stopped = true }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
  for (const event of ['message', 'error', 'terminate']) {
    const worker = classicWorker('https://example.com/sub/assets/worker.js') as unknown as FakeWorker
    assert.equal(revoked.includes(`blob:test-${nextUrl}`), false)
    if (event === 'terminate') worker.terminate()
    else worker.listeners.get(event)!()
    assert.equal(revoked.at(-1), `blob:test-${nextUrl}`)
    worker.terminate()
    assert.equal(worker.stopped, true)
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class { constructor() { throw new Error('worker blocked') } },
  })
  assert.throws(() => classicWorker('https://example.com/worker.js'), /worker blocked/)
  assert.equal(revoked.at(-1), `blob:test-${nextUrl}`)
})
