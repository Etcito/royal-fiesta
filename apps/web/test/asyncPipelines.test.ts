import assert from 'node:assert/strict'
import test from 'node:test'
import { asyncPipelineFallbacks, installAsyncLitPipelines, pendingPipelines } from '../src/render/asyncPipelines.ts'

test('lit pipelines compile concurrently, omit pending draws and bind the resolved pipeline', async () => {
  const pending: { resolve(value: object): void; promise: Promise<object> }[] = []
  class Device {
    sync = 0
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { this.sync++; return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> {
      let resolve!: (value: object) => void
      const promise = new Promise<object>(done => { resolve = done })
      pending.push({ resolve, promise })
      return promise
    }
  }
  class Pass {
    pipeline: unknown
    draws = 0
    setPipeline(value: unknown): void { this.pipeline = value }
    drawIndexed(): void { this.draws++ }
  }
  installAsyncLitPipelines(Device.prototype, Pass.prototype)
  const device = new Device()
  const group = {}
  const layout = device.createPipelineLayout({ bindGroupLayouts: [group] })
  const a = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout }) as { getBindGroupLayout(index: number): object }
  const b = device.createRenderPipeline({ label: 'raa.lit.pipeline', layout })
  assert.equal(pending.length, 2, 'both compiles started before either completed')
  assert.equal(device.sync, 0)
  assert.equal(a.getBindGroupLayout(0), group)
  const pass = new Pass()
  pass.setPipeline(a)
  pass.drawIndexed()
  assert.equal(pass.draws, 0)
  const ready = {}
  pending[0].resolve(ready)
  pending[1].resolve({})
  await Promise.all(pending.map(entry => entry.promise))
  assert.equal(pendingPipelines(), 0)
  pass.setPipeline(a)
  pass.drawIndexed()
  assert.equal(pass.pipeline, ready)
  assert.equal(pass.draws, 1)
  pass.setPipeline(b)
  pass.drawIndexed()
  assert.equal(pass.draws, 2)
  device.createRenderPipeline({ label: 'one-shot pass', layout })
  assert.equal(device.sync, 1, 'unrelated pipelines retain native semantics')
})

test('validation errors surface and only internal backend errors use the sync fallback', async () => {
  let reason = 'validation'
  const error = { reason }
  const promises: Promise<object>[] = []
  class Device {
    sync = 0
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { this.sync++; return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> {
      const promise = Promise.reject<object>({ ...error, reason })
      promises.push(promise)
      return promise
    }
  }
  class Pass { setPipeline(_value: unknown): void {} }
  installAsyncLitPipelines(Device.prototype, Pass.prototype)
  const device = new Device()
  const desc = { label: 'raa.lit.pipeline', layout: device.createPipelineLayout({ bindGroupLayouts: [] }) }
  const failed = device.createRenderPipeline(desc)
  await Promise.allSettled(promises)
  assert.throws(() => new Pass().setPipeline(failed), (e: unknown) => (e as { reason: string }).reason === 'validation')
  assert.equal(device.sync, 0)
  reason = 'internal'
  const before = asyncPipelineFallbacks()
  const retried = device.createRenderPipeline(desc)
  await Promise.allSettled(promises)
  new Pass().setPipeline(retried)
  assert.equal(device.sync, 1)
  assert.equal(asyncPipelineFallbacks(), before + 1)
})
